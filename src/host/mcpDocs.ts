/**
 * Gitee 企业知识库文档 —— **MCP 委派层**（host 平面）。
 *
 * ## 这个文件存在的唯一理由
 *
 * 本层只守一条纪律：**MCP 是文档能力的唯一实现**。
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
 * 这与「客户端插件拿不到会话的 preset」是同一类事实，
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

/** 文档委派失败的原因（供路由映射 HTTP 状态）。 */
export type DocErrorCode =
  /** 请求没带 sessionId。 */
  | 'no-session'
  /** 该会话没有活的 agent（未加载 / 已归档）。 */
  | 'no-agent'
  /** 宿主没有 tools 注册表（组合不完整）。 */
  | 'no-tools'
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
  /** 企业 id（工具的第一个必填参数）。 */
  readonly enterpriseId: number
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
 * @param deps - agent 解析、tools 注册表、前缀与企业 id。
 */
export function createMcpDocs(deps: McpDocDeps) {
  const timeoutMs = deps.timeoutMs ?? 60_000
  let seq = 0

  /**
   * 调一次 MCP 文档工具。
   * @param sessionId - 会话 id（解析作用域用）。
   * @param tool - MCP 原始工具名（不含前缀）。
   * @param args - 工具参数（不含 enterprise_id，本方法会补）。
   */
  async function call(sessionId: string, tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
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

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let result: ToolExecutionLike
    try {
      result = await tools.execute({
        callId: `gitee-chat-docs-${Date.now()}-${seq++}`,
        name,
        arguments: { enterprise_id: deps.enterpriseId, ...args },
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
      throw new DocError('tool-failed', `调用 MCP 工具 ${name} 失败：${message}`)
    } finally {
      clearTimeout(timer)
    }

    const value = unwrapToolResult(name, result)
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
    /** 本委派层使用的企业 id（诊断用）。 */
    enterpriseId: deps.enterpriseId,
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
    async listRepositories(sessionId: string, options: { programId?: number; scope?: string; perPage?: number } = {}): Promise<RepoSummary[]> {
      const args: Record<string, unknown> = { per_page: options.perPage ?? 100 }
      if (options.programId !== undefined && options.programId > 0) args.program_id = options.programId
      if (options.scope !== undefined && options.scope !== '') args.scope = options.scope
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
  }
}

/** 委派客户端类型。 */
export type McpDocs = ReturnType<typeof createMcpDocs>
