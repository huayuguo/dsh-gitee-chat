/**
 * Gitee 企业知识库文档 —— **MCP 委派层**（host 平面）。
 *
 * ## 这个文件存在的唯一理由
 *
 * `DOCS.md` §7 定了一条纪律：**MCP 是文档能力的唯一实现**。
 * 插件**不实现任何文档端点** —— 不拼 `/doc_nodes/tile`、不拼 `/docs/{id}/files`、
 * 不自己调 `/docs/{id}/export`。所有文档数据都经 MCP 工具获得。
 *
 * 而 MCP 行（`mcp-gitee`，`@deepseek-ai/dsh-mcp-client`）挂在 **preset** 里，
 * `serverName: gitee_ent`，所以：
 *
 *   1. 工具名是 `mcp__gitee_ent__<tool>`；
 *   2. 它**只在该 preset 的 agent 作用域可见** —— profile 层的全局视角看不到；
 *   3. 所以调用必须带 `agent`，否则拿到 `UNKNOWN_TOOL`。
 *
 * 这与「客户端插件拿不到会话的 preset」是同一类事实（见 `DESIGN.md` §12），
 * 解法也同款：**由 host 按 sessionId 解析出作用域**。
 *
 * ## 白拿的好处
 *
 * `./agent` 里那个能力档 guard 是 **agent 作用域**的。host 经该作用域调用
 * 会照样过 guard —— 于是**标签页发起的文档调用与模型发起的受完全相同的档位约束**。
 * 这是"只有一份实现"的直接收益，不需要在 host 侧再写一套权限判断。
 *
 * @module dsh-gitee-chat/host/mcp-docs
 */

import { noEnterpriseHint, unauthorizedEnterpriseHint, type EnterpriseIdResolver } from './enterpriseId.ts'
import type { McpClient } from './mcpClient.ts'

/** 文档委派失败的原因（供路由映射 HTTP 状态）。 */
export type DocErrorCode =
  /** 请求没带 sessionId。 */
  | 'no-session'
  /** 该会话没有活的 agent（未加载 / 已归档）。 */
  | 'no-agent'
  /** 宿主没有 tools 注册表（组合不完整）。 */
  | 'no-tools'
  /** 解析不出企业 id（没钉、没有本地配置、token 又对不上唯一企业）。 */
  | 'no-enterprise'
  /** MCP 工具不存在（多半是该会话没挂 Gitee preset，或前缀配错了）。 */
  | 'unknown-tool'
  /** MCP 工具本身报错（参数、权限、网络…）。 */
  | 'tool-failed'
  /** MCP 返回的形状不是我们能认的 JSON。 */
  | 'bad-response'
  /** 调用超时。 */
  | 'timeout'

/** 委派层错误：带可判定的 code，便于路由给出可行动的提示。 */
export class DocError extends Error {
  constructor(readonly code: DocErrorCode, message: string) {
    super(message)
    this.name = 'DocError'
  }
}

/** `ctx.tools` 的最小可用表面（只取我们要用的那个方法）。 */
export interface ToolsService {
  execute(exec: {
    callId: string
    name: string
    arguments: unknown
    agent?: unknown
    signal: AbortSignal
  }): Promise<ToolExecutionLike>
}

/** `tools.execute` 的返回（成功/失败两态，见 tools 服务契约）。 */
export interface ToolExecutionLike {
  isError: boolean
  value?: unknown
  content?: unknown
  error?: { message?: string; info?: { name?: string; code?: string } }
}

/** 委派层依赖。 */
export interface McpDocDeps {
  /** 按会话 id 取活着的 agent（作用域）。拿不到返回 undefined。 */
  readonly agentOf: (sessionId: string) => unknown | undefined
  /** 取 tools 注册表（可选：组合不完整时为 undefined）。 */
  readonly tools: () => ToolsService | undefined
  /** MCP 工具名前缀（默认 `mcp__gitee_ent__`，跟 preset 的 serverName 走）。 */
  readonly toolPrefix: string
  /** 企业 id **解析器**（工具的第一个必填参数，每次调用现取 —— 见 host/enterpriseId.ts）。 */
  readonly enterprise: EnterpriseIdResolver
  /**
   * **进程级直连通道**（0.5.4 起）。
   *
   * 有它就不再要求「当前会话挂了 Gitee preset」：PR / 文档面板在任何模式下都能取数
   * （用户 2026-10-26 口径：「任何模式都可以，而不是必须 agent 预设选 gitee 项目会话模式」）。
   * 走的是插件自己的 MCP stdio 客户端（`host/mcpClient.ts`），与公开 gateway 同一套
   * token/企业规则；权限仍然由 token 角色与 `get_enterprise_pull_auth` 决定。
   */
  readonly direct?: McpClient
  /** 单次调用超时（毫秒）。 */
  readonly timeoutMs?: number
}

/** 文档节点的界面形状（由 MCP 的 Document 裁剪而来）。 */
export interface DocSummary {
  documentId: number
  documentNodeId: number
  name: string
  filePath: string
  programId: number | null
  programName: string
  updatedAt: string
  createdAt: string
}

/** 页/文件夹的界面形状。 */
export interface DocPageSummary {
  pageId: number
  parentPageId: number
  name: string
  /** `page` | `folder` */
  type: string
  /** 远程权威版本（提交 id 语义）。核对就靠它。 */
  version: string
  lastEditTime: string
  contentType: string
}

/** 一页正文。 */
export interface DocPageContent extends DocPageSummary {
  content: string
  /** 正文是否被我们截断（截断必须显式告知，见 F-19）。 */
  truncated: boolean
  bytes: number
}

