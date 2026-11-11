/**
 * AI 审核子智能体的会话登记表 + 只读判据。
 *
 * 为什么需要这张表：`startActivation` 拉起的子智能体**继承所选主会话的完整工具集**，
 * 「只读 / 不要合并 / 别评论」只写在 prompt 里 —— 那是"劝"，不是"拦"。2026-11-11 实测
 * 两个审核子智能体就自己调了 `comment_enterprise_pull`，往真实 PR 贴了结论。
 *
 * 为什么不给子智能体单独一套工具：宿主没有这个口子 ——
 *   · `composition.toolFilter` 只由 preset 组合注入（`dsh-subagent` 的 `startLocal`
 *     只传 `composition: { agentPreset }`），activation spec 里带 toolFilter 不被采用；
 *   · preset 的 config schema 也只认 `{ id, name, description, order, plugins }`。
 * 所以约束落在插件侧：这里登记"哪些会话是审核子智能体"，全局 `ctx.tools.guard()` 对它们
 * 只放行只读工具。换模型、换产物、换调用路径都绕不过去。
 */

/** 最多记多少个子会话：审核 run 都会结束，留一份"最近用过"就够，不无限长。 */
const MAX_TRACKED = 200

const reviewSessions = new Set<string>()

/** 登记一个"审核子智能体"会话（拉起成功后立刻调用）。 */
export function markReviewSession(sessionId: string): void {
  const id = sessionId.trim()
  if (id === '') return
  reviewSessions.add(id)
  if (reviewSessions.size <= MAX_TRACKED) return
  // Set 按插入顺序迭代：超限就丢最早登记的那批（它们是已经跑完的旧 run）。
  let excess = reviewSessions.size - MAX_TRACKED
  for (const key of reviewSessions) {
    reviewSessions.delete(key)
    if (--excess <= 0) break
  }
}

/** 这个会话是不是审核子智能体。 */
export function isReviewSession(sessionId: string | undefined): boolean {
  return sessionId !== undefined && sessionId !== '' && reviewSessions.has(sessionId)
}

/**
 * 诊断快照（只读，给 `/debug/review-sessions` 用）：
 * 让"登记生效"和"门禁真被挂上"能在运行期验证，而不是只看单测。
 */
export function reviewSessionSnapshot(): { count: number; ids: string[] } {
  return { count: reviewSessions.size, ids: [...reviewSessions] }
}

/**
 * 门禁探针：最近 20 次 guard 判定。
 *
 * 为什么要有：2026-11-11 第一轮实测发现「登记表有 id，但子智能体照样把评论发出去了」——
 * 光看登记表没法区分「门禁没被调用」还是「取不到会话 id」。这里把每次判定的输入留痕，
 * `/debug/review-sessions` 直接回显，排查时不用再猜。
 */
export interface GuardProbe {
  at: number
  tool: string
  inner?: string
  op?: string
  agentKeys: string[]
  /** 入参是从哪个字段取到的：宿主实际传 `arguments`；取到 `args` 说明又用回了错名字。 */
  argsFrom?: 'arguments' | 'args' | 'none'
  resolved: string | undefined
  registered: boolean
  verdict: 'allow' | 'deny'
}

const MAX_PROBES = 20
const probes: GuardProbe[] = []

export function recordGuardProbe(probe: GuardProbe): void {
  probes.push(probe)
  if (probes.length > MAX_PROBES) probes.shift()
}

export function guardProbes(): GuardProbe[] {
  return [...probes]
}

/**
 * 从工具调用的 exec 里取出会话 id。
 *
 * 宿主的 guard 签名只保证「call name, parsed arguments, and optional agent scope」，
 * agent 是 Agent 实例（`agent.session.requestHeader()` 是宿主自己在用的），但不同小版本
 * 上「会话 id 挂在哪」并不稳定 —— 所以按几个已知位置依次取，取不到就当"不是审核会话"。
 */
export function sessionIdOf(exec: {
  agent?: {
    id?: unknown
    session?: { id?: unknown; header?: { id?: unknown } }
  }
  sessionId?: unknown
}): string | undefined {
  const agent = exec.agent
  const candidates = [agent?.id, agent?.session?.id, agent?.session?.header?.id, exec.sessionId]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

/** 只读工具的名字前缀（Gitee 企业 MCP 的读接口全是这几个动词）。 */
const READ_TOOL_NAME = /^(?:list_|get_|search_|show_|describe_|query_|check_|find_|read_)/

/** 宿主自带的只读工具：读文件、搜代码、查技能、查网。 */
const READ_ONLY_HOST_TOOLS = new Set(['read', 'glob', 'grep', 'skill', 'web_search', 'web_fetch'])

/** 插件自己的两级入口工具名（与 `giteeEntGatewayTool` 注册的名字一致）。 */
const GATEWAY_TOOL_NAME = 'gitee_ent'

function denial(target: string): string {
  return [
    '## AI 审核子智能体是只读的',
    '',
    `${target} 会改变外部状态（评论、合并、审核、测试、改工作项、写文件…），已被插件硬拦。`,
    '',
    '- 审核子智能体只负责「读代码 + 出结论」，结论回到面板，由人在主会话里决定要不要发出去。',
    '- 这是权限边界，不是提示词叮嘱：换产物、换模型、换宿主都绕不过去。',
    '- 确实要写，请在主会话里操作（主会话没有这条限制）。',
  ].join('\n')
}

/**
 * 审核子智能体调某个工具时，该给什么拒绝理由；放行返回 `undefined`。
 *
 * 纯函数：`scripts/smoke.mjs` 直接单测它，不需要拉起真子智能体。
 */
export function reviewOnlyDenial(toolName: string, args: unknown): string | undefined {
  if (READ_ONLY_HOST_TOOLS.has(toolName)) return undefined
  const record = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {}

  if (toolName === GATEWAY_TOOL_NAME) {
    // 两级入口：`op` 不是 `call` 时只是看目录 / 看 schema，不动数据。
    const op = typeof record.op === 'string' ? record.op : ''
    if (op !== 'call') return undefined
    const inner = typeof record.name === 'string' ? record.name : ''
    if (READ_TOOL_NAME.test(inner)) return undefined
    return denial(inner === '' ? '`gitee_ent`（op=call）' : `\`${inner}\``)
  }

  // Gitee preset 里是原生的 55 个 MCP 工具：`mcp__gitee_ent__<tool>`。
  const prefix = 'mcp__gitee_ent__'
  if (toolName.startsWith(prefix)) {
    const inner = toolName.slice(prefix.length)
    if (READ_TOOL_NAME.test(inner)) return undefined
    return denial(`\`${inner}\``)
  }

  // 其余宿主工具（写文件、跑命令、改 todo、调别的 MCP…）一律不放行。
  return denial(`\`${toolName}\``)
}
