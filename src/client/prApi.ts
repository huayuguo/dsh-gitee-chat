/**
 * 0.5.4 合并请求（PR）取数层 —— 全部走宿主路由 `/api/gitee-chat/pr/*`。
 *
 * 与 `api.ts` 同一套约定（网络错误→可判定的 Error；HTTP 非 2xx→读错误信封；
 * `ok !== true`→坏响应），单独成文件是为了不改动 `api.ts` 那份 0.4.x 的取数接口。
 *
 * 契约见 `docs/design/0.5.4-api.md`：响应是**扁平信封** `{ok:true, ...}`（不是 `{ok:true,data}`），
 * 失败是 `{ok:false, code, message, hint}`（`hint` 是给使用者看的一句话下一步，必须显示）。
 *
 * @module dsh-gitee-chat/client/prApi
 */

import type {
  PrActionRequest,
  PrAiReviewRequest,
  PrCounts,
  PrCreateRequest,
  PrCreateResult,
  PrDetail,
  PrListResponse,
  PrState,
  PrSummary,
  PrTemplateMeta,
  PrTemplatesResponse,
} from '../types.ts'

/** 宿主路由前缀。 */
const PREFIX = '/api/gitee-chat'

/** 列表视角（「待我审核 / 待我测试 / 我提出的 / 全部」）。 */
export type PrScope = 'assign' | 'test' | 'create' | 'all'

/** 列表状态筛选。 */
export type PrStateFilter = PrState | 'all'

/** 列表查询参数。 */
export interface PrListQuery {
  scope: PrScope
  state: PrStateFilter
  repoId?: number
  q?: string
  page?: number
}

/** `POST /pr/ai-review` 的成功响应：宿主返回**完整 prompt**，投递由客户端做。 */
export interface PrAiReviewPrompt {
  dispatched: boolean
  prompt: string
  preview: string
  autoApprove: boolean
}

/** PR 路由的错误：带上 `code` 与 `hint`，界面必须把 hint 显示出来。 */
export class PrApiError extends Error {
  readonly code: string
  readonly hint: string

  /**
   * @param code - 机器可判定的错误码（`not-reviewer` / `already-reviewed` / `no-token` …）。
   * @param message - 主文案（一句话说清「什么没成」）。
   * @param hint - 下一步建议（可以空）。
   */
  constructor(code: string, message: string, hint = '') {
    super(message)
    this.name = 'PrApiError'
    this.code = code
    this.hint = hint
  }
}

