/**
 * 卡片 → 宿主取数通道。
 *
 * 卡片不通过模型拿数据：它拿工具调用的**参数**，直接向插件自己的路由要
 * 完整 payload。这是「模型只触发、数据由后台灌」的实现点。
 *
 * @module dsh-gitee-chat/client/api
 */

import type {
  BoardPayload,
  DocAttachmentResponse,
  DocDetailResponse,
  DocListResponse,
  DocPageResponse,
  DocSearchResponse,
  DocSyncResponse,
  DocTreeResponse,
  ErrorResponse,
  HealthResponse,
  IssueCreateRequest,
  IssueDetailPayload,
  IssueStateRow,
  IssueTypeRow,
  IssueWriteRequest,
  IssueWriteResult,
  PayloadResponse,
  ProgramMemberRow,
  RepoBranchesResponse,
  RepoListResponse,
  WikiPageResponse,
  WikiTreeResponse,
} from '../types.ts'

/** 取数参数（与工具参数同构）。 */
export interface BoardArgs {
  scope?: string
  program?: number
  refresh?: boolean
}

/** 卡片侧错误：带可判定的 code，便于给出可行动的提示。 */
export class BoardApiError extends Error {
  constructor(
    readonly code: ErrorResponse['code'] | 'network',
    message: string,
  ) {
    super(message)
    this.name = 'BoardApiError'
  }
}

/** 从响应体里取错误信封。 */
async function readError(res: Response): Promise<BoardApiError> {
  try {
    const body = (await res.json()) as ErrorResponse
    return new BoardApiError(body.code ?? 'script-failed', body.message ?? `HTTP ${res.status}`)
  } catch {
    return new BoardApiError('script-failed', `HTTP ${res.status}`)
  }
}

/**
 * 取看板数据。
 * @param args - 工具调用的参数（scope/program/refresh）。
 * @param signal - 取消信号（组件卸载时中断）。
 */
export async function fetchBoard(args: BoardArgs, signal?: AbortSignal): Promise<PayloadResponse> {
  let res: Response
  try {
    res = await fetch('/api/gitee-chat/payload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: args.scope === 'mywork' ? 'mywork' : 'portfolio',
        program: args.program,
        refresh: args.refresh === true,
      }),
      signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new BoardApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as PayloadResponse
  if (body?.ok !== true || !body.payload) {
    throw new BoardApiError('script-failed', '宿主返回了无法解析的响应')
  }
  return body
}

/** 会话是否跑在 Gitee 模式上。 */
export interface SessionProbe {
  ok: boolean
  sessionId: string
  /** true/false；null = host 尚不知道这个会话（刚创建、尚无事件）。 */
  gitee: boolean | null
  preset: string | null
}

/**
 * 问 host：这个会话是不是 Gitee 模式。
 *
 * 为什么必须问 host：客户端插件在 profile 层，它注册的 conversation.view
 * 对**所有 preset** 可见，客户端自己拿不到会话的 preset（SessionSummary 里没有）。
 * @param sessionId - 当前会话 id。
 */
export async function fetchSession(sessionId: string, signal?: AbortSignal): Promise<SessionProbe> {
  const res = await fetch(`/api/gitee-chat/session?sessionId=${encodeURIComponent(sessionId)}`, { signal })
  if (!res.ok) throw await readError(res)
  return (await res.json()) as SessionProbe
}

/** 一个工作项（视图下钻用）。 */
export interface WorkItemRow {
  id: number
  ident: string
  title: string
  state: string
  priorityHuman: string
  programId: number
  assignee: string
  deadline: string
  typeTitle: string
  overdue: boolean
  overdueDays: number
}

/** 单项目工作项清单。 */
export interface ProgramIssues {
  ok: boolean
  generatedAt: string
  programId: number
  total: number
  kpi: { total: number; overdue: number; unassigned: number }
  distribution: { state: string; count: number }[]
  issues: WorkItemRow[]
}