/**
 * 知识库**节点**（`doc_nodes` 树里的一项）。
 *
 * 这是本企业知识库的**真实形态**（实测 2026-09-15）：企业/项目知识库是一棵
 * `DocDirectory`（文件夹）+ `AttachFile`（上传的 .md/.docx/.pdf/.png…）的树。
 *
 * ⚠️ **不是** `list_enterprise_documents` 那种 `WikiInfo` 文档 —— 本企业一篇都没有，
 * 所以那条路永远返回 0。这不是 bug，是**绑错了数据源**。
 */
export interface DocNodeSummary {
  nodeId: number
  parentId: number
  name: string
  /** `DocDirectory` / `AttachFile` / 其它（原样透传，界面按它分支）。 */
  fileType: string
  /**
   * 附件/文档内容的 id —— **读内容用它**（`download_attach_file`）。
   * 目录节点为 0。注意它**不是**节点 id。
   */
  fileId: number
  /** 知识库内的路径，如 `项目知识库/[PRD] xxx/设备参数文档.md`。 */
  filePath: string
  /**
   * 附件字节数（来自节点上的 `attach_file.size`）。
   *
   * 目录节点、以及接口不带该字段时为 **0** —— 消费方必须按"0 = 未知"处理，
   * 不能拿它当"空文件"。它是**缓存变更感知**的两个依据之一（另一个是 `updatedAt`）：
   * 附件不可变，远端变没变只能靠这两个字段比，见 `docCache.classifyAttachState`。
   */
  size: number
  programId: number | null
  createdAt: string
  updatedAt: string
  /** 由文件名推出的扩展名（小写；无扩展名为空串）。 */
  ext: string
}

/** 搜索结果命中（企业级，不能按项目过滤）。 */
export interface DocSearchHit {
  documentId: number
  documentNodeId: number
  documentName: string
  documentPath: string
  pageId: number
  pageName: string
  contentPreview: string
  updatedAt: string
}

/** 仓库的界面形状（由 MCP `list_enterprise_repositories` 裁剪而来）。 */
export interface RepoSummary {
  repoId: number
  name: string
  /**
   * URL 路径段（**不是** name）。
   *
   * 实测（2026-09-15）：同一个仓库 `name` 与 `path` 经常不同 ——
   * `name=demo-docs` 而 `path=docs`、`name=demo-server` 而 `path=demoserver`。
   * 用 `name` 拼 `{repo}.wiki.git` 会 404，必须用 `path_with_namespace`。
   */
  path: string
  pathWithNamespace: string
  description: string
  /** `public` 原始值：0=私有，2=企业内部开源。 */
  public: number
  defaultBranch: string
  membersCount: number
  lastPushAt: string
  repoSize: number
  outsourced: boolean
  statusName: string
  /**
   * WIKI 是否有内容 —— 来自 fork 的 `types.Repository.wiki_enabled_with_content`。
   *
   * 这个字段是本 fork **补声明**的：Go 的 `json.Unmarshal` 只填声明过的字段，
   * 早先没声明，于是接口明明返回了、客户端却永远是 false（与 `DocNode.FileId`
   * 同一类静默丢数据的坑）。
   */
  wiki: boolean
}

/** 把任意值收敛成对象（非对象返回 undefined）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 取字符串字段（缺失/类型不符返回空串）。 */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 取数字字段（缺失/NaN 返回 0）。 */
function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 从数组字段里取第一个数组（缺失返回空数组）。 */
/* ── PR 形状归一化（0.5.4）───────────────────────────────────────────────
 * Gitee v8 的 PR JSON 是 snake_case、字段还会缺；这里统一成 `types.ts`
 * 里的 camelCase 形状，**让上层（prService / client）不再碰原始 JSON**。
 * 原则：缺字段给安全默认值，绝不凭角色猜权限（auth 单独取，取不到就是 null）。
 */

/** `state` 归一。 */
function prStateOf(value: unknown): 'opened' | 'merged' | 'closed' {
  const v = str(value)
  return v === 'merged' || v === 'closed' ? v : 'opened'
}

/** 审查/测试状态归一：只认 0/1/2，其它当 0。 */
function prTriState(value: unknown): 0 | 1 | 2 {
  const n = num(value)
  return n === 1 || n === 2 ? n : 0
}

/** 人（作者/审查人/测试人/评论人）。 */
function toPrPerson(value: unknown): PrPerson {
  const r = asRecord(value) ?? {}
  const st = num(r.state)
  return {
    id: num(r.id),
    name: str(r.name) || str(r.username),
    username: str(r.username),
    state: st === 1 ? 1 : st === 2 ? 2 : 0,
  }
}

/** 权限（`get_enterprise_pull_auth`）。字段名是 snake_case，逐个别名认。 */
function toPrAuth(value: unknown): PrAuth | null {
  const r = asRecord(value)
  if (r === undefined || Object.keys(r).length === 0) return null
  const f = (camel: string, snake: string): boolean => r[camel] === true || r[snake] === true
  return {
    read: f('read', 'read'),
    createNote: f('createNote', 'create_note'),
    update: f('update', 'update'),
    canCheck: f('canCheck', 'can_check'),
    canTest: f('canTest', 'can_test'),
    canMerge: f('canMerge', 'can_merge'),
    forceChecked: f('forceChecked', 'force_checked'),
    forceTested: f('forceTested', 'force_tested'),
    canClose: f('canClose', 'can_close'),
    canReopen: f('canReopen', 'can_reopen'),
    canDeleteSource: f('canDeleteSource', 'can_delete_source'),
  }
}

