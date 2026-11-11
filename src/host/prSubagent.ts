/**
 * 把「AI 审核」交给所选主会话下的**子智能体**执行。
 *
 * 用户口径（2026-10-26）：投递不要往主会话里塞一条用户消息 —— 审核是后台活，
 * 应该挂在所选主会话下起一个子智能体去跑（工具、模型、工作区都跟随那个主会话），
 * 跑完把结论交回面板，人再决定通过/驳回。
 *
 * 用的就是 DSH 自己的子智能体服务（`ctx.get('subagents')`，0.2.1 起有）：
 *   `startActivation({provider, label, request, signal, delivery})`
 * `request.parent` 必须是**活着的** Agent 实例。会话空闲时 `agents.get(id)` 是 undefined，
 * 此时走宿主 `sessionController.resolveAgent(sessionId)`（"Resolve or resume one ordinary
 * Session for another Host API domain"）把它**恢复**成活着的 Agent 再用 —— 这样「投递到别的
 * 工作区的会话」不用先在那个会话里发一条消息唤醒（0.2.2 宿主上实测旧的 session-not-live 太硬）。
 *
 * 拉起成功后会把 `childId` 登记到 `host/reviewSessions.ts`：子智能体继承的是主会话的
 * **完整工具集**，而宿主没有给 activation 传工具白名单的口子 —— 所以"只读"由插件侧的
 * 全局 guard 硬拦，见那个模块里 `reviewOnlyDenial()` 的说明。
 */

import { markReviewSession } from './reviewSessions.ts'

/** 子智能体服务的最小形状（宿主内部类型没有导出，这里按用到的成员声明）。 */
interface SubagentsLike {
  readonly startActivation?: (spec: {
    provider: string
    label: string
    request: { parent: unknown; prompt: Array<{ type: string; text: string }> }
    signal: AbortSignal
    delivery: 'parent' | 'caller'
  }) => Promise<{
    childId: string
    result: Promise<{ output?: unknown; structured?: unknown; stopReason?: string; diagnostic?: string }>
    dispose?: () => Promise<void>
  }>
}

/** Agent 注册表的最小形状。 */
interface AgentsLike {
  readonly get?: (sessionId: string) => unknown
}

export interface PrSubagentRun {
  runId: string
  childId: string
  status: 'running' | 'done' | 'failed'
  /** 子智能体最终回答（Markdown，直接当评论正文用）。 */
  text: string
  stopReason: string
  error: string
  createdAt: number
  finishedAt: number | null
}

export class PrSubagentError extends Error {
  constructor(
    readonly code: 'no-subagents' | 'session-not-live' | 'session-not-found' | 'start-failed' | 'run-not-found',
    message: string,
    readonly hint: string,
  ) {
    super(message)
    this.name = 'PrSubagentError'
  }
}

const RUN_TTL_MS = 30 * 60_000
const DEFAULT_TIMEOUT_MS = 8 * 60_000

/** 把子智能体的输出块拼成一段文本。 */
function flattenOutput(output: unknown): string {
  if (!Array.isArray(output)) return ''
  const parts: string[] = []
  for (const block of output) {
    if (typeof block === 'string') { parts.push(block); continue }
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (typeof record.text === 'string') { parts.push(record.text); continue }
    if (typeof record.content === 'string') parts.push(record.content)
  }
  return parts.join('\n').trim()
}