/**
 * 取某个项目的工作项清单（整屏视图下钻）。
 * @param programId - 项目 id。
 * @param state - 可选状态过滤。
 */
export async function fetchIssues(programId: number, state?: string, signal?: AbortSignal): Promise<ProgramIssues> {
  const q = new URLSearchParams({ program: String(programId) })
  if (state !== undefined && state !== '') q.set('state', state)
  const res = await fetch(`/api/gitee-chat/issues?${q.toString()}`, { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as ProgramIssues
  if (body?.ok !== true) throw new BoardApiError('script-failed', '宿主返回了无法解析的工作项响应')
  return body
}

/** 仓库维度工作项响应。 */
export interface RepoIssues {
  ok: boolean
  repoId: number
  total: number
  truncated: boolean
  issues: WorkItemRow[]
  distribution: { state: string; count: number }[]
}

/**
 * 取某个**仓库**下的工作项（仓库详情页「工作项」页签）。
 *
 * 与 `fetchIssues(programId)` 的区别只是过滤维度：Gitee 企业版里工作项可以挂在
 * 仓库（`project_id`）上，仓库详情页要看到的是这一层。
 * @param repoId - 仓库 id。
 * @param state - 可选状态过滤。
 */
export async function fetchRepoIssues(repoId: number, state?: string, signal?: AbortSignal): Promise<RepoIssues> {
  const q = new URLSearchParams({ repoId: String(repoId) })
  if (state !== undefined && state !== '') q.set('state', state)
  const res = await fetch(`/api/gitee-chat/repo/issues?${q.toString()}`, { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as RepoIssues
  if (body?.ok !== true) throw new BoardApiError('script-failed', '宿主返回了无法解析的仓库工作项响应')
  return body
}

/** 取一个项目的工作项类型（任务 / 需求 / 缺陷），新建工作项时选。 */
export async function fetchIssueTypes(programId: number, signal?: AbortSignal): Promise<IssueTypeRow[]> {
  const res = await fetch(`/api/gitee-chat/issue-types?program=${programId}`, { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as { ok: boolean; items?: IssueTypeRow[] }
  if (body?.ok !== true) throw new BoardApiError('script-failed', '取工作项类型失败')
  return body.items ?? []
}

/** 新建工作项的返回。 */
export interface CreatedIssue {
  id: number
  ident: string
  title: string
  state: string
}

/**
 * 新建工作项。
 *
 * 只依赖企业 token（不需要会话处于 Gitee 模式）；归属同时给
 * `programId` 与 `repoId` 时，工作项就挂在仓库下面。
 */
export async function createIssue(request: IssueCreateRequest, signal?: AbortSignal): Promise<CreatedIssue> {
  const res = await fetch('/api/gitee-chat/issue-create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as { ok: boolean } & Partial<CreatedIssue> & { error?: string; message?: string }
  if (body?.ok !== true) throw new BoardApiError('script-failed', body.message ?? body.error ?? '新建工作项失败')
  return { id: body.id ?? 0, ident: body.ident ?? '', title: body.title ?? request.title, state: body.state ?? 'open' }
}

/** 环境自检（供健康卡片使用）。 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await fetch('/api/gitee-chat/health', { signal })
  if (!res.ok) throw await readError(res)
  return (await res.json()) as HealthResponse
}

// ── 企业版 token：界面设置入口（写 ~/.dsh/.gitee-chat/token）──────────────────

/** token 配置状态（不返回明文 token，只报是否已配置与来源）。 */
export interface TokenStatusResponse {
  ok: boolean
  configured: boolean
  source: 'file' | 'env' | null
  path: string
}

/** 查询当前 token 是否已配置。 */
export async function fetchTokenStatus(signal?: AbortSignal): Promise<TokenStatusResponse> {
  const res = await fetch('/api/gitee-chat/token', { signal })
  if (!res.ok) throw await readError(res)
  return (await res.json()) as TokenStatusResponse
}

/** 设置页里的缓存 / 后台刷新开关（宿主侧 `GET /settings` 的返回）。 */
export interface GiteeSettings {
  cache: { agentReadable: boolean; persist: boolean; ttlSeconds: number }
  autoRefresh: { enabled: boolean; intervalSeconds: number; idleMinutes: number }
}

/** 读当前生效的缓存 / 刷新开关 + 它们落在哪个文件。 */
export async function fetchSettings(signal?: AbortSignal): Promise<{ values: GiteeSettings; path: string }> {
  const res = await fetch('/api/gitee-chat/settings', { signal })
  if (!res.ok) throw await readError(res)
  return (await res.json()) as { values: GiteeSettings; path: string }
}

/** 保存缓存 / 刷新开关（写本地覆盖文件，宿主每次现读 → 点保存即生效）。 */
export async function postSettings(
  patch: { cache?: Partial<GiteeSettings['cache']>; autoRefresh?: Partial<GiteeSettings['autoRefresh']> },
  signal?: AbortSignal,
): Promise<{ values: GiteeSettings; path: string }> {
  let res: Response
  try {
    res = await fetch('/api/gitee-chat/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
      signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new BoardApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!res.ok) throw await readError(res)
  return (await res.json()) as { values: GiteeSettings; path: string }
}

/** 保存企业版 token（写入 ~/.dsh/.gitee-chat/token，取数即时生效、无需重启）。 */
export async function postToken(token: string, signal?: AbortSignal): Promise<{ ok: boolean; path: string }> {
  let res: Response
  try {
    res = await fetch('/api/gitee-chat/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new BoardApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!res.ok) throw await readError(res)
  return (await res.json()) as { ok: boolean; path: string }
}

// ── 企业选择：设置页在配好 token 之后直接选企业 ─────────────────────────────

/** token 可见的一个企业。 */
export interface EnterpriseEntry {
  id: number
  name: string
  path?: string
}

/** 企业列表 + 「现在用的是哪家、为什么是这家」。 */
export interface EnterpriseListResponse {
  ok: boolean
  enterprises: EnterpriseEntry[]
  /** 脚本解析出的当前企业（0 = 未指定）。 */
  current: number
  /** 当前值的来源（本地配置文件 / 插件配置 / 环境变量 / 未指定（自动））。 */
  source: string
  fileEnterpriseId: number
  configPath: string
  /** 插件配置钉住的企业（>0 时这里选不生效）。 */
  pinned: number
  /** 真正生效的企业。 */
  effective: number
}

/** 切换结果。 */
export interface EnterpriseSwitchResponse {
  ok: boolean
  selected: { id: number; name: string } | null
  configPath: string
  pinned: number
  effective: number
  invalidated: string[]
}

/** 列出 token 可见的企业（未配 token 时宿主返回 409）。 */
export async function fetchEnterprises(signal?: AbortSignal): Promise<EnterpriseListResponse> {
  const res = await fetch('/api/gitee-chat/enterprises', { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as EnterpriseListResponse
  if (body?.ok !== true || !Array.isArray(body.enterprises)) {
    throw new BoardApiError('script-failed', '宿主返回了无法解析的企业列表')
  }
  return body
}

/** 切换当前企业（写本地配置 + 失效看板缓存与身份人格，无需重启）。 */
export async function postEnterprise(id: number, signal?: AbortSignal): Promise<EnterpriseSwitchResponse> {
  let res: Response
  try {
    res = await fetch('/api/gitee-chat/enterprise', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
      signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new BoardApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!res.ok) throw await readError(res)
  return (await res.json()) as EnterpriseSwitchResponse
}

// ── F-09 工作项详情 ────────────────────────────────────────────────────────

/**
 * 取工作项详情：描述 / 前置依赖 / 评论讨论。
 * @param ident - 工作项编号（如 DM0001）。
 */
/**
 * 悬停预取：鼠标移到一行工作项上就先把详情拉进宿主缓存（30s TTL），
 * 点下去时直接命中缓存 —— 省掉那一趟「详情 + 评论 + 依赖」的往返。
 * 失败静默：只是预热，不承担错误提示。
 */
export function prefetchIssue(ident: string): void {
  if (ident === '') return
  void fetchIssue(ident).catch(() => { /* 预热失败无所谓，点击时会再拉一次 */ })
}

export async function fetchIssue(ident: string, signal?: AbortSignal): Promise<IssueDetailPayload> {
  const res = await fetch(`/api/gitee-chat/issue?ident=${encodeURIComponent(ident)}`, { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as IssueDetailPayload
  if (body?.ok !== true || body.detail === undefined) {
    throw new BoardApiError('script-failed', '宿主返回了无法解析的工作项详情')
  }
  return body
}

/** 某工作项类型下的可选状态（改状态的选项）。 */
export async function fetchStates(typeId: number, signal?: AbortSignal): Promise<IssueStateRow[]> {
  const res = await fetch(`/api/gitee-chat/states?type=${typeId}`, { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as { ok: boolean; states?: IssueStateRow[] }
  return Array.isArray(body?.states) ? body.states : []
}

/** 项目成员（改派的候选人）。 */
export async function fetchMembers(programId: number, signal?: AbortSignal): Promise<ProgramMemberRow[]> {
  const res = await fetch(`/api/gitee-chat/members?program=${programId}`, { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as { ok: boolean; members?: ProgramMemberRow[] }
  return Array.isArray(body?.members) ? body.members : []
}

// ── G-05 写通道（唯一写入口的服务端一半）──────────────────────────────────

/**
 * 提交一次写操作。
 *
 * 这是 UI 里**唯一**会改动 Gitee 数据的调用；host 侧对应唯一写入口
 * `/api/gitee-chat/write`（见 host/write.ts）。必须带 sessionId——
 * host 用它确认这是 Gitee 模式的会话。
 *
 * @param request - 写请求（op / ident / 载荷 / sessionId）。
 */
export async function postWrite(request: IssueWriteRequest, signal?: AbortSignal): Promise<IssueWriteResult> {
  let res: Response
  try {
    res = await fetch('/api/gitee-chat/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new BoardApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as IssueWriteResult
  if (body?.ok !== true) throw new BoardApiError('script-failed', '宿主返回了无法解析的写结果')
  return body
}

// ── 知识库文档（I 层；见 DOCS.md §8）──────────────────────────────────────
//
// 🔒 `fetchDocs` / `searchDocs` / `fetchDoc` / `fetchDocPage` / `postDocSync`
// 这 5 个**当前没有组件调用**，是有意冻结的（A7 决策见 `host/routes.ts` 里
// 同一组路由上的长注释）：它们服务的是本企业**一篇都没有**的 WikiInfo 形态。
//
// 这些调用**不自己拼 Gitee 端点**：host 路由会把它们全部委派给 MCP 工具。
// 客户端只需要知道"要什么"，不需要知道"端点长什么样"。

/** 文档视图里"当前项目"的定位信息（首次落盘要用它算缓存目录）。 */
export interface DocHint {
  programId: number | null
  name: string
}

/** 把 hint 拼成查询串片段。 */
function hintQuery(hint?: DocHint): string {
  if (hint === undefined) return ''
  const q = new URLSearchParams()
  if (hint.programId !== null && hint.programId > 0) q.set('program', String(hint.programId))
  if (hint.name !== '') q.set('name', hint.name)
  const s = q.toString()
  return s === '' ? '' : `&${s}`
}

/**
 * 列知识库**节点树**的一层（本企业知识库的真实入口）。
 *
 * 与 `fetchDocs`（WikiInfo 文档）的区别：本企业知识库是
 * `DocDirectory` + `AttachFile` 的树，`fetchDocs` 那条路恒为 0。
 *
 * @param sessionId - 会话 id。
 * @param programId - null = 企业级公共知识库；否则是该项目的知识库。
 * @param parentId - 父节点 id（0 = 该范围顶层）。
 */
export async function fetchDocNodes(sessionId: string, programId: number | null, parentId = 0, signal?: AbortSignal): Promise<DocTreeResponse> {
  const q = new URLSearchParams({ sessionId, parentId: String(parentId) })
  if (programId !== null && programId > 0) q.set('program', String(programId))
  const res = await fetch(`/api/gitee-chat/doc/nodes?${q.toString()}`, { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as DocTreeResponse
  if (body?.ok !== true) throw new BoardApiError('script-failed', '宿主返回了无法解析的知识库节点')
  return body
}

/**
 * 读一个**附件节点**的内容（本企业知识库真正能读的那条路）。
 *
 * host 会委派 MCP 的 `download_attach_file` 把文件写进缓存根，再把文本读回来。
 * @param nodeId - 节点 id。
 * @param fileId - 附件内容 id（**不是**节点 id）。
 */
export async function fetchDocAttachment(
  sessionId: string,
  input: {
    nodeId: number
    fileId: number
    name: string
    programId: number | null
    /** 节点当前的远端事实（来自列表）—— 让宿主能判"本地这份还新不新"。 */
    updatedAt?: string
    /** 节点当前的 `attach_file.size`（0 = 未知）。 */
    size?: number
    /** 忽略本地缓存强制重下。 */
    refresh?: boolean
  },
  signal?: AbortSignal,
): Promise<DocAttachmentResponse> {
  const q = new URLSearchParams({ sessionId, nodeId: String(input.nodeId), fileId: String(input.fileId), name: input.name })
  if (input.programId !== null && input.programId > 0) q.set('program', String(input.programId))
  if (input.updatedAt !== undefined && input.updatedAt !== '') q.set('updatedAt', input.updatedAt)
  if (input.size !== undefined && input.size > 0) q.set('size', String(input.size))
  if (input.refresh === true) q.set('refresh', '1')
  const res = await fetch(`/api/gitee-chat/doc/attachment?${q.toString()}`, { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as DocAttachmentResponse
  if (body?.ok !== true) throw new BoardApiError('script-failed', '宿主返回了无法解析的附件内容')
  return body
}

/**
 * 列仓库（**J 层**）。
 *
 * 两种口径（host 侧决定，见 DOCS.md §14）：
 *   - `programId` 给了 → 该项目下的仓库；
 *   - 没给 → 只列**企业内部开源**的仓库。
 * @param sessionId - 会话 id（host 用它解析 agent 作用域）。
 * @param programId - null = 不限定项目口径。
 * @param programName - 项目名（host 回填到提示语里）。
 */
export async function fetchRepos(sessionId: string, programId: number | null, programName = '', signal?: AbortSignal): Promise<RepoListResponse> {
  const q = new URLSearchParams({ sessionId })
  if (programId !== null && programId > 0) q.set('program', String(programId))
  if (programName !== '') q.set('name', programName)
  const res = await fetch(`/api/gitee-chat/doc/repos?${q.toString()}`, { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as RepoListResponse
  if (body?.ok !== true) throw new BoardApiError('script-failed', '宿主返回了无法解析的仓库列表')
  return body
}

/**
 * 列一个仓库的分支（新建 PR 时选源/目标分支）。
 *
 * 走宿主 `GET /repo/branches` → `gq branches` → 企业版 `/{eid}/projects/{repoId}/branches`。
 * MCP 没有「列分支」工具，所以这条是宿主自己的通道；失败时调用方回退成手填输入框。
 */
export async function fetchRepoBranches(sessionId: string, repoId: number, signal?: AbortSignal): Promise<RepoBranchesResponse> {
  const q = new URLSearchParams({ sessionId, repoId: String(repoId) })
  const res = await fetch(`/api/gitee-chat/repo/branches?${q.toString()}`, { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as RepoBranchesResponse
  if (body?.ok !== true) throw new BoardApiError('script-failed', '宿主返回了无法解析的分支列表')
  return body
}

/**
 * 取一个仓库的 WIKI 文件树。
 *
 * ⚠️ 这一条**不是** MCP 提供的：Gitee 没有列仓库 WIKI 的 HTTP 接口，
 * host 走的是 git 克隆 `{path_with_namespace}.wiki.git`（DOCS.md §14.1）。
 * @param repoId - 仓库 id。
 * @param repoPath - `path_with_namespace`（**不是 name**，两者经常不同）。
 * @param refresh - true = 强制 fetch 远端。
 */
export async function fetchWiki(
  sessionId: string,
  repo: { repoId: number; repoPath: string; repoName: string },
  refresh = false,
  signal?: AbortSignal,
): Promise<WikiTreeResponse> {
  const q = new URLSearchParams({ sessionId, repoId: String(repo.repoId), repoPath: repo.repoPath, repoName: repo.repoName })
  if (refresh) q.set('refresh', '1')
  const res = await fetch(`/api/gitee-chat/doc/wiki?${q.toString()}`, { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as WikiTreeResponse
  if (body?.ok !== true) throw new BoardApiError('script-failed', '宿主返回了无法解析的 WIKI 结构')
  return body
}

/**
 * 读 WIKI 里的一页正文。
 * @param path - 相对 WIKI 根目录的路径。
 */
export async function fetchWikiPage(
  sessionId: string,
  repo: { repoId: number; repoPath: string; repoName: string },
  path: string,
  signal?: AbortSignal,
): Promise<WikiPageResponse> {
  const q = new URLSearchParams({ sessionId, repoId: String(repo.repoId), repoPath: repo.repoPath, repoName: repo.repoName, path })
  const res = await fetch(`/api/gitee-chat/doc/wiki/page?${q.toString()}`, { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as WikiPageResponse
  if (body?.ok !== true) throw new BoardApiError('script-failed', '宿主返回了无法解析的 WIKI 正文')
  return body
}

// ── 缓存管理（A2）────────────────────────────────────────────────────────
//
// 这两条**不经过 MCP**：管的是插件本地的缓存，与 Gitee 无关。

/** 缓存用量响应。 */
export interface CacheInfoResponse {
  ok: true
  cacheRoot: string
  attachments: { count: number; bytes: number }
  wikis: { count: number; bytes: number }
  truncated: boolean
  /** 当前范围的目录（`pj-<id>/` 或 `_common/`）。 */
  scopeDir: string
}

/** 清缓存响应。 */
export interface CacheForgetResponse {
  ok: true
  target: 'attachment' | 'scope'
  /** false = 本来就没缓存（不是错误）。 */
  removed: boolean
  dir: string
}

/**
 * 看缓存用量（附件与仓库 WIKI 分开报）。
 * @param sessionId - 会话 id（与其他文档路由保持一致）。
 * @param programId - 用来算"当前范围"的目录。
 */
export async function fetchCacheInfo(sessionId: string, programId: number | null, signal?: AbortSignal): Promise<CacheInfoResponse> {
  const q = new URLSearchParams({ sessionId })
  if (programId !== null && programId > 0) q.set('program', String(programId))
  const res = await fetch(`/api/gitee-chat/doc/cache?${q.toString()}`, { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as CacheInfoResponse
  if (body?.ok !== true) throw new BoardApiError('script-failed', '宿主返回了无法解析的缓存信息')
  return body
}

/**
 * 清缓存。**安全动作**：缓存是"读过才在"的副本，删了只让下次点击重新下载。
 * @param target - `attachment` 清一个节点；`scope` 清一个项目/企业级公共的全部附件。
 */
export async function forgetCache(
  sessionId: string,
  target: { kind: 'attachment'; nodeId: number; name: string; programId: number | null }
    | { kind: 'scope'; programId: number | null },
  signal?: AbortSignal,
): Promise<CacheForgetResponse> {
  const body = target.kind === 'attachment'
    ? { sessionId, target: 'attachment', nodeId: target.nodeId, name: target.name, programId: target.programId }
    : { sessionId, target: 'scope', programId: target.programId }
  const res = await fetch('/api/gitee-chat/doc/cache/forget', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) throw await readError(res)
  const out = (await res.json()) as CacheForgetResponse
  if (out?.ok !== true) throw new BoardApiError('script-failed', '宿主返回了无法解析的清缓存结果')
  return out
}

/**
 * 列出知识库文档（**WikiInfo 形态**）。
 *
 * ⚠️ 本企业暂未使用这种形态，实测为 0 篇 —— 界面请用 `fetchDocNodes`。
 * @param sessionId - 会话 id（host 用它解析 agent 作用域）。
 * @param programId - null = 企业级公共文档；否则是该项目的文档。
 */
export async function fetchDocs(sessionId: string, programId: number | null, signal?: AbortSignal): Promise<DocListResponse> {
  const q = new URLSearchParams({ sessionId })
  if (programId !== null && programId > 0) q.set('program', String(programId))
  const res = await fetch(`/api/gitee-chat/docs?${q.toString()}`, { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as DocListResponse
  if (body?.ok !== true) throw new BoardApiError('script-failed', '宿主返回了无法解析的文档列表')
  return body
}

/**
 * 企业级关键词搜索（**不能按项目过滤** —— MCP 的硬限制）。
 * @param sessionId - 会话 id。
 * @param query - 关键词。
 */
export async function searchDocs(sessionId: string, query: string, signal?: AbortSignal): Promise<DocSearchResponse> {
  const q = new URLSearchParams({ sessionId, q: query })
  const res = await fetch(`/api/gitee-chat/docs/search?${q.toString()}`, { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as DocSearchResponse
  if (body?.ok !== true) throw new BoardApiError('script-failed', '宿主返回了无法解析的搜索结果')
  return body
}

/** 取文档详情：页树 + 每页的本地四态 + 待拉页。 */
export async function fetchDoc(sessionId: string, documentId: number, hint?: DocHint, signal?: AbortSignal): Promise<DocDetailResponse> {
  const res = await fetch(`/api/gitee-chat/doc?sessionId=${encodeURIComponent(sessionId)}&documentId=${documentId}${hintQuery(hint)}`, { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as DocDetailResponse
  if (body?.ok !== true) throw new BoardApiError('script-failed', '宿主返回了无法解析的文档详情')
  return body
}

/** 取一页正文（本地优先，不一致时才走 MCP）。 */
export async function fetchDocPage(sessionId: string, documentId: number, pageId: number, hint?: DocHint, signal?: AbortSignal): Promise<DocPageResponse> {
  const res = await fetch(`/api/gitee-chat/doc/page?sessionId=${encodeURIComponent(sessionId)}&documentId=${documentId}&pageId=${pageId}${hintQuery(hint)}`, { signal })
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as DocPageResponse
  if (body?.ok !== true) throw new BoardApiError('script-failed', '宿主返回了无法解析的文档正文')
  return body
}

/**
 * 核对 / 拉取变更。
 * @param mode - `check` 只报告差异；`pull` 逐页拉取（本地已改的页永不覆盖）。
 */
export async function postDocSync(sessionId: string, documentId: number, mode: 'check' | 'pull', hint?: DocHint, signal?: AbortSignal): Promise<DocSyncResponse> {
  let res: Response
  try {
    res = await fetch('/api/gitee-chat/doc/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, documentId, mode, program: hint?.programId ?? null, name: hint?.name ?? '' }),
      signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new BoardApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!res.ok) throw await readError(res)
  const body = (await res.json()) as DocSyncResponse
  if (body?.ok !== true) throw new BoardApiError('script-failed', '宿主返回了无法解析的核对结果')
  return body
}

export type { DocListResponse, DocDetailResponse, DocPageResponse, DocSyncResponse, DocSearchResponse }