/** 列表行 / 详情共用部分。 */
function toPrSummary(value: unknown): PrSummary {
  const r = asRecord(value) ?? {}
  const project = asRecord(r.project) ?? {}
  const src = asRecord(r.source_branch) ?? {}
  const tgt = asRecord(r.target_branch) ?? {}
  const assignees = arr(r.assignees).map(toPrPerson)
  const testers = arr(r.testers).map(toPrPerson)
  const checkState = prTriState(r.check_state)
  const testState = prTriState(r.test_state)
  const canMerge = r.can_merge === true
  const iid = num(r.iid)
  const repoPath = str(project.path_with_namespace)
  return {
    id: num(r.id),
    iid,
    title: str(r.title),
    state: prStateOf(r.state),
    draft: r.draft === true,
    repoId: num(project.id) || num(r.project_id),
    repoPath,
    sourceBranch: str(src.branch),
    targetBranch: str(tgt.branch),
    author: toPrPerson(r.author),
    checkState,
    testState,
    prAssignNum: num(r.pr_assign_num),
    prTestNum: num(r.pr_test_num),
    checkPassed: assignees.filter((p) => p.state === 1).length,
    testPassed: testers.filter((p) => p.state === 1).length,
    mergeable: canMerge && checkState === 2 && testState === 2,
    updatedAt: str(r.updated_at),
    url: repoPath === '' || iid <= 0 ? '' : `https://gitee.com/${repoPath}/pulls/${iid}`,
  }
}

/** 变更文件：`patch` 是 `{diff,new_path,old_path,a_mode,b_mode,...}`，摊平。 */
function toPrFile(value: unknown): PrFile {
  const r = asRecord(value) ?? {}
  const patch = asRecord(r.patch) ?? {}
  const st = str(r.status)
  const status: PrFile['status'] = st === 'added' || st === 'renamed' || st === 'deleted' ? st : 'modified'
  return {
    filename: str(r.filename),
    oldPath: str(patch.old_path) || str(r.old_path) || str(r.filename),
    newPath: str(patch.new_path) || str(r.new_path) || str(r.filename),
    status,
    additions: num(r.additions),
    deletions: num(r.deletions),
    diff: str(patch.diff) || str(r.diff),
  }
}

/**
 * 评论：`list_enterprise_pull_comments` 返回 `{notes:[…]}` 或 `{data:[…]}`，两条都认。
 *
 * 正文的键名实测是 **`content`**（不是 `body`）：只看 `body` 会把每条评论渲染成
 * 空壳（作者、时间都在，正文空白），AI 结论也因此永远「找不到」。
 */
function toPrComment(value: unknown): PrComment {
  const r = asRecord(value) ?? {}
  return {
    id: num(r.id),
    body: str(r.content) || str(r.body) || str(r.note),
    author: toPrPerson(r.author),
    createdAt: str(r.created_at),
  }
}


function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 从一个 `tools.execute` 结果里取出 MCP 工具返回的 JSON 载荷。
 *
 * ## 为什么这里必须写得这么啰嗦（一次真实事故）
 *
 * DSH 的 MCP 桥接（`@deepseek-ai/dsh-mcp-client`）**不是**把工具返回的 JSON
 * 直接放进 `value`。它的契约是：
 *
 * ```js
 * value = { content: [ { type: 'text', text: '<工具返回的 JSON 文本>' } ],
 *           ...(structuredContent !== undefined ? { structuredContent } : {}) }
 * ```
 *
 * 也就是说 —— **`value` 是 `{content: [...]}` 这个信封，真正的载荷在文本块里**。
 * 早先这里写成「`value` 存在就直接返回它」，于是每个字段查找都落空：
 * `record.data` / `record.documents` / `record.total_count` 全是 undefined，
 * 界面永远显示"顶层 0 项"，**而且不报错** —— 最难查的一类故障。
 *
 * 所以现在的顺序是：`structuredContent` → `value.content` 文本块解析 → `value` 本身
 * → 顶层 `content`。四步都试过才报 `bad-response`。
 *
 * @param name - 工具名（错误信息里用）。
 * @param result - `tools.execute` 的返回。
 */
export function unwrapToolResult(name: string, result: ToolExecutionLike): unknown {
  if (result.isError === true) {
    const text = contentText(result.content)
    const detail = text !== '' ? text : (result.error?.message ?? '未知错误')
    throw new DocError('tool-failed', `MCP 工具 ${name} 执行失败：${detail.slice(0, 400)}`)
  }

  const envelope = asRecord(result.value)

  if (envelope !== undefined) {
    // 1) 桥接层在 MCP 声明了 output schema 时会带结构化内容 —— 最可信。
    if (envelope.structuredContent !== undefined && envelope.structuredContent !== null) {
      return envelope.structuredContent
    }
    // 2) **常态**：MCP 的 content 块装在 value.content 里，载荷是其中的 JSON 文本。
    if (Array.isArray(envelope.content)) {
      const text = contentText(envelope.content).trim()
      if (text !== '') return parsePayload(name, text)
      // content 里没有文本（例如纯图片/附件块）→ 只能把信封本身交出去。
      return envelope
    }
    // 3) `value` 本身就是载荷（某些工具/将来桥接层直接放结构化结果）。
    return envelope
  }

  if (result.value !== undefined && result.value !== null) return result.value

  // 4) content 在顶层（无 value 时）。
  const text = contentText(result.content).trim()
  if (text === '') return {}
  return parsePayload(name, text)
}

/** 把工具返回的文本解析成 JSON；不是 JSON 就明确报错（不要静默给空对象）。 */
/**
 * 写工具的返回是**一句人话**（如 `Operation completed successfully`），不是 JSON。
 * 直连通道不能因此报 bad-response —— 那会把成功的写当故障；具体状态由调用方
 * 重新取详情确认（prService.action 就是这么做的）。
 */