/** 从任意异常里取出「主文案 + 下一步」，界面统一用这个渲染错误。 */
export function explainError(error: unknown): { message: string; hint: string; code: string } {
  if (error instanceof PrApiError) {
    return { message: error.message, hint: error.hint, code: error.code }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { message, hint: '', code: 'unknown' }
}

/** 读失败信封（HTTP 非 2xx 也可能带 JSON 错误体）。 */
async function readFailure(res: Response): Promise<PrApiError> {
  let body: { code?: unknown; message?: unknown; hint?: unknown } | null = null
  try {
    body = (await res.json()) as { code?: unknown; message?: unknown; hint?: unknown }
  } catch {
    body = null
  }
  const code = typeof body?.code === 'string' ? body.code : 'script-failed'
  const message = typeof body?.message === 'string' ? body.message : `宿主返回 HTTP ${res.status}（没有错误说明）`
  const hint = typeof body?.hint === 'string' ? body.hint : ''
  return new PrApiError(code, message, hint)
}

/** 统一的 fetch：网络异常 / 非 2xx / 坏信封 三类都变成 `PrApiError`。 */
async function request<T extends { ok: true }>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${PREFIX}${path}`, { ...init, signal })
  } catch (error) {
    if ((error as Error | undefined)?.name === 'AbortError') throw error
    throw new PrApiError(
      'network',
      '连不上宿主：页面可能刚重载，或宿主进程已退出。',
      '先刷新页面；仍然失败就看宿主日志（这条路由由宿主插件提供）。',
    )
  }
  if (!res.ok) throw await readFailure(res)
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  const envelope = body as { ok?: unknown; code?: unknown; message?: unknown; hint?: unknown } | null
  if (envelope === null || envelope.ok !== true) {
    const code = typeof envelope?.code === 'string' ? envelope.code : 'script-failed'
    const message = typeof envelope?.message === 'string' ? envelope.message : '宿主返回了无法解析的合并请求数据。'
    const hint = typeof envelope?.hint === 'string' ? envelope.hint : ''
    throw new PrApiError(code, message, hint)
  }
  return body as T
}

/**
 * 会话 id 只是**审计/投递用途**，取数不再依赖它。
 *
 * 0.5.4 起宿主有进程级 MCP 直连通道（`host/mcpDocs.ts` 的 `deps.direct`），
 * 任何模式的会话都能读 PR —— 用户 2026-10-26 口径。
 * 所以这里空串照发，由宿主按需忽略。
 * @param sessionId - 槽位给的会话 id（可能为空）。
 * @returns 原样返回（空串也可以）。
 */
function sessionParam(sessionId: string): string {
  return typeof sessionId === 'string' ? sessionId : ''
}

/**
 * 取 PR 列表 + 四张分类卡的全局计数。
 * @param sessionId - 会话 id（宿主据此取 token / 企业）。
 * @param query - 视角 / 状态 / 仓库 / 搜索 / 页码。
 * @param signal - 取消信号。
 */
export async function fetchPrList(
  sessionId: string,
  query: PrListQuery,
  signal?: AbortSignal,
): Promise<PrListResponse> {
  const params = new URLSearchParams({ sessionId: sessionParam(sessionId), scope: query.scope, state: query.state })
  if (query.repoId !== undefined && query.repoId > 0) params.set('repoId', String(query.repoId))
  if (query.q !== undefined && query.q.trim() !== '') params.set('q', query.q.trim())
  if (query.page !== undefined && query.page > 1) params.set('page', String(query.page))
  return await request<PrListResponse & { ok: true }>(`/pr/list?${params.toString()}`, { headers: { accept: 'application/json' } }, signal)
}

/** 取单个 PR 详情（含权限、文件、评论）。 */
export async function fetchPrDetail(
  sessionId: string,
  repoId: number,
  iid: number,
  signal?: AbortSignal,
): Promise<PrDetail> {
  const params = new URLSearchParams({ sessionId: sessionParam(sessionId), repoId: String(repoId), iid: String(iid) })
  const body = await request<{ ok: true; detail: PrDetail }>(`/pr/detail?${params.toString()}`, { headers: { accept: 'application/json' } }, signal)
  return body.detail
}

/** 执行一个写动作（审核 / 测试 / 合并 / 评论 / 关闭 / 开启流程），返回动作后的最新详情。 */
export async function postPrAction(
  sessionId: string,
  action: PrActionRequest,
  signal?: AbortSignal,
): Promise<PrDetail> {
  const body = await request<{ ok: true; detail: PrDetail }>(
    '/pr/action',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sessionId: sessionParam(sessionId), ...action }),
    },
    signal,
  )
  return body.detail
}

/**
 * 建 PR（UI 手动路径）。
 *
 * 与 agent 直接调 MCP `create_enterprise_repo_pull` 等价 —— 两条路的差别只在
 * 「谁填参数」，Gitee 侧的校验、审查/测试人数、草稿状态完全一样。
 */
export async function createPull(
  sessionId: string,
  input: PrCreateRequest,
  signal?: AbortSignal,
): Promise<PrCreateResult> {
  const body = await request<{ ok: true; result: PrCreateResult }>(
    '/pr/create',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sessionId: sessionParam(sessionId), ...input }),
    },
    signal,
  )
  return body.result
}

/** 取当前生效的审核模板（仓库级覆盖优先）。 */
export async function fetchPrTemplates(repoPath?: string | null, signal?: AbortSignal): Promise<PrTemplatesResponse> {  const params = new URLSearchParams()
  if (typeof repoPath === 'string' && repoPath !== '') params.set('repoPath', repoPath)
  const suffix = params.toString()
  return await request<PrTemplatesResponse & { ok: true }>(`/pr/templates${suffix === '' ? '' : `?${suffix}`}`, { headers: { accept: 'application/json' } }, signal)
}

/**
 * 渲染 AI 审核 prompt（**不发送**）。
 *
 * 契约：宿主只渲染，投递由客户端用 `ctx.conversation.send` 做，这样「谁发出的消息」
 * 与会话作用域不会错位。返回里的 `prompt` 是完整文本（`preview` 只是前 600 字）。
 */
export async function postPrAiReview(
  sessionId: string,
  request_: PrAiReviewRequest,
  signal?: AbortSignal,
): Promise<PrAiReviewPrompt> {
  return await request<PrAiReviewPrompt & { ok: true }>(
    '/pr/ai-review',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sessionId: sessionParam(sessionId), ...request_ }),
    },
    signal,
  )
}

/** 子智能体跑批快照（宿主 `/pr/ai-review/subagent` 的返回）。 */
export interface PrAiRun {
  runId: string
  childId: string
  status: 'running' | 'done' | 'failed'
  /** 子智能体最终回答（Markdown，可直接当评论正文）。 */
  text: string
  stopReason: string
  error: string
  createdAt: number
  finishedAt: number | null
}

/**
 * 把 AI 审核交给**所选主会话下的子智能体**执行（0.5.4）。
 *
 * 与 `postPrAiReview` 的区别：那个只渲染 prompt、由页面把消息塞进会话；
 * 这个让宿主在目标会话下起子智能体跑，不污染会话对话（用户口径 2026-10-26）。
 */
export async function startPrAiRun(
  sessionId: string,
  request_: PrAiReviewRequest,
  signal?: AbortSignal,
  deliver?: 'session',
): Promise<{ runId: string; childId: string; prompt: string }> {
  return await request<{ ok: true; runId: string; childId: string; prompt: string }>(
    '/pr/ai-review/subagent',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sessionId: sessionParam(sessionId),
        ...request_,
        ...(deliver === undefined ? {} : { deliver }),
      }),
    },
    signal,
  )
}

/**
 * AI 起草 PR 标题与描述。
 *
 * 宿主先抓 `compare`（源 vs 目标分支的真实提交与文件差异）+ `pr-guide` 模板拼 prompt，
 * 再在所选主会话下起子智能体；返回的 `runId` 用 `fetchPrAiRun` 轮询。
 */
export async function startPrDraft(
  sessionId: string,
  input: {
    repoId: number
    repoPath?: string
    sourceBranch: string
    targetBranch: string
    /** `session` = 结论同时投进所选主会话（人看得见），也照样回填表单。 */
    deliver?: 'subagent' | 'session'
  },
  signal?: AbortSignal,
): Promise<{ runId: string; childId: string; prompt: string; commits: number; files: number; source: 'local' | 'remote' }> {
  return await request<{ ok: true; runId: string; childId: string; prompt: string; commits: number; files: number; source: 'local' | 'remote' }>(
    '/pr/draft',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sessionId: sessionParam(sessionId), ...input }),
    },
    signal,
  )
}

/** 轮询子智能体跑批状态。 */
export async function fetchPrAiRun(runId: string, signal?: AbortSignal): Promise<PrAiRun | null> {
  const body = await request<{ ok: true; run: PrAiRun }>(
    `/pr/ai-review/subagent?runId=${encodeURIComponent(runId)}`,
    { method: 'GET', headers: { accept: 'application/json' } },
    signal,
  )
  return body.run ?? null
}

/** 取消跑批。 */
export async function cancelPrAiRun(runId: string, signal?: AbortSignal): Promise<void> {
  await request<{ ok: true }>(
    '/pr/ai-review/subagent/cancel',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ runId }),
    },
    signal,
  )
}

/**
 * 保存一份模板（用户副本）；给了 `repoPath` + `kind` 就同时只绑那一份。
 *
 * 为什么要 kind：审核模板与测试模板是两份文档，绑一个不该覆盖另一个
 * （宿主 `templateBindings[repoPath]` 支持 `{review, test}` 分开写）。
 */
export async function savePrTemplate(
  input: { name: string; content: string; repoPath?: string | null; kind?: 'review' | 'test' },
  signal?: AbortSignal,
): Promise<PrTemplateMeta> {
  const body = await request<{ ok: true; item: PrTemplateMeta }>(
    '/pr/templates',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
    },
    signal,
  )
  return body.item
}

/** 活着的会话（供「AI 审核投递到哪个会话」选择）。 */
export interface SessionChoice {
  id: string
  title: string
  cwd: string
  preset: string | null
  /** 会话归属的工作区 id（DSH workspace 记录）；没有归属时为 null。 */
  workspaceId?: string | null
  /** 工作区显示名（DSH 记录的标题，不是目录路径）。 */
  workspaceTitle?: string
}

/**
 * 下拉里显示的会话名：**前 12 个字**（用户口径），英文按字算，不够就有多少显示多少；
 * 没标题的会话退化成 `未命名会话 · 后 6 位 id`，避免一堆同名空项。
 * @param item - 会话清单一项。
 * @returns 展示用短名。
 */
export function sessionLabel(item: SessionChoice): string {
  const raw = item.title.trim()
  if (raw === '') return `未命名会话 · ${item.id.slice(-6)}`
  const chars = Array.from(raw)
  return chars.length <= 12 ? raw : `${chars.slice(0, 12).join('')}…`
}

/**
 * 列出活着的会话。
 *
 * 用途：PR 可能属于不同仓库、不同工作区，AI 审核的 prompt 该投到哪个会话
 * 由使用者决定（默认当前会话）。取不到就返回空数组，界面只显示「当前会话」。
 * @param signal - 取消信号。
 * @returns 会话清单（id / 标题 / 工作区 / preset）。
 */
export async function fetchSessions(signal?: AbortSignal): Promise<SessionChoice[]> {
  const body = await request<{ ok: true; items: SessionChoice[] }>('/sessions', { headers: { accept: 'application/json' } }, signal)
  return Array.isArray(body.items) ? body.items : []
}

/** 四张分类卡的数字（未取到时给全 0，避免界面写 `undefined`）。 */
export function emptyCounts(): PrCounts {
  return { review: 0, test: 0, mine: 0, mergeable: 0 }
}

/** 列表行是否「等我审」（口径与宿主 counts.review 一致：打开 + 待审查 + 有审查人）。 */
export function pendingReview(pr: PrSummary): boolean {
  return pr.state === 'opened' && pr.checkState === 1 && pr.prAssignNum > 0
}

/** 列表行是否「等我测」（口径与宿主 counts.test 一致）。 */
export function pendingTest(pr: PrSummary): boolean {
  return pr.state === 'opened' && pr.testState === 1 && pr.prTestNum > 0
}

/** 记住的 AI 起草投递目标（按仓库）。 */
export interface DraftTargetRecord {
  sessionId: string
  sessionTitle: string
  workspaceTitle: string
  /** 勾选「子智能体」的状态：与工作区/会话一起按仓库记住。 */
  deliverSubagent: boolean
  at: string
}

/**
 * 读某仓库记住的起草投递目标。
 *
 * 为什么按仓库：同项目的仓库可能分属不同工作区，而工作区之间权限边界是硬的，
 * 起草必须投到「那个仓库有本地上下文」的会话里。配一次之后自动带出。
 */
export async function fetchDraftTarget(repoKey: string, signal?: AbortSignal): Promise<DraftTargetRecord | null> {
  const body = await request<{ ok: true; target: DraftTargetRecord | null }>(
    `/draft-target?repo=${encodeURIComponent(repoKey)}`,
    { method: 'GET', headers: { accept: 'application/json' } },
    signal,
  )
  return body.target ?? null
}

/** 记住 / 清除某仓库的起草投递目标。 */
export async function saveDraftTarget(
  repoKey: string,
  target: { sessionId: string; sessionTitle: string; workspaceTitle: string; deliverSubagent: boolean } | null,
  signal?: AbortSignal,
): Promise<DraftTargetRecord | null> {
  const body = await request<{ ok: true; target: DraftTargetRecord | null }>(
    '/draft-target',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(target === null ? { repo: repoKey, clear: true } : { repo: repoKey, ...target }),
    },
    signal,
  )
  return body.target ?? null
}