export function createPrSubagentRunner(deps: {
  readonly subagents: () => SubagentsLike | undefined
  readonly agents: () => AgentsLike | undefined
  /**
   * 会话没在跑时，让宿主把它「解析或恢复」成一个活 Agent
   * （宿主 `sessionController.resolveAgent(sessionId)`：返回 Agent，或 `{ error }`）。
   * 缺省或直接抛错时维持原来的 session-not-live 行为。
   */
  readonly resolveAgent?: (sessionId: string) => Promise<unknown>
  readonly logger?: { warn?: (message: string) => void }
}) {
  const runs = new Map<string, { run: PrSubagentRun; controller: AbortController }>()

  const prune = (now: number): void => {
    for (const [key, entry] of runs) {
      if (entry.run.finishedAt !== null && now - entry.run.finishedAt > RUN_TTL_MS) runs.delete(key)
    }
  }

  /** 取（必要时恢复）用一个活着的父 Agent；两路都拿不到就报 session-not-live。 */
  const resolveParent = async (sessionId: string): Promise<unknown> => {
    const live = deps.agents()?.get?.(sessionId)
    if (live !== undefined && live !== null) return live

    if (deps.resolveAgent !== undefined) {
      let resumed: unknown
      try {
        resumed = await deps.resolveAgent(sessionId)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        throw new PrSubagentError('session-not-live', `所选会话恢复失败：${message}`, '换「当前会话」再试；如果那个会话已被归档或删掉，先在会话列表里打开它一次。')
      }
      if (resumed !== null && typeof resumed === 'object' && 'error' in resumed) {
        const error = (resumed as { error?: { message?: string; code?: string } }).error
        const detail = error?.message ?? '未知原因'
        throw new PrSubagentError(
          error?.code === 'session/not-found' ? 'session-not-found' : 'session-not-live',
          error?.code === 'session/not-found' ? `找不到这个会话：${detail}` : `所选会话恢复失败：${detail}`,
          error?.code === 'session/not-found' ? '会话可能已被删除或归档；刷新会话列表后重新选一个。' : '换「当前会话」再试，或先在那边打开一次会话。',
        )
      }
      const agent = (resumed as { agent?: unknown } | undefined)?.agent ?? resumed
      if (agent !== undefined && agent !== null) {
        deps.logger?.warn?.(`[gitee-chat] 会话 ${sessionId} 原本空闲，已由宿主恢复成活 Agent 后挂载子智能体`)
        return agent
      }
    }

    throw new PrSubagentError(
      'session-not-live',
      '所选会话当前没有在跑的智能体。',
      '子智能体必须挂在活着的会话下：选「当前会话」，或先在那个会话里发一条消息把它唤醒，再回来发起。',
    )
  }

  const start = async (input: {
    sessionId: string
    prompt: string
    label: string
    timeoutMs?: number
    /**
     * `caller`（默认）= 纯后台：结果只回到本插件，会话里不留痕。
     * `parent` = 结论同时落进所选主会话（DSH 会往那个会话追加一条
     * `subagent-settled` 结算消息，人看得见），结果照样回插件，用来回填表单。
     * 用户口径（2026-10-27）：「取消勾选就投递到主会话」，**且照样要能回填**。
     */
    delivery?: 'caller' | 'parent'
  }): Promise<PrSubagentRun> => {
    if (input.sessionId === '') {
      throw new PrSubagentError('session-not-live', '没有可用的主会话。', '先在「投递到」里选一个会话（默认当前会话），子智能体要挂在它下面。')
    }
    const subagents = deps.subagents()
    if (subagents?.startActivation === undefined) {
      throw new PrSubagentError('no-subagents', '当前 DSH 没有子智能体服务。', '这个版本的宿主不支持子智能体；把结论手工投给会话，或升级 DSH 到 0.2.1 以上。')
    }
    const parent = await resolveParent(input.sessionId)

    const controller = new AbortController()
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()

    // 只给文字 prompt：不给 outputSchema，子智能体就按模板自然输出 Markdown，
    // 面板拿到的正文可以直接当 PR 评论用。
    const promptBlocks = [{ type: 'text' as const, text: input.prompt }]

    // DSH 0.2.2-rc.1 有两个构建，startActivation 的参数形状不一样：
    //   · 桌面版（应用内置 app.asar）：拍平的 { parent, prompt, maxDepth… }
    //   · 全局 CLI 版（npm 装的 dsh）：嵌套的 { request: { parent, prompt, maxDepth… } }
    // 只给其中一种，另一种会读到 undefined 而抛
    // 「Cannot read properties of undefined (reading 'id')」（读 spec.parent.id）。
    // 两个构建都不校验未知键，所以两种形状一起给，谁认哪个都用得上。
    const activationSpec = {
      provider: 'spawn',
      label: input.label,
      parent,
      prompt: promptBlocks,
      request: { parent, prompt: promptBlocks },
      signal: controller.signal,
      // 'caller'：不往主会话里插系统消息，结果只回到本插件；
      // 'parent'：结论也落进主会话（结算消息），用于「投递到主会话」那一档。
      delivery: input.delivery ?? 'caller',
    }

    let activation: Awaited<ReturnType<NonNullable<SubagentsLike['startActivation']>>>
    try {
      activation = await subagents.startActivation(
        activationSpec as Parameters<NonNullable<SubagentsLike['startActivation']>>[0],
      )
    } catch (cause) {
      clearTimeout(timer)
      const message = cause instanceof Error ? cause.message : String(cause)
      // 形状不匹配时错误恰好是读 'id'：给一句能自查的提示，别再让人去猜会话死没死。
      const hint = /reading 'id'/.test(message)
        ? '宿主与插件对 startActivation 的参数形状不一致（桌面版拍平、CLI 版嵌套）。插件已同时给两种形状；如果还看到这句，说明宿主又是第三种形状，请把 DSH 与插件升到同一发布线。'
        : '确认所选会话还活着；如果刚关闭了标签页，选当前会话重试。'
      throw new PrSubagentError('start-failed', `拉起子智能体失败：${message}`, hint)
    }

    const now = Date.now()
    const run: PrSubagentRun = {
      runId: `run-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      childId: String(activation.childId),
      status: 'running',
      text: '',
      stopReason: '',
      error: '',
      createdAt: now,
      finishedAt: null,
    }
    runs.set(run.runId, { run, controller })
    prune(now)
    // 先登记再等结果：子智能体一被拉起就可能开始调工具，登记晚了第一次写调用就漏拦。
    markReviewSession(run.childId)

    void activation.result
      .then((result) => {
        run.status = 'done'
        run.text = flattenOutput(result.output)
        run.stopReason = String(result.stopReason ?? '')
        if (run.text === '' && typeof result.diagnostic === 'string') run.text = result.diagnostic
      })
      .catch((cause) => {
        run.status = 'failed'
        run.error = cause instanceof Error ? cause.message : String(cause)
      })
      .finally(() => {
        clearTimeout(timer)
        run.finishedAt = Date.now()
        // 结果已经拿到（或失败），激活对象可以回收。
        void activation.dispose?.().catch(() => undefined)
      })

    return run
  }

  const get = (runId: string): PrSubagentRun | null => {
    const entry = runs.get(runId)
    return entry === undefined ? null : entry.run
  }

  const cancel = (runId: string): boolean => {
    const entry = runs.get(runId)
    if (entry === undefined) return false
    entry.controller.abort()
    if (entry.run.status === 'running') {
      entry.run.status = 'failed'
      entry.run.error = '被使用者取消。'
      entry.run.finishedAt = Date.now()
    }
    return true
  }

  const dispose = (): void => {
    for (const entry of runs.values()) entry.controller.abort()
    runs.clear()
  }

  return { start, get, cancel, dispose }
}

export type PrSubagentRunner = ReturnType<typeof createPrSubagentRunner>