function parsePayloadLoose(name: string, text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return {}
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return parsePayload(name, trimmed)
  return { ok: true, text: trimmed }
}

function parsePayload(name: string, text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new DocError('bad-response', `MCP 工具 ${name} 的返回不是 JSON：${text.slice(0, 200)}`)
  }
}

/** 把 content 块里的文本拼起来（非文本块忽略）。 */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record === undefined) continue
    if (typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('\n')
}

/** 单页正文的落盘上限（超出只给前 N 字节并把 truncated 置真）。 */
const DEFAULT_MAX_PAGE_CHARS = 200_000

/**
 * 创建文档委派客户端。
 *
 * **每一个方法都只做三件事**：拼参数 → 按作用域调 MCP → 裁剪成界面要的形状。
 * 任何"这个端点该怎么调"的知识都**不在这个文件里**，它在 MCP 工具的描述里。
 *
 * @param deps - agent 解析、tools 注册表、前缀与企业 id 解析器。
 */
export function createMcpDocs(deps: McpDocDeps) {
  const timeoutMs = deps.timeoutMs ?? 60_000
  let seq = 0

  /**
   * 问一次 MCP：**这个 token 看得见哪些企业**（`list_enterprises`）。
   *
   * 只有 flag / 环境变量 / 本地配置三处都没指定时才会走到这里 —— 它是「照 gq 的规矩
   * 解析企业」的最后一步。失败一律当作"没看见"：真正可行动的那句话由
   * `noEnterpriseHint` 去说，这里再抛一个 MCP 原始报错只会让使用者更看不懂。
   *
   * @param tools - tools 注册表（调用方已确认 `execute` 存在）。
   * @param agent - 会话 agent（作用域；少了会拿到 UNKNOWN_TOOL）。
   */
  async function listVisibleEnterprises(tools: ToolsService, agent: unknown): Promise<number[]> {
    if (tools.execute === undefined) return []
    const name = `${deps.toolPrefix}list_enterprises`
    // 探测用短超时：这条路走不通时应该尽快报"去设置页选企业"，而不是让人干等一分钟。
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 20_000))
    try {
      const result = await tools.execute({
        callId: `gitee-chat-docs-enterprises-${Date.now()}-${seq++}`,
        name,
        arguments: {},
        agent,
        signal: controller.signal,
      })
      const record = asRecord(unwrapToolResult(name, result)) ?? {}
      return arr(record.data ?? record.list ?? record.enterprises)
        .map((item) => num(asRecord(item)?.id))
        .filter((id) => id > 0)
    } catch {
      return []
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 调一次 MCP 文档工具。
   * @param sessionId - 会话 id（解析作用域用）。
   * @param tool - MCP 原始工具名（不含前缀）。
   * @param args - 工具参数（不含 enterprise_id，本方法会补）。
   */
  /**
   * 直连通道调用（无 session）：企业 id 用同一套解析器，取不到的可见企业就问一次
   * `list_enterprises`；MCP 报错翻成 `DocError`。
   */
  async function callDirect(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const client = deps.direct
    if (client === undefined) throw new DocError('no-tools', '直连通道缺失（deps.direct 未注入）。')
    const visible = async (): Promise<number[]> => {
      try {
        const result = await client.call('list_enterprises', {})
        const parsed = parsePayload('list_enterprises', result.text)
        const list = Array.isArray(parsed) ? parsed : asRecord(parsed)?.data
        const ids = Array.isArray(list) ? list.map((item) => num(asRecord(item)?.id)) : []
        return ids.filter((id) => id > 0)
      } catch {
        return []
      }
    }
    const enterprise = await deps.enterprise.resolve(visible)
    if (enterprise.id <= 0) throw new DocError('no-enterprise', noEnterpriseHint(enterprise))
    let result
    try {
      result = await client.call(tool, { enterprise_id: enterprise.id, ...args })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new DocError('tool-failed', `调用 MCP 工具 ${tool} 失败：${message}`)
    }
    if (result.isError) throw new DocError('tool-failed', result.text || `MCP 工具 ${tool} 返回错误`)
    return parsePayloadLoose(tool, result.text)
  }

  async function call(sessionId: string, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    // 直连优先：有进程级客户端时，会话只是「谁发起的」标注，不再决定能不能取数。
    if (deps.direct !== undefined) return await callDirect(tool, args)
    if (sessionId === '') throw new DocError('no-session', '缺少 sessionId：文档取数必须知道是哪个会话（作用域与门禁都靠它）。')
    // 先看会话在不在，再看宿主有没有 tools 注册表。
    //
    // 顺序是有意的：`no-agent` 是**使用者能自己解决**的（把那个会话打开再试），
    // 而 `no-tools` 是部署/组合层面的故障（整个进程都缺注册表）。
    // 报更能行动的那一个。
    const agent = deps.agentOf(sessionId)
    if (agent === undefined) {
      throw new DocError('no-agent', '该会话当前没有加载（agent 不在内存里），无法读取文档。请先在界面里打开这个会话再试。')
    }
    const tools = deps.tools()
    if (tools === undefined) throw new DocError('no-tools', '宿主没有 tools 注册表，无法调用 MCP 文档工具（组合不完整）。')

    const name = `${deps.toolPrefix}${tool}`
    if (tools.execute === undefined) throw new DocError('no-tools', 'tools 服务没有 execute 方法。')

    // 企业 id 必须**每次现取**（flag → env → 本地配置 → 唯一企业自动）：
    // MCP 强制要这个参数，而把"钉住值 0"直接发过去就是 401（详见 host/enterpriseId.ts）。
    const enterprise = await deps.enterprise.resolve(() => listVisibleEnterprises(tools, agent))
    if (enterprise.id <= 0) throw new DocError('no-enterprise', noEnterpriseHint(enterprise))

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let result: ToolExecutionLike
    try {
      result = await tools.execute({
        callId: `gitee-chat-docs-${Date.now()}-${seq++}`,
        name,
        arguments: { enterprise_id: enterprise.id, ...args },
        agent,
        signal: controller.signal,
      })
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        throw new DocError('timeout', `调用 MCP 工具 ${name} 超时（${timeoutMs}ms）。`)
      }
      const message = error instanceof Error ? error.message : String(error)
      // 工具不可见时宿主报 UNKNOWN_TOOL —— 这是最可能的"没挂 Gitee preset / 前缀配错"。
      if (/UNKNOWN_TOOL/i.test(message)) {
        throw new DocError('unknown-tool', `MCP 工具 ${name} 在本会话不可见。请确认该会话用的是 Gitee 预设，且 docs.mcpToolPrefix 与 preset 的 serverName 一致。`)
      }
      throw new DocError('tool-failed', unauthorizedEnterpriseHint(`调用 MCP 工具 ${name} 失败：${message}`, enterprise.id, deps.enterprise.describe()))
    } finally {
      clearTimeout(timer)
    }

    // MCP 的报错是从这里抛出去的（`tool-failed`）—— 企业 id 不对时补一句人话再往外走：
    // 否则使用者看到的是「企业未授权此应用进行访问」，会往 token 的方向白查（见 host/enterpriseId.ts）。
    let value: unknown
    try {
      value = unwrapToolResult(name, result)
    } catch (error) {
      if (error instanceof DocError && error.code === 'tool-failed') {
        throw new DocError('tool-failed', unauthorizedEnterpriseHint(error.message, enterprise.id, deps.enterprise.describe()))
      }
      throw error
    }
    // execute 对不可见工具返回错误结果而不是抛 —— 这里再认一次。
    const record = asRecord(value)
    if (record !== undefined && typeof record.error === 'string' && /UNKNOWN_TOOL/i.test(record.error)) {
      throw new DocError('unknown-tool', `MCP 工具 ${name} 在本会话不可见（UNKNOWN_TOOL）。`)
    }
    return value
  }

  /** 裁剪一个 MCP doc_nodes 节点成界面形状。 */
  function toNode(raw: unknown): DocNodeSummary {
    const it = asRecord(raw) ?? {}
    const name = str(it.name)
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''
    const programId = num(it.program_id)
    // 节点归属项目优先用 `program` 对象（`/doc_nodes/level` 返回的是它，不是 program_id）
    const program = asRecord(it.program)
    const owning = program === undefined ? 0 : num(program.id)
    // 附件大小只在 file_type=AttachFile 时出现；拿不到就是 0（"未知"，不是"空"）。
    const attach = asRecord(it.attach_file)
    return {
      nodeId: num(it.id),
      parentId: num(it.parent_id),
      name,
      fileType: str(it.file_type),
      fileId: num(it.file_id),
      filePath: str(it.file_path),
      size: attach === undefined ? 0 : num(attach.size),
      programId: owning > 0 ? owning : (programId > 0 ? programId : null),
      createdAt: str(it.created_at),
      updatedAt: str(it.updated_at),
      ext,
    }
  }

  /** 裁剪一个 MCP Repository 成界面形状。 */
  function toRepo(raw: unknown): RepoSummary {
    const it = asRecord(raw) ?? {}
    const name = str(it.name)
    const path = str(it.path) !== '' ? str(it.path) : name
    const withNs = str(it.path_with_namespace) !== '' ? str(it.path_with_namespace) : path
    return {
      repoId: num(it.id),
      name,
      path,
      pathWithNamespace: withNs,
      description: str(it.description),
      public: num(it.public),
      defaultBranch: str(it.get_default_branch),
      membersCount: num(it.members_count),
      lastPushAt: str(it.last_push_at),
      repoSize: num(it.repo_size),
      outsourced: it.outsourced === true,
      statusName: str(it.status_name),
      // 只认严格的 true：字段缺失时必须是 false，绝不能"默认可用"。
      wiki: it.wiki_enabled_with_content === true,
    }
  }

  /** 裁剪一个 MCP Document（tile/WikiInfo）成界面形状。 */
  function toSummary(raw: unknown): DocSummary {
    const it = asRecord(raw) ?? {}
    const program = asRecord(it.program)
    return {
      documentId: num(it.document_id),
      documentNodeId: num(it.document_node_id),
      name: str(it.name),
      filePath: str(it.file_path),
      programId: program === undefined ? null : num(program.id),
      programName: program === undefined ? '' : str(program.name),
      updatedAt: str(it.updated_at),
      createdAt: str(it.created_at),
    }
  }

  /** 裁剪一个 MCP DocumentPage 成界面形状。 */
  function toPage(raw: unknown): DocPageSummary {    const it = asRecord(raw) ?? {}
    return {
      pageId: num(it.page_id ?? it.id),
      parentPageId: num(it.parent_page_id ?? it.parent_id),
      name: str(it.name),
      type: str(it.type) !== '' ? str(it.type) : (num(it.file_type) === 2 ? 'folder' : 'page'),
      version: str(it.version),
      lastEditTime: str(it.last_edit_time),
      contentType: str(it.content_type),
    }
  }

  return {
    /**
     * 当前生效的企业 id（**现取**：诊断用；缓存分层也以它为准）。
     *
     * 注意它是同步解析的第 1–3 步（flag/env/本地配置），自动识别出来的那家会作为
     * 最近一次探测结果回报 —— 与真正发给 MCP 的 id 在自动识别场景下可能有一拍之差。
     */
    resolveEnterpriseId: () => deps.enterprise.id(),
    /** 工具名前缀（诊断用）。 */
    toolPrefix: deps.toolPrefix,

    /**
     * 列举企业文档（可按项目过滤）。
     * 委派 `list_enterprise_documents` → `/doc_nodes/tile`。
     * @param sessionId - 会话 id。
     * @param options - programId 传了就是项目文档；search 传了就是搜索（**与 programId 互斥**，MCP 会拒）。
     */
    async listDocuments(sessionId: string, options: { programId?: number; search?: string; page?: number; perPage?: number } = {}): Promise<{ documents: DocSummary[]; total: number; searchMode: boolean }> {
      const args: Record<string, unknown> = {}
      if (options.search !== undefined && options.search.trim() !== '') {
        args.search = options.search.trim()
        if (options.page !== undefined) args.page = options.page
      } else {
        if (options.programId !== undefined) args.program_id = options.programId
        if (options.page !== undefined) args.page = options.page
        if (options.perPage !== undefined) args.per_page = options.perPage
      }
      const value = await call(sessionId, 'list_enterprise_documents', args)
      const record = asRecord(value) ?? {}
      if (Array.isArray(record.hits)) {
        return { documents: [], total: num(record.total_count), searchMode: true }
      }
      return {
        documents: arr(record.documents).map(toSummary),
        total: num(record.total_count),
        searchMode: false,
      }
    },

    /**
     * 企业级关键词搜索（**不能按项目过滤** —— 这是 MCP 的硬限制）。
     * @param sessionId - 会话 id。
     * @param query - 关键词。
     */
    async searchDocuments(sessionId: string, query: string, page?: number): Promise<DocSearchHit[]> {
      const args: Record<string, unknown> = { search: query }
      if (page !== undefined) args.page = page
      const value = await call(sessionId, 'list_enterprise_documents', args)
      const record = asRecord(value) ?? {}
      return arr(record.hits).map((raw) => {
        const it = asRecord(raw) ?? {}
        return {
          documentId: num(it.document_id),
          documentNodeId: num(it.document_node_id),
          documentName: str(it.document_name),
          documentPath: str(it.document_path),
          pageId: num(it.page_id),
          pageName: str(it.page_name),
          contentPreview: str(it.content_preview),
          updatedAt: str(it.updated_at),
        }
      })
    },

    /**
     * 列知识库**节点**（`doc_nodes` 树）—— 本企业知识库的**真实入口**。
     *
     * 委派 `list_doc_nodes` → `GET /{eid}/doc_nodes/level`。
     * 与 `listDocuments`（tile/WikiInfo）的区别，见 `DocNodeSummary` 的说明：
     * **tile 那条路在本企业恒为 0**，别再用它当列表源。
     *
     * @param sessionId - 会话 id。
     * @param options - parentId（默认 0=该范围顶层）、programId（传了就是项目知识库）、fileType 过滤。
     */
    async listNodes(sessionId: string, options: { parentId?: number; programId?: number } = {}): Promise<DocNodeSummary[]> {
      const args: Record<string, unknown> = { parent_id: options.parentId ?? 0 }
      if (options.programId !== undefined) args.program_id = options.programId
      const value = await call(sessionId, 'list_doc_nodes', args)
      const record = asRecord(value) ?? {}
      // `list_doc_nodes` 走的是 fork 的 HandleMCPResult，返回**原始分页信封**
      // （{total_count, data:[...]}），不是包装过的 {nodes:...} —— 两条都认，
      // 免得 fork 以后改形状时界面直接空白。
      const rows = Array.isArray(record.data) ? record.data : arr(record.nodes)
      return rows.map(toNode)
    },

    /**
     * 列企业**仓库**。
     *
     * 委派 `list_enterprise_repositories` → `GET /{eid}/projects`。
     * 注意路径是 `projects`（Gitee 企业版 API 里"仓库"就叫 project），
     * 与 `list_program_doc_nodes` 的"项目（program）"**不是一回事**。
     *
     * 实测（2026-09-15）两条过滤都有效，且是界面上那两种口径的唯一实现：
     *   - `program_id=<id>` → 该项目下的仓库（9500001 → 4 个；9500002 → 2 个）
     *   - `scope=internal-open` → 企业内部开源（24 个里 2 个）
     *
     * @param sessionId - 会话 id。
     * @param options - programId（项目下）或 scope（内置枚举），二者互斥使用。
     */
    async listRepositories(
      sessionId: string,
      options: { programId?: number; scope?: string; perPage?: number; page?: number } = {},
    ): Promise<RepoSummary[]> {
      const args: Record<string, unknown> = { per_page: options.perPage ?? 100 }
      if (options.programId !== undefined && options.programId > 0) args.program_id = options.programId
      if (options.scope !== undefined && options.scope !== '') args.scope = options.scope
      if (options.page !== undefined && options.page > 1) args.page = options.page
      const value = await call(sessionId, 'list_enterprise_repositories', args)
      const record = asRecord(value) ?? {}
      // 与 listNodes 同款：`list_enterprise_repositories` 返回原始分页信封
      // （`{total_count, data:[…]}`），不是包装过的 `{repos:…}` —— 两条都认。
      const rows = Array.isArray(record.data) ? record.data : arr(record.repos)
      return rows.map(toRepo)
    },

    /**
     * 把**附件内容**下载到本地目录。
     *
     * 委派 `download_attach_file`（**本 fork 独有**，v0.2.1-dsh.3 加入）→
     * `GET /{eid}/attach_files/{file_id}`。
     *
     * ⚠️ 两个实测教训，别改回去：
     *   1. 节点里的 `attach_file.download_url` 指向 **Web 域**，要会话 Cookie，
     *      用企业 token 打是 401 —— 必须走 API 形态（本工具就是这么实现的）。
     *   2. 目录作用域由**本次调用传的 `workspace`** 决定；缓存根在会话工作区之外，
     *      所以调用方必须把 `workspace` 指到缓存根，否则会被直接拒绝。
     *
     * @param sessionId - 会话 id。
     * @param input - file_id、目标目录、workspace（目录作用域上限）、可选文件名。
     */
    async downloadAttachFile(sessionId: string, input: {
      fileId: number
      outputDirectory: string
      workspace: string
      fileName?: string
      overwrite?: boolean
    }): Promise<{ savedPath: string; filename: string; bytes: number; contentType: string }> {
      const args: Record<string, unknown> = {
        file_id: input.fileId,
        output_directory: input.outputDirectory,
        workspace: input.workspace,
        overwrite: input.overwrite ?? true,
      }
      if (input.fileName !== undefined && input.fileName !== '') args.file_name = input.fileName
      const value = await call(sessionId, 'download_attach_file', args)
      const record = asRecord(value) ?? {}
      return {
        savedPath: str(record.saved_path),
        filename: str(record.filename),
        bytes: num(record.size),
        contentType: str(record.content_type),
      }
    },

    /**
     * 列一个文档里的全部页与文件夹（**一次就带回全部页的 version**，核对成本极低）。
     * 委派 `list_enterprise_document_pages` → `/docs/{id}/files`。
     *
     * ⚠️ 只对 `WikiInfo` 文档有效。**本企业暂无此类文档**（实测），
     * 项目资料是 `AttachFile` 附件，没有"页"这个概念。
     */
    async listPages(sessionId: string, documentId: number): Promise<DocPageSummary[]> {
      const value = await call(sessionId, 'list_enterprise_document_pages', { document_id: documentId })
      const record = asRecord(value) ?? {}
      return arr(record.pages).map(toPage)
    },

    /**
     * 读一页正文。`version` 传历史版本 / commit id 可读历史。
     * 委派 `get_enterprise_document_page`。
     * @param sessionId - 会话 id。
     * @param documentId - 文档 id。
     * @param pageId - 页 id。
     * @param version - 可选：读历史版本。
     * @param maxChars - 正文截断上限（超出置 truncated）。
     */
    async getPage(sessionId: string, documentId: number, pageId: number, version?: string, maxChars = DEFAULT_MAX_PAGE_CHARS): Promise<DocPageContent> {
      const args: Record<string, unknown> = { document_id: documentId, page_id: pageId }
      if (version !== undefined && version !== '') args.version = version
      const value = await call(sessionId, 'get_enterprise_document_page', args)
      const record = asRecord(value) ?? {}
      const page = asRecord(record.page) ?? {}
      const summary = toPage(page)
      const full = str(page.content)
      const truncated = full.length > maxChars
      return {
        ...summary,
        content: truncated ? full.slice(0, maxChars) : full,
        truncated,
        bytes: full.length,
      }
    },

    /**
     * 改一页正文 —— **整页替换**，必须带 `expected_version` 与 `commit_message`。
     *
     * 委派 `update_enterprise_document_page`。乐观锁由 **MCP 工具**实现
     * （它会先重读页面，版本不符直接拒），插件**不重复实现**这道校验，
     * 但也**绝不绕过**它。
     *
     * @param sessionId - 会话 id。
     * @param input - 文档/页 id、整页内容、期望版本、提交说明。
     */
    async updatePage(sessionId: string, input: { documentId: number; pageId: number; content: string; expectedVersion: string; commitMessage: string; pageName?: string }): Promise<DocPageSummary> {
      const args: Record<string, unknown> = {
        document_id: input.documentId,
        page_id: input.pageId,
        content: input.content,
        expected_version: input.expectedVersion,
        commit_message: input.commitMessage,
      }
      if (input.pageName !== undefined && input.pageName !== '') args.page_name = input.pageName
      const value = await call(sessionId, 'update_enterprise_document_page', args)
      const record = asRecord(value) ?? {}
      return toPage(asRecord(record.page) ?? {})
    },
    /** 当前 token 对应的用户（`get_user_info`）——「我提出的」口径要用它的 id。 */
    async currentUser(sessionId: string): Promise<{ id: number; name: string; username: string }> {
      const value = await call(sessionId, 'get_user_info', {})
      const r = asRecord(value) ?? {}
      return { id: num(r.id), name: str(r.name) || str(r.username), username: str(r.username) }
    },

    /* ── 合并请求（PR）· 0.5.4 ──────────────────────────────────────────
     * 委派 8 个原有 PR 工具 + 4 个 0.2.4-dsh.6 新增工具（审查/测试/权限/文件）。
     * 端点与 `pr_qt=iid` 的细节由 MCP 工具内部处理 —— 这里**绝不自己拼 URL**。
     */

    /** 列 PR。`scope` 由上层翻好（assign/test/create/related_to_me）。 */
    async listPulls(sessionId: string, options: {
      scope?: string
      state?: string
      repoId?: number
      search?: string
      sort?: string
      page?: number
      perPage?: number
    } = {}): Promise<{ items: PrSummary[]; total: number }> {
      const args: Record<string, unknown> = {
        page: options.page ?? 1,
        per_page: options.perPage ?? 20,
      }
      if (options.scope !== undefined && options.scope !== '') args.scope = options.scope
      if (options.state !== undefined && options.state !== '') args.state = options.state
      if (options.search !== undefined && options.search !== '') args.search = options.search
      if (options.sort !== undefined && options.sort !== '') args.sort = options.sort
      if (options.repoId !== undefined && options.repoId > 0) args.project_id = options.repoId
      const value = await call(sessionId, 'list_enterprise_pulls', args)
      const record = asRecord(value) ?? {}
      const rows = Array.isArray(record.data) ? record.data : arr(record.pulls)
      return { items: rows.map(toPrSummary), total: num(record.total_count) || rows.length }
    },

    /** PR 详情（原始 detail 形状 → 归一化）。 */
    async getPullDetail(sessionId: string, input: { repoId: number; iid: number }): Promise<Record<string, unknown>> {
      const value = await call(sessionId, 'get_enterprise_pull_detail', {
        project_id: input.repoId,
        pull_request_iid: input.iid,
      })
      return asRecord(value) ?? {}
    },

    /** 当前 token 对某 PR 的真实权限；取不到返回 null（**不猜**）。 */
    async getPullAuth(sessionId: string, input: { repoId: number; iid: number }): Promise<PrAuth | null> {
      const value = await call(sessionId, 'get_enterprise_pull_auth', {
        project_id: input.repoId,
        pull_request_iid: input.iid,
      })
      return toPrAuth(value)
    },

    /** 变更文件列表。 */
    async listPullFiles(sessionId: string, input: { repoId: number; iid: number; perPage?: number }): Promise<PrFile[]> {
      const value = await call(sessionId, 'list_enterprise_pull_files', {
        project_id: input.repoId,
        pull_request_iid: input.iid,
        per_page: input.perPage ?? 100,
      })
      const record = asRecord(value) ?? {}
      return arr(record.data).map(toPrFile)
    },

    /** 审查：accept 通过 · reject 驳回 · reset 撤销本人审查。 */
    async reviewPull(sessionId: string, input: { repoId: number; iid: number; action: 'accept' | 'reject' | 'reset'; force?: boolean }): Promise<void> {
      await call(sessionId, 'review_enterprise_pull', {
        project_id: input.repoId,
        pull_request_iid: input.iid,
        action: input.action,
        force_accept: input.force === true ? 1 : 0,
      })
    },

    /** 测试通过。 */
    async testPull(sessionId: string, input: { repoId: number; iid: number; force?: boolean }): Promise<void> {
      await call(sessionId, 'test_enterprise_pull', {
        project_id: input.repoId,
        pull_request_iid: input.iid,
        force_accept: input.force === true ? 1 : 0,
      })
    },

    /** 合并。 */
    async mergePull(sessionId: string, input: { repoId: number; iid: number; method?: 'merge' | 'squash' | 'rebase'; title?: string; description?: string }): Promise<void> {
      const args: Record<string, unknown> = {
        project_id: input.repoId,
        pull_request_iid: input.iid,
        merge_method: input.method ?? 'merge',
      }
      if (input.title !== undefined && input.title !== '') args.title = input.title
      if (input.description !== undefined && input.description !== '') args.description = input.description
      await call(sessionId, 'merge_enterprise_pull', args)
    },

    /**
     * 建 PR（UI 对话框与 agent 直接调 MCP 是**同一条**能力，只是入口不同）。
     *
     * `project_id` 接受仓库 id 或 path_with_namespace；分支名只能由调用方给
     * —— MCP 没有「列分支」的工具，所以 UI 侧是手输 + 默认分支兜底。
     */
    async createPull(sessionId: string, input: {
      repoId: number
      repoPath?: string
      sourceBranch: string
      targetBranch: string
      title: string
      body?: string
      prAssignNum?: number
      prTestNum?: number
      draft?: boolean
    }): Promise<Record<string, unknown>> {
      const args: Record<string, unknown> = {
        project_id: input.repoPath !== undefined && input.repoPath !== '' ? input.repoPath : String(input.repoId),
        source_branch: input.sourceBranch,
        target_branch: input.targetBranch,
        title: input.title,
      }
      if (input.body !== undefined && input.body !== '') args.body = input.body
      if (input.prAssignNum !== undefined) args.pr_assign_num = input.prAssignNum
      if (input.prTestNum !== undefined) args.pr_test_num = input.prTestNum
      if (input.draft === true) args.draft = 'true'
      return asRecord(await call(sessionId, 'create_enterprise_repo_pull', args)) ?? {}
    },

    /** 发评论。 */
    async commentPull(sessionId: string, input: { repoId: number; iid: number; body: string }): Promise<void> {
      await call(sessionId, 'comment_enterprise_pull', {
        project_id: input.repoId,
        pull_request_iid: input.iid,
        body: input.body,
      })
    },

    /** 列评论。 */
    async listPullComments(sessionId: string, input: { repoId: number; iid: number }): Promise<PrComment[]> {
      const value = await call(sessionId, 'list_enterprise_pull_comments', {
        project_id: input.repoId,
        pull_request_iid: input.iid,
      })
      const record = asRecord(value) ?? {}
      const rows = Array.isArray(record.notes) ? record.notes : Array.isArray(record.data) ? record.data : arr(record.comments)
      return rows.map(toPrComment)
    },

    /**
     * 改 PR（标题/正文/状态/审查人/测试人/开启审查或测试）。
     *
     * 「开启审核/测试」只能建完 PR 再 PUT（`check_state`/`test_state` 不在建 PR 的参数里，
     * 这是 M0 实测结论）—— 所以 openCheck/openTest 也走这里。
     */
    async updatePull(sessionId: string, input: { repoId: number; iid: number; patch: Record<string, unknown> }): Promise<void> {
      await call(sessionId, 'update_enterprise_pull', {
        project_id: input.repoId,
        pull_request_iid: input.iid,
        ...input.patch,
      })
    },
  }
}

/** 委派客户端类型。 */
export type McpDocs = ReturnType<typeof createMcpDocs>
