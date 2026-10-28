/**
 * 客户端运行时桥 —— 插件 `apply()` 里绑定 ctx，界面里按需取宿主服务。
 *
 * 为什么需要这个文件：
 *   1. **投递 AI 审核 prompt**：宿主只渲染 prompt（`/pr/ai-review` 返回 `prompt` 全文），
 *      投递必须由客户端用会话服务发出，这样「消息是谁发的」与会话作用域不会错位
 *      （见 `docs/design/0.5.4-api.md` 的 AI 审核一节）。
 *   2. **没有 props 的场景**：侧边栏整页（`main` 槽位）不保证带当前会话 id。
 *      0.5.4 起 PR 路由本身不再要求 `sessionId`（数据走 host 直连），这个 id 只用来
 *      决定「AI 审核默认投递到哪个会话」；记不住就退化成投递到会话清单第一个。
 *
 * ⚠️ 全部访问都在事件/effect 里发生（SSR 渲染期不碰 window/localStorage）。
 *
 * @module dsh-gitee-chat/client/runtime
 */

/** localStorage 里记「最近一次确认过是 Gitee 模式的会话」的键（仅作投递默认值）。 */
const SESSION_KEY = 'dsh-gitee-chat:last-gitee-session'

/** 插件 apply() 时注入的 ctx（未挂载时为 null）。 */
let runtimeCtx: unknown = null

/** 已经声明过依赖的 ctx（`ctx.inject` 回调里拿到的 scope）。 */
let injectedCtx: unknown = null

/** 插件 apply() 里调用一次。 */
export function bindRuntime(ctx: unknown): void {
  runtimeCtx = ctx
  // ⚠️ cordis 的客户端 ctx 直接 `ctx.get('sessions')` 会抛
  //   `cannot get property "sessions" without inject`
  // 必须先 inject 声明依赖，拿到的 scope 才能安全取服务。
  // 这里只注入投递要用到的两个；失败（老版本宿主没有 inject）就留空，
  // 后面每个候选都自己 try/catch，不会把异常带到界面上。
  try {
    const inject = (ctx as { inject?: unknown }).inject
    if (typeof inject === 'function') {
      ;(inject as (names: string[], cb: (scope: unknown) => void) => unknown).call(
        ctx,
        ['sessions', 'conversation'],
        (scope) => {
          injectedCtx = scope
        },
      )
    }
  } catch {
    injectedCtx = null
  }
}

/** 取宿主 ctx（可能为 null：SSR / 单测）。 */
export function getRuntime(): unknown {
  return runtimeCtx
}

/** 安全取服务：任何 `without inject` 的抛错都吞成 null（界面上只给一句人话）。 */
function safeService(name: string): unknown {
  for (const holder of [injectedCtx, runtimeCtx]) {
    if (holder === null || holder === undefined) continue
    const getter = (holder as { get?: unknown }).get
    if (typeof getter === 'function') {
      try {
        const got = (getter as (n: string) => unknown).call(holder, name)
        if (got !== null && got !== undefined) return got
      } catch {
        // 未声明 inject 时 cordis 会抛；换下一个候选继续试
      }
    }
    const loose = (holder as Record<string, unknown>)[name]
    if (loose !== null && loose !== undefined) return loose
  }
  return null
}

/** 记住「这个会话确认过是 Gitee 模式」。 */
export function rememberSession(sessionId: string): void {
  if (sessionId === '') return
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SESSION_KEY, sessionId)
  } catch {
    // 隐私模式 / 存储被禁用：忽略，功能降级为「本页刷新后要重新点进会话」
  }
}

/** 取上次记住的 Gitee 会话 id（没有就返回空串）。 */
export function rememberedSession(): string {
  try {
    if (typeof localStorage === 'undefined') return ''
    return localStorage.getItem(SESSION_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * 解析「这次界面该用哪个会话」：显式 props 优先，其次上次确认过 Gitee 模式的会话。
 * @param explicit - 槽位给的 sessionId（可能为 undefined / 空串）。
 */
export function resolveSessionId(explicit?: unknown): string {
  if (typeof explicit === 'string' && explicit !== '') {
    rememberSession(explicit)
    return explicit
  }
  return rememberedSession()
}

/** 投递结果：成功，或「没能自动发」+ 给使用者看的原因（此时界面应把 prompt 交给人）。 */
export type SendResult = { ok: true; via: string } | { ok: false; hint: string }

/** `sessions` 服务的最小形状（只声明我们用到的三个方法）。 */
interface SessionsFace {
  binding?: (id: string) => { session?: unknown } | undefined
  retain?: (id: string, options: { source: string }) => { ready?: Promise<unknown>; release?: () => void }
}

/** 会话 face 上真正发消息的方法（`ISession.prompt`）。 */
interface SessionFaceLike {
  prompt?: (content: Array<{ type: 'text'; text: string }>, mode: 'queue' | 'steer') => Promise<
    { ok: true } | { ok: false; error?: { code?: string; message?: string } }
  >
}

/**
 * 把 prompt 投给**指定会话**。
 *
 * 走过的弯路（0.5.4 实测）：在插件 apply 的 root ctx 上直接
 * `ctx.get('conversation').send(...)` 是错的 ——
 *   1. root ctx 没有 inject 声明，取服务直接抛 `cannot get property "conversation" without inject`；
 *   2. 就算拿到，`conversation.send` 发的是**调用者作用域**的会话，而面板里要投的是
 *      另一个会话（用户可选）。
 * 正确姿势是拿 `sessions` 服务按 id 解出会话 face，再调 `session.prompt([...], 'queue')`；
 * 会话当前没被 retain 时先 retain 一次（`source: 'mainView'`），发完立刻 release。
 *
 * @param sessionId - 目标会话。
 * @param prompt - 完整 prompt 文本。
 */
export async function sendPrompt(sessionId: string, prompt: string): Promise<SendResult> {
  if (runtimeCtx === null) return { ok: false, hint: '插件运行时尚未挂载（页面刚加载？），请稍后重试。' }
  if (sessionId === '') return { ok: false, hint: '还没有可投递的会话：请在弹窗里先选一个工作区、再选会话。' }

  const sessions = safeService('sessions') as SessionsFace | null
  if (sessions !== null) {
    let release: (() => void) | undefined
    try {
      let binding = sessions.binding?.(sessionId)
      if (binding === undefined && typeof sessions.retain === 'function') {
        const reference = sessions.retain(sessionId, { source: 'mainView' })
        release = () => reference.release?.()
        await reference.ready
        binding = sessions.binding?.(sessionId)
      }
      const session = binding?.session as SessionFaceLike | undefined
      if (session !== undefined && typeof session.prompt === 'function') {
        const result = await session.prompt([{ type: 'text', text: prompt }], 'queue')
        if (result.ok) return { ok: true, via: 'session.prompt' }
        const code = result.error?.code ?? ''
        const message = result.error?.message ?? ''
        return {
          ok: false,
          hint: `会话拒绝接收这条 prompt：${code === '' ? '' : `${code} `}${message === '' ? '（无详细信息）' : message}`,
        }
      }
      return { ok: false, hint: '没取到这个会话的发送接口：它可能刚被关闭，换个会话或重开页面再试。' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, hint: `投递到会话时出错：${message}` }
    } finally {
      release?.()
    }
  }

  // 退化：写进输入框，由使用者自己回车（做不到自动发送也不假装成功）。
  return { ok: false, hint: '当前 DSH 版本没有可用的会话投递接口：请复制下面的 prompt，粘到会话里发送。' }
}
