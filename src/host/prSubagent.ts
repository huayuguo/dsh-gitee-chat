/**
 * 把「AI 审核」交给所选主会话下的**子智能体**执行。
 *
 * 用户口径（2026-10-26）：投递不要往主会话里塞一条用户消息 —— 审核是后台活，
 * 应该挂在所选主会话下起一个子智能体去跑（工具、模型、工作区都跟随那个主会话），
 * 跑完把结论交回面板，人再决定通过/驳回。
 *
 * 用的就是 DSH 自己的子智能体服务（`ctx.get('subagents')`，0.2.1 起有）：
 *   `startActivation({provider, label, request, signal, delivery})`
 * `request.parent` 必须是**活着的** Agent 实例，所以这里只能挂到正在运行的会话上
 * （会话空闲时 `agents.get(id)` 是 undefined，此时报 session-not-live 让使用者选当前会话）。
 */

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
    readonly code: 'no-subagents' | 'session-not-live' | 'start-failed' | 'run-not-found',
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
  readonly logger?: { warn?: (message: string) => void }
}) {
  const runs = new Map<string, { run: PrSubagentRun; controller: AbortController }>()

  const prune = (now: number): void => {
    for (const [key, entry] of runs) {
      if (entry.run.finishedAt !== null && now - entry.run.finishedAt > RUN_TTL_MS) runs.delete(key)
    }
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
    const parent = deps.agents()?.get?.(input.sessionId)
    if (parent === undefined || parent === null) {
      throw new PrSubagentError(
        'session-not-live',
        '所选会话当前没有在跑的智能体。',
        '子智能体必须挂在活着的会话下：选「当前会话」，或先在那个会话里发一条消息把它唤醒，再回来发起。',
      )
    }

    const controller = new AbortController()
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()

    let activation: Awaited<ReturnType<NonNullable<SubagentsLike['startActivation']>>>
    try {
      activation = await subagents.startActivation({
        provider: 'spawn',
        label: input.label,
        // 只给文字 prompt：不给 outputSchema，子智能体就按模板自然输出 Markdown，
        // 面板拿到的正文可以直接当 PR 评论用。
        request: { parent, prompt: [{ type: 'text', text: input.prompt }] },
        signal: controller.signal,
        // 'caller'：不往主会话里插系统消息，结果只回到本插件；
        // 'parent'：结论也落进主会话（结算消息），用于「投递到主会话」那一档。
        delivery: input.delivery ?? 'caller',
      })
    } catch (cause) {
      clearTimeout(timer)
      const message = cause instanceof Error ? cause.message : String(cause)
      throw new PrSubagentError('start-failed', `拉起子智能体失败：${message}`, '确认所选会话还活着；如果刚关闭了标签页，选当前会话重试。')
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
