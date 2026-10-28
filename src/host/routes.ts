/**
 * 卡片数据通道：/api/gitee-chat/* 。
 *
 * 这条路由是「模型只触发、数据由后台灌」的那一半——卡片拿工具调用的参数
 * 来这里取**完整**结构化 payload，全程不经过模型上下文。
 *
 * 路由表（prefix = /api/gitee-chat）：
 *   POST /payload   body {scope?, program?, refresh?} → PayloadResponse | ErrorResponse
 *   GET  /session?sessionId=                          → 这个会话是不是 Gitee 模式
 *   GET  /issues?program=&state=                      → 单项目工作项清单
 *   GET  /issue?ident=                                → 工作项详情（描述/前置依赖/评论）
 *   GET  /states?type=                                → 某类型下可选状态（改状态用）
 *   GET  /members?program=                            → 项目成员（改派用）
 *   POST /write     body {op, ident, …}                → 唯一写入口（改状态/评论/改派/文档页）
 *   GET  /health                                      → HealthResponse
 *   GET  /enterprises | POST /enterprise              → 企业列表 / 切换
 *   GET  /token | POST /token body {token}            → token 状态 / 写入 ~/.dsh/.gitee-chat/token
 *   GET  /preview                                     → 卡片静态预览
 *   GET  /ping                                        → { ok, version, scriptExists, mcp, docs }
 *   GET  /docs?sessionId=&program=                     → 知识库文档列表（委派 MCP）
 *   GET  /docs/search?sessionId=&q=                    → 企业级关键词搜索（不能按项目过滤）
 *   GET  /doc?sessionId=&documentId=                   → 页树 + 本地四态
 *   GET  /doc/page?sessionId=&documentId=&pageId=      → 单页正文（本地优先）
 *   POST /doc/sync  body {sessionId, documentId, mode} → 核对 / 拉取变更
 *   GET  /doc/nodes?sessionId=&program=&parentId=      → 知识库节点树（本企业真实形态）
 *   GET  /doc/attachment?sessionId=&nodeId=&fileId=    → 读附件内容（委派 MCP 下载）
 *   GET  /doc/repos?sessionId=&program=                → 仓库列表（委派 MCP）
 *   GET  /doc/wiki?sessionId=&repoId=&repoPath=        → 仓库 WIKI 文件树（git 克隆）
 *   GET  /doc/wiki/page?sessionId=&repoId=&path=       → WIKI 一页正文
 *   GET  /doc/cache?sessionId=&program=                → 缓存用量（附件 / 仓库 WIKI 分开报）
 *   POST /doc/cache/forget body {sessionId,target,…}   → 清缓存（单个附件 / 一个范围）
 *
 * 知识库文档那几条路由**不自己拼 Gitee 端点**：它们全部经
 * `host/mcp-docs` 委派 MCP 工具（`DOCS.md` §7 的纪律）。
 * **唯一的例外**是仓库 WIKI 的正文：Gitee 没有任何 HTTP 接口能列它
 * （实测企业 API 全 404、开放 API 是 405），只有 git 形态
 * `{path_with_namespace}.wiki.git` —— 见 `host/wikiCache.ts` 与 `DOCS.md` §14.1。
 * `sessionId` 是必带参数 —— 它是拿到 agent 作用域的唯一钥匙。
 *
 * 每个请求都过与 /api 网关同款的 browser-trust fence（loopback 或部署的
 * trustedHosts，且同源）。这是 DNS-rebinding / 跨站防御，不是认证。
 *
 * **写路由不再按会话 preset 放行**（0.5.4 起，用户口径：「任何模式都可以」）——
 * 这条路由挂在 profile 层，浏览器只要在 loopback 就能打到；能不能写由 token 角色
 * 与 `hostConfig.allowWrites` 决定，`sessionId` 只留作审计与文档写的作用域。
 *
 * @module dsh-gitee-chat/host/routes
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, dirname } from 'node:path'
import { isTrustedApiRequest } from './trust-fence.ts'
import { TOKEN_ENVS, tokenFilePath } from './token.ts'
import { GqError, packageRoot, type GqRunner } from './gq.ts'
import { DocError } from './mcpDocs.ts'
import type { DocService } from './docService.ts'
import type { RepoService } from './repoService.ts'
import { WriteError, type IssueWriter } from './write.ts'
import { PrError, type PrService } from './prService.ts'
import type { PrActionRequest, PrAiReviewRequest, PrCreateRequest } from '../types.ts'
import { listEnterprises, switchEnterprise } from './enterprise.ts'
import type { RoleResolver } from './role.ts'
import type { DraftTarget, ResolvedSettings, SettingsPatch } from './localSettings.ts'
import type { McpInspection } from './mcpBinary.ts'
import type {
  BoardScope,
  ErrorResponse,
  IssueCreateRequest,
  IssueWriteRequest,
  PayloadResponse,
} from '../types.ts'
import { createTtlCache } from './ttlCache.ts'

/** 路由前缀（webServer 以 prefix 注册，内部按 pathname 分派）。 */
export const ROUTE_PREFIX = '/api/gitee-chat'

/**
 * 读路由的短 TTL 缓存（见 host/ttlCache.ts）。
 *
 * 打开一次项目面板会连打 /payload、/issues、/repo/issues、/pr/list 四个路由，
 * 每个都是「起 node 子进程 + HTTPS 往返」。30s 内重复点开同一个项目直接命中，
 * 并发打开两个面板也只拉一次。写操作**不**走这里（合并在下面各 POST 分支）。
 */
const readCache = createTtlCache({ ttlMs: 30_000, maxEntries: 300 })

/** 按「路径 + 查询串（去掉 refresh）」做缓存键。 */
function cachedRead<T>(url: URL, fn: () => Promise<T>): Promise<T> {
  if (url.searchParams.get('refresh') === '1') return fn()
  const params = new URLSearchParams(url.searchParams)
  params.delete('refresh')
  const key = `${url.pathname}?${params.toString()}`
  return readCache.wrap(key, fn)
}

/**
 * 写成功后清掉两层读缓存（路由级 30s TTL + 执行器 60s memo）。
 *
 * 为什么必须有：写完界面会立刻重拉一次，若还命中缓存就显示**旧数据**——
 * 用户看到的就是「点了新建/评论，页面刷一下但内容没变」（用户口径 m01634 ③
 * 「有更新的需要拉取信息的页面都会刷新重新获取，效果类似卡顿」）。
 * 清完让这一次重拉真的去 Gitee 取；不清的话再点一次才是新的。
 *
 * @param deps - 路由依赖（执行器可能没有 clear 实现）
 */
function invalidateReadCaches(deps: RouteDeps): void {
  readCache.clear()
  const runner = deps.runner as { clear?: () => void }
  if (typeof runner.clear === 'function') runner.clear()
}

/** 路由依赖。 */
export interface RouteDeps {
  readonly runner: GqRunner
  /**
   * 判定一个会话是否跑在 Gitee 模式上。
   * 返回 `true/false`，未知时返回 `undefined`（视图据此决定展示还是提示）。
   */
  readonly isGiteeSession: (sessionId: string) => Promise<boolean | undefined>
  /** 该会话的 preset id（未知为 null），用于诊断。 */
  readonly presetOf: (sessionId: string) => string | null
  /**
   * 列出**活着的**会话（id / 标题 / 工作区 / preset），给「AI 审核投递到哪个会话」用。
   *
   * 用户 2026-10-26 口径：PR 可能属于不同仓库、不同工作区，投递目标要能选，
   * 默认当前会话但允许改。
   */
  /** 临时诊断：返回宿主 agent preset 服务的原始返回（排查「预设没出现」用）。 */
  readonly debugPresets?: () => unknown | Promise<unknown>
  /** 临时诊断：探测宿主服务是否可用（子智能体投递要用 subagents/agents）。 */
  readonly debugServices?: () => unknown | Promise<unknown>
  readonly listSessions?: () => Array<{
    id: string
    title: string
    cwd: string
    preset: string | null
    /** 工作区（DSH 的 workspace 记录）；没有归属时为 null。AI 审核弹窗按它分组。 */
    workspaceId: string | null
    workspaceTitle: string
  }>
  /**
   * 缓存 / 后台刷新的本地覆盖（「设置 → Gitee 企业项目」里那几个开关）。
   *
   * 缺省时设置路由返回 501：旧调用点不该因为少这个依赖就崩。
   */
  readonly settings?: {
    /** 生效值（本地覆盖 + 静态配置合并后的结果）。 */
    resolve: () => ResolvedSettings
    /** 写覆盖并返回新的生效值。 */
    write: (patch: SettingsPatch) => ResolvedSettings
    /** 配置文件路径（展示给使用者看）。 */
    path: string
    /** 取某仓库记住的 AI 起草投递目标（没记过返回 undefined）。 */
    getDraftTarget: (repoKey: string) => DraftTarget | undefined
    /** 记住 / 清除某仓库的起草投递目标。 */
    setDraftTarget: (repoKey: string, target: DraftTarget | null) => DraftTarget | undefined
  }
  /** 身份/人格解析器（/role 直接读缓存，不触发新的脚本执行）。 */
  readonly role: RoleResolver
  /** **唯一写入口**（改状态 / 评论 / 改派）。 */
  readonly writer: IssueWriter
  /** 当前部署的可信 authority 列表（`webStartup.trustedHosts` + `--public-url` + 环境变量；缺失时只用 loopback）。 */
  readonly trustedHosts: () => readonly string[]
  readonly version: string
  /**
   * 只读部署开关（`hostConfig.allowWrites`）。
   *
   * 0.5.4 起面板写路由也受它约束：`allowWrites=false` 时 `/write`、`/issue-create`、
   * `/pr/create`、`/pr/action` 一律 403 `read-only`，不把"只读"做成一句口号。
   * 省略时按「可写」处理（老调用方不受影响）。
   */
  readonly allowWrites?: () => boolean
  /**
   * 随包 MCP 后端的只读状态（供 /ping 与 /health 诊断）。
   * 必须只读：GET 不该有副作用，落地动作在装配期做。
   */
  readonly mcp: () => McpInspection
  /**
   * 知识库文档服务（编排层）。
   *
   * 路由只调它的方法，**不自己拼 Gitee 文档端点** —— 文档能力的唯一实现是 MCP，
   * 见 `DOCS.md` §7。
   */
  readonly docs: DocService
  /**
   * 仓库与仓库 WIKI 的编排层（J 层）。
   *
   * 列表同样只走 MCP；WIKI 正文走 git（Gitee 没有 HTTP 接口），
   * 理由与边界见 `DOCS.md` §14.1。
   */
  readonly repos: RepoService
  /**
   * 合并请求编排服务（0.5.4）。缺失时 `/pr/*` 一律 503：
   * 老装配（没有 prService）不该表现成 500。
   */
  readonly pr?: PrService
  /**
   * AI 审核的真实执行体：在所选**主会话**下起一个子智能体跑模板（0.5.4）。
   *
   * 用户 2026-10-26 口径：审核不要往主会话里插用户消息，要挂在主会话下的子智能体；
   * 结论回到面板，由人决定通过/驳回。缺失时 `/pr/ai-review/subagent` 报 501。
   */
  readonly subagentReview?: (input: {
    sessionId: string
    prompt: string
    label: string
    /** `parent` = 结论同时落进所选主会话（人看得见），`caller` = 纯后台。 */
    delivery?: 'caller' | 'parent'
  }) => Promise<{
    runId: string
    childId: string
  }>
  /** 查子智能体跑批状态（客户端轮询）。 */
  readonly subagentRun?: (runId: string) => unknown
  /** 取消跑批（用户关掉面板/点取消）。 */
  readonly subagentCancel?: (runId: string) => boolean
}

/** 写一个 JSON 响应。 */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** 读请求体（带上限，避免无限缓冲）。 */
function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 把执行器错误映射为 HTTP 信封。 */
function errorResponse(error: unknown): { status: number; body: ErrorResponse } {
  if (error instanceof GqError) {
    const status = error.code === 'no-token' ? 409 : error.code === 'timeout' ? 504 : 502
    return { status, body: { ok: false, code: error.code, message: error.message } }
  }
  if (error instanceof DocError) {
    // 文档委派的失败要能一眼看出"是会话、是作用域、是没选企业、还是 MCP 本身"。
    const status = error.code === 'no-session' ? 400
      : error.code === 'no-agent' ? 409
        : error.code === 'no-enterprise' ? 409
          : error.code === 'timeout' ? 504
            : error.code === 'no-tools' || error.code === 'unknown-tool' ? 503
              : 502
    return { status, body: { ok: false, code: 'script-failed', message: error.message } }
  }
  if (error instanceof PrError) {
    return { status: error.status, body: { ok: false, code: error.code, message: error.message, hint: error.hint } }
  }
  if (error instanceof WriteError) {
    const status = error.code === 'bad-request' ? 400
      : error.code === 'forbidden' ? 403
        : error.code === 'disabled' ? 409
          : 502
    return { status, body: { ok: false, code: 'bad-request', message: error.message } }
  }
  return {
    status: 500,
    body: { ok: false, code: 'script-failed', message: error instanceof Error ? error.message : String(error) },
  }
}

/** 取一个正整数查询参数。 */
function positiveParam(url: URL, name: string): number | null {
  const value = Number(url.searchParams.get(name))
  return Number.isInteger(value) && value > 0 ? value : null
}

/**
 * token 文件路径与解析顺序统一在 `./token.ts`：界面写入这份文件后，
 * gq 脚本每次调用都会现读，取数即时生效、无需重启 dsh。
 */

/**
 * 从查询串里解析一个仓库定位。
 *
 * `repoId` 必须是正整数；`repoPath` 的形状校验在编排层做（它要拼克隆地址与目录名）。
 * 任一项缺失返回 null，让路由给出 400 而不是把半个参数传下去。
 * @param url - 请求 URL。
 */
function repoRefOf(url: URL): { repoId: number; repoPath: string; repoName: string; programId: number | null } | null {
  const repoId = positiveParam(url, 'repoId')
  const repoPath = url.searchParams.get('repoPath') ?? ''
  if (repoId === null || repoPath === '') return null
  const programId = positiveParam(url, 'program')
  return { repoId, repoPath, repoName: url.searchParams.get('repoName') ?? '', programId }
}

/**
 * 创建路由处理器。
 * @param deps - 执行器、信任列表、版本号。
 * @returns 供 `ctx.webServer.register` 使用的 handler。
 */
export function createRouteHandler(deps: RouteDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isTrustedApiRequest(req, deps.trustedHosts())) {
      writeJson(res, 403, { ok: false, code: 'forbidden', message: '请求未通过浏览器信任栅栏' } satisfies ErrorResponse)
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
    const method = req.method ?? 'GET'

    // 面板慢的时候，第一反应总是「Gitee 慢」——但慢在哪一段只有计时能说清楚。
    // 慢请求（≥500ms）始终记一行；全量记录用 GITEE_CHAT_TRACE=1 打开。
    const startedAt = Date.now()
    const trace = process.env.GITEE_CHAT_TRACE === '1'
    if (typeof res.on === 'function') res.on('finish', () => {
      const ms = Date.now() - startedAt
      if (trace || ms >= 500) console.error(`[gitee-chat]${ms >= 500 ? '[slow]' : ''} ${method} ${route} → ${res.statusCode} ${ms}ms`)
    })

    try {
      // 只读部署（`allowWrites=false`）：凡是会让 Gitee 侧发生变化的入口统一 403。
      // 放在最前面，避免某个分支先做了半截读写才被拦。缓存/设置这类**本地**写不受影响。
      const WRITE_ROUTES = new Set(['/write', '/issue-create', '/pr/create', '/pr/action'])
      if (method === 'POST' && WRITE_ROUTES.has(route) && deps.allowWrites?.() === false) {
        writeJson(res, 403, {
          ok: false,
          code: 'read-only',
          message: '这个部署是只读的（allowWrites=false），面板不能改 Gitee。',
          hint: '要改请在 Gitee 网页操作，或让管理员把插件配置的 allowWrites 改成 true。',
        } satisfies ErrorResponse)
        return
      }

      if (route === '/ping' && method === 'GET') {
        writeJson(res, 200, {
          ok: true,
          version: deps.version,
          scriptExists: deps.runner.scriptExists(),
          // 随包 MCP 后端的状态：同事没装 Go 时，这就是"能不能用 MCP 工具"的答案
          mcp: deps.mcp(),
          // 知识库文档：缓存根与已缓存文档数（排障"文档读不出来"的第一站）
          docs: deps.docs.snapshot(),
        })
        return
      }

      if (route === '/health' && method === 'GET') {
        writeJson(res, 200, await deps.runner.health())
        return
      }

      if (route === '/session' && method === 'GET') {
        // 整屏视图用它决定「渲染看板」还是「提示本会话未启用 Gitee 模式」。
        // 客户端插件在 profile 层，注册的视图对所有 preset 可见，
        // 因此必须由 host 侧回答"这个会话到底是不是 Gitee 模式"。
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const gitee = sessionId === '' ? undefined : await deps.isGiteeSession(sessionId)
        writeJson(res, 200, {
          ok: true,
          sessionId,
          gitee: gitee ?? null,
          preset: sessionId === '' ? null : deps.presetOf(sessionId),
        })
        return
      }

      if (route === '/issues' && method === 'GET') {
        const program = Number(url.searchParams.get('program'))
        if (!Number.isFinite(program) || program <= 0) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 program=<项目id>' } satisfies ErrorResponse)
          return
        }
        const state = url.searchParams.get('state') ?? undefined
        const args = ['issues', '--program', String(program)]
        if (state !== null && state !== '') args.push('--state', state)
        const data = await cachedRead(url, () => deps.runner.execJson<unknown>(args, deps.runner.fixtureFallback))
        writeJson(res, 200, { ok: true, ...(data as object) })
        return
      }

      // ── 仓库维度的工作项（仓库详情页「工作项」页签）────────────────────
      // Gitee 企业版里工作项除了挂项目(program)，还能挂仓库(project_id)。
      // 仓库详情页要的是后者：任务/需求/缺陷都要能看到（用户口径）。
      if (route === '/repo/issues' && method === 'GET') {
        const repoId = Number(url.searchParams.get('repoId'))
        if (!Number.isFinite(repoId) || repoId <= 0) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 repoId=<仓库id>' } satisfies ErrorResponse)
          return
        }
        const state = url.searchParams.get('state')
        const args = ['repo-issues', '--repo', String(repoId)]
        if (state !== null && state !== '') args.push('--state', state)
        const data = await cachedRead(url, () => deps.runner.execJson<unknown>(args, deps.runner.fixtureFallback))
        writeJson(res, 200, { ok: true, ...(data as object) })
        return
      }

      // ── 仓库分支（新建 PR 时选源/目标分支）──────────────────────────
      //
      // 为什么要有这条：MCP 的 55 个工具里没有「列分支」，0.5.4 之前面板只能让人手输
      // 分支名（打错要等 Gitee 拒）。这条走宿主自己的取数脚本（`gq branches`），
      // 与其他读路由同一条通道；拿不到（老 token/无权限）时客户端回退成输入框。
      if (route === '/repo/branches' && method === 'GET') {
        const repoId = positiveParam(url, 'repoId')
        if (repoId === null) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 repoId=<仓库id>' } satisfies ErrorResponse)
          return
        }
        const data = await cachedRead(url, () => deps.runner.execJson<unknown>(
          ['branches', '--repo', String(repoId)], deps.runner.fixtureFallback,
        ))
        writeJson(res, 200, { ok: true, ...(data as object) })
        return
      }

      // ── 工作项类型（新建工作项时选 任务/需求/缺陷）────────────────────
      if (route === '/issue-types' && method === 'GET') {
        const program = positiveParam(url, 'program')
        if (program === null) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 program=<项目id>' } satisfies ErrorResponse)
          return
        }
        const args = ['issue-types', '--program', String(program)]
        const data = await deps.runner.execJson<unknown>(args, deps.runner.fixtureFallback)
        writeJson(res, 200, { ok: true, ...(data as object) })
        return
      }

      // ── 新建工作项 ───────────────────────────────────────────────────
      // 走 gq 的 create-issue：只依赖企业 token，**不需要会话处于 Gitee 模式**。
      if (route === '/issue-create' && method === 'POST') {
        const body = (await readJsonBody(req)) as Partial<IssueCreateRequest> | null
        const title = typeof body?.title === 'string' ? body.title.trim() : ''
        if (title === '') {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '新建工作项需要标题。' } satisfies ErrorResponse)
          return
        }
        const args = ['create-issue', '--title', title]
        if (typeof body?.programId === 'number' && body.programId > 0) args.push('--program', String(body.programId))
        if (typeof body?.repoId === 'number' && body.repoId > 0) args.push('--repo', String(body.repoId))
        if (typeof body?.typeId === 'number' && body.typeId > 0) args.push('--type', String(body.typeId))
        if (typeof body?.assigneeId === 'number' && body.assigneeId > 0) args.push('--assignee', String(body.assigneeId))
        if (typeof body?.priority === 'number' && body.priority > 0) args.push('--priority', String(body.priority))
        if (typeof body?.planStartedAt === 'string' && body.planStartedAt.trim() !== '') args.push('--plan-start', body.planStartedAt.trim())
        if (typeof body?.deadline === 'string' && body.deadline.trim() !== '') args.push('--deadline', body.deadline.trim())
        if (typeof body?.description === 'string' && body.description.trim() !== '') {
          args.push('--description', body.description)
        }
        const data = await deps.runner.execJson<unknown>(args, deps.runner.fixtureFallback)
        // 建完把读缓存清掉，界面重拉时才能看到新建的这条
        invalidateReadCaches(deps)
        writeJson(res, 200, { ok: true, ...(data as object) })
        return
      }

      // ── 工作项详情（F-09：描述 / 前置依赖 / 评论讨论）──────────────────
      if (route === '/issue' && method === 'GET') {
        const ident = (url.searchParams.get('ident') ?? '').trim().toUpperCase()
        if (!/^[A-Z0-9]{4,12}$/.test(ident)) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 ident=<工作项编号>（如 DM0001）' } satisfies ErrorResponse)
          return
        }
        const args = ['issue', '--ident', ident]
        const limit = positiveParam(url, 'comments')
        if (limit !== null) args.push('--comment-limit', String(limit))
        const data = await cachedRead(url, () => deps.runner.execJson<unknown>(args, deps.runner.fixtureFallback))
        writeJson(res, 200, { ok: true, ...(data as object) })
        return
      }

      // ── 可选状态（改状态的下拉项）─────────────────────────────────────
      if (route === '/states' && method === 'GET') {
        const typeId = positiveParam(url, 'type')
        if (typeId === null) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 type=<工作项类型id>' } satisfies ErrorResponse)
          return
        }
        const data = await cachedRead(url, () => deps.runner.execJson<unknown>(['states', '--type', String(typeId)], deps.runner.fixtureFallback))
        writeJson(res, 200, { ok: true, ...(data as object) })
        return
      }

      // ── 项目成员（改派的候选人）───────────────────────────────────────
      if (route === '/members' && method === 'GET') {
        const program = positiveParam(url, 'program')
        if (program === null) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 program=<项目id>' } satisfies ErrorResponse)
          return
        }
        const data = await cachedRead(url, () => deps.runner.execJson<unknown>(['members', '--program', String(program)], deps.runner.fixtureFallback))
        writeJson(res, 200, { ok: true, ...(data as object) })
        return
      }

      // ── 知识库文档（全部委派 MCP；见 DOCS.md §7）──────────────────────
      //
      // 这五条路由**不拼任何 Gitee 文档端点**。它们只做三件事：
      //   1. 校验 sessionId / documentId 这类不可信入参；
      //   2. 调 deps.docs（编排层）；
      //   3. 把结果原样回给标签页。
      // 端点语义、参数校验、权限口径全部归 MCP —— 只有一份实现。

      // ── 知识库节点树（本企业知识库的真实入口）──────────────────────────
      //
      // 与下面那组 `/docs` `/doc` `/doc/page` `/doc/sync` 的区别要说清楚：
      //   · **这里**走 `doc_nodes` 树（DocDirectory + AttachFile）—— 本企业**实际**的
      //     知识库形态，实测（2026-09-15）全部项目资料都在这儿；
      //   · 下面那组走 `WikiInfo` 文档（有页、有 version、可编辑协作）——
      //     本企业**一篇都没有**，那条路保留给"文档形态"，实测为 0。
      // 混用会得到"列表永远是空的"这种最难查的现象（上一版就是这么栽的）。
      if (route === '/doc/nodes' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId === '') {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 sessionId（文档取数靠它解析 agent 作用域）' } satisfies ErrorResponse)
          return
        }
        const programRaw = url.searchParams.get('program')
        const programId = programRaw === null || programRaw === '' ? null : Number(programRaw)
        if (programId !== null && (!Number.isInteger(programId) || programId <= 0)) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: 'program 必须是正整数' } satisfies ErrorResponse)
          return
        }
        const parentRaw = url.searchParams.get('parentId')
        const parentId = parentRaw === null || parentRaw === '' ? 0 : Number(parentRaw)
        if (!Number.isInteger(parentId) || parentId < 0) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: 'parentId 必须是非负整数' } satisfies ErrorResponse)
          return
        }
        writeJson(res, 200, await deps.docs.listNodes(sessionId, programId, parentId))
        return
      }

      // ── 读附件内容（本企业知识库真正能读的那条路）──────────────────────
      //
      // 委派 MCP 的 `download_attach_file`：它把文件写进插件的缓存根，
      // 插件再把文本读回来。**插件不自己取 attach_files 端点**（DOCS.md §7）。
      if (route === '/doc/attachment' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const nodeId = positiveParam(url, 'nodeId')
        const fileId = positiveParam(url, 'fileId')
        if (sessionId === '' || nodeId === null || fileId === null) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 sessionId、正整数 nodeId 与 fileId' } satisfies ErrorResponse)
          return
        }
        const programRaw = url.searchParams.get('program')
        const programId = programRaw === null || programRaw === '' ? null : Number(programRaw)
        const name = url.searchParams.get('name') ?? ''
        // `updatedAt` / `size` 是**节点当前的远端事实**（由列表带过来）——
        // 编排层拿它和本地清单比，一致就直接读本地，一次 MCP 都不发。
        const updatedAt = url.searchParams.get('updatedAt') ?? ''
        const sizeRaw = Number(url.searchParams.get('size'))
        const size = Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : 0
        // `refresh=1`：忽略本地缓存强制重下（"远端已更新"时界面上那个按钮）。
        const refresh = url.searchParams.get('refresh') === '1'
        writeJson(res, 200, await deps.docs.attachment(sessionId, { nodeId, fileId, name, programId, updatedAt, size, refresh }))
        return
      }

      // ── 仓库 + 仓库 WIKI（J 层；见 DOCS.md §14）────────────────────────
      //
      // 列表委派 MCP 的 `list_enterprise_repositories`（**插件仍然不拼端点**）。
      // WIKI 正文是这条纪律的**唯一例外**：Gitee 没有仓库 WIKI 的 HTTP 接口
      // （实测穷举：企业 API 全 404、开放 API `/repos/{owner}/{repo}/wikis` 是 405），
      // 它只有 git 形态 `{path_with_namespace}.wiki.git` —— 见 host/wikiCache.ts。
      if (route === '/doc/repos' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId === '') {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 sessionId（仓库取数靠它解析 agent 作用域）' } satisfies ErrorResponse)
          return
        }
        const programRaw = url.searchParams.get('program')
        const programId = programRaw === null || programRaw === '' ? null : Number(programRaw)
        if (programId !== null && (!Number.isInteger(programId) || programId <= 0)) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: 'program 必须是正整数' } satisfies ErrorResponse)
          return
        }
        const name = url.searchParams.get('name') ?? ''
        writeJson(res, 200, await deps.repos.repos(sessionId, programId, name))
        return
      }

      if (route === '/doc/wiki' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const ref = repoRefOf(url)
        if (sessionId === '' || ref === null) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 sessionId、正整数 repoId 与 owner/repo 形式的 repoPath' } satisfies ErrorResponse)
          return
        }
        const refresh = url.searchParams.get('refresh') === '1'
        writeJson(res, 200, await deps.repos.wiki(sessionId, ref, refresh))
        return
      }

      if (route === '/doc/wiki/page' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const ref = repoRefOf(url)
        const path = url.searchParams.get('path') ?? ''
        if (sessionId === '' || ref === null || path === '') {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 sessionId、repoId、repoPath 与 path' } satisfies ErrorResponse)
          return
        }
        writeJson(res, 200, await deps.repos.wikiPage(sessionId, ref, path))
        return
      }

      // ── 缓存管理（A2）────────────────────────────────────────────────
      //
      // 这两条**不经过 MCP**：管的是插件自己在本地维护的缓存，与 Gitee 无关。
      // 因此也**不要求活 agent** —— 没有会话在内存里照样能清缓存。
      //
      // 清缓存是**安全动作**：缓存是"读过才在"的副本，删掉只让下次点击重新下载，
      // 不动 Gitee 上任何东西，所以不需要二次确认。
      if (route === '/doc/cache' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId === '') {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 sessionId（与其他文档路由保持一致）' } satisfies ErrorResponse)
          return
        }
        const programRaw = url.searchParams.get('program')
        const programId = programRaw === null || programRaw === '' ? null : Number(programRaw)
        if (programId !== null && (!Number.isInteger(programId) || programId <= 0)) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: 'program 必须是正整数' } satisfies ErrorResponse)
          return
        }
        writeJson(res, 200, { ok: true, ...deps.docs.cacheInfo(), scopeDir: deps.docs.scopePath(programId) })
        return
      }

      if (route === '/doc/cache/forget' && method === 'POST') {
        const body = (await readJsonBody(req)) as Record<string, unknown>
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
        const target = body.target === 'scope' ? 'scope' : body.target === 'attachment' ? 'attachment' : ''
        if (sessionId === '' || target === '') {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: "需要 sessionId 与 target（'attachment' | 'scope'）" } satisfies ErrorResponse)
          return
        }
        const programId = typeof body.programId === 'number' && Number.isInteger(body.programId) && body.programId > 0 ? body.programId : null
        if (target === 'scope') {
          writeJson(res, 200, { ok: true, target, ...deps.docs.forgetScope(programId) })
          return
        }
        const nodeId = typeof body.nodeId === 'number' && Number.isInteger(body.nodeId) && body.nodeId > 0 ? body.nodeId : null
        if (nodeId === null) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: 'target=attachment 时需要正整数 nodeId' } satisfies ErrorResponse)
          return
        }
        const name = typeof body.name === 'string' ? body.name : ''
        writeJson(res, 200, { ok: true, target, ...deps.docs.forgetAttachment({ nodeId, name, programId }) })
        return
      }

      // ── 知识库文档（WikiInfo 形态）—— 🔒 **有意休眠，别当成没做完** ────────
      //
      // ## A7 决策（2026-09-15，用户拍板：**暂时不做**）
      //
      // 下面 5 条路由 + `client/api.ts` 的 5 个同名函数 + `docService` 的
      // list/search/detail/page/sync + `write.ts` 的 `doc-page-update` 分支，
      // **当前没有任何 UI 调用点**。这不是漏做，是**有意冻结**：
      //
      //   · 它们服务的是第三种文档形态 `WikiInfo`（有"页"、有页级 `version`、
      //     可协作编辑）—— 本企业**一篇都没有**，实测 `list_enterprise_documents`
      //     恒返回 0（它源码里硬编码 `file_type=WikiInfo`）；
      //   · 用户明确表示这套的**用途还没弄明白**，研究清楚前不动；
      //   · 删起来也不干净：`docCache` 的 `documentDir` / `enterpriseLayer` /
      //     `readIndex` / `findDocument` 这些**附件那条路也在用**，
      //     页级四态是搭在它们上面的。
      //
      // **AI 那条路是活的**：这 6 个 WikiInfo MCP 工具仍在三档里启用，
      // `<docs>` 人格块里有一个 `<wikiinfo>` 条件块讲它们（先探测再假设）。
      // 所以冻的只是**插件 UI 的接线**，不是能力本身。
      //
      // 冒烟里有一条守卫断言把这 5 条路由与那句话钉住 —— 免得哪天被
      // 当成死代码"顺手清掉"，或者反过来被人以为没做完又重做一遍。
      //
      // 真要唤醒：界面接上 `fetchDocs` / `fetchDoc` / `fetchDocPage` / `postDocSync`
      // 即可，页级 version / 乐观锁 / 增量拉取都已经真机验证过。

      if (route === '/docs' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        if (sessionId === '') {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 sessionId（文档取数靠它解析 agent 作用域）' } satisfies ErrorResponse)
          return
        }
        const programRaw = url.searchParams.get('program')
        const programId = programRaw === null || programRaw === '' ? undefined : Number(programRaw)
        if (programId !== undefined && (!Number.isInteger(programId) || programId <= 0)) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: 'program 必须是正整数' } satisfies ErrorResponse)
          return
        }
        writeJson(res, 200, await deps.docs.list(sessionId, programId === undefined ? 'common' : 'program', programId))
        return
      }

      if (route === '/docs/search' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const query = (url.searchParams.get('q') ?? '').trim()
        if (sessionId === '') {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 sessionId' } satisfies ErrorResponse)
          return
        }
        if (query === '') {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 q=<关键词>' } satisfies ErrorResponse)
          return
        }
        writeJson(res, 200, await deps.docs.search(sessionId, query))
        return
      }

      if (route === '/doc' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const documentId = positiveParam(url, 'documentId')
        if (sessionId === '' || documentId === null) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 sessionId 与正整数 documentId' } satisfies ErrorResponse)
          return
        }
        // 首次访问还没有缓存目录时，靠这两个提示参数定位目录（幂等，不影响取数）。
        const programRaw = url.searchParams.get('program')
        const programId = programRaw === null || programRaw === '' ? undefined : Number(programRaw)
        const name = url.searchParams.get('name') ?? ''
        const hint = name === '' ? undefined : { programId: programId ?? null, name }
        writeJson(res, 200, await deps.docs.detail(sessionId, documentId, hint))
        return
      }

      if (route === '/doc/page' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const documentId = positiveParam(url, 'documentId')
        const pageId = positiveParam(url, 'pageId')
        if (sessionId === '' || documentId === null || pageId === null) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 sessionId、documentId 与 pageId' } satisfies ErrorResponse)
          return
        }
        const programRaw = url.searchParams.get('program')
        const programId = programRaw === null || programRaw === '' ? undefined : Number(programRaw)
        const name = url.searchParams.get('name') ?? ''
        const hint = name === '' ? undefined : { programId: programId ?? null, name }
        writeJson(res, 200, await deps.docs.page(sessionId, documentId, pageId, hint))
        return
      }

      if (route === '/doc/sync' && method === 'POST') {
        const body = (await readJsonBody(req)) as { sessionId?: unknown; documentId?: unknown; mode?: unknown; program?: unknown; name?: unknown } | null
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const documentId = Number(body?.documentId)
        if (sessionId === '' || !Number.isInteger(documentId) || documentId <= 0) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 sessionId 与正整数 documentId' } satisfies ErrorResponse)
          return
        }
        const mode = body?.mode === 'pull' ? 'pull' : 'check'
        const name = typeof body?.name === 'string' ? body.name : ''
        const program = typeof body?.program === 'number' && Number.isFinite(body.program) ? body.program : null
        const hint = name === '' ? undefined : { programId: program, name }
        writeJson(res, 200, await deps.docs.sync(sessionId, documentId, mode, hint))
        return
      }

      // ── 唯一写入口 ───────────────────────────────────────────────────
      //
      // 两道约束：
      //   1. 过浏览器信任栅栏（函数入口已经做了）；
      //   2. 具体动作由 `deps.writer` 单点校验与执行（见 host/write.ts）——
      //      能不能写由 token 角色与 `hostConfig.allowWrites` 决定。
      // 0.5.4 起**不再**要求 `sessionId` 属于 Gitee 模式的会话：那道 403
      // 曾把「任何模式都能用」卡死（用户实测「改状态失败」）。
      // ── 合并请求（PR）· 0.5.4 ──────────────────────────────────────────
      // 读：GET /pr/list、/pr/detail、/pr/templates
      // 合并请求工作台（0.5.4）
      //
      // 纪律（用户 2026-10-26 口径）：**任何模式的会话都能用** —— 不再要求「当前会话
      // 选了 Gitee 预设」。数据经 deps.pr 委派 MCP 的**进程级直连通道**
      // （`host/mcpDocs.ts` 的 `deps.direct`），写与不写由 token 角色 +
      // `get_enterprise_pull_auth` 决定，路由层不拼 Gitee 端点。
      // sessionId 只剩一个用途：AI 审核把 prompt 投回哪个会话，由客户端决定。
      if (route.startsWith('/pr/') && deps.pr === undefined) {
        writeJson(res, 503, { ok: false, code: 'bad-request', message: 'PR 面板未装配（prService 缺失）。' } satisfies ErrorResponse)
        return
      }

      if (route === '/sessions' && method === 'GET') {
        const items = deps.listSessions?.() ?? []
        writeJson(res, 200, { ok: true, items })
        return
      }

      if (route === '/debug/services' && method === 'GET') {
        writeJson(res, 200, { ok: true, data: (await deps.debugServices?.()) ?? null })
        return
      }

      if (route === '/debug/presets' && method === 'GET') {
        // 临时诊断路由：把宿主 preset 服务的真实返回打出来。
        writeJson(res, 200, { ok: true, data: (await deps.debugPresets?.()) ?? null })
        return
      }

      if (route === '/pr/list' && method === 'GET') {
        // sessionId 可选：只用于日志/审计，取数走直连通道。
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const rawScope = url.searchParams.get('scope') ?? 'all'
        const scope: 'assign' | 'test' | 'create' | 'all' =
          rawScope === 'assign' || rawScope === 'test' || rawScope === 'create' ? rawScope : 'all'
        const rawState = url.searchParams.get('state') ?? 'opened'
        const state: 'opened' | 'merged' | 'closed' | 'all' =
          rawState === 'merged' || rawState === 'closed' || rawState === 'all' ? rawState : 'opened'
        const repoId = positiveParam(url, 'repoId')
        const page = positiveParam(url, 'page')
        const result = await cachedRead(url, () =>
          deps.pr!.list(sessionId, {
            scope,
            state,
            ...(repoId === null ? {} : { repoId }),
            ...(page === null ? {} : { page }),
            q: url.searchParams.get('q') ?? '',
          }),
        )
        writeJson(res, 200, { ok: true, ...result })
        return
      }

      if (route === '/pr/detail' && method === 'GET') {
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const repoId = positiveParam(url, 'repoId')
        const iid = positiveParam(url, 'iid')
        if (repoId === null || iid === null) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '缺少 repoId / iid。' } satisfies ErrorResponse)
          return
        }
        writeJson(res, 200, { ok: true, detail: await deps.pr!.detail(sessionId, repoId, iid) })
        return
      }

      if (route === '/pr/templates' && method === 'GET') {
        const repoPath = url.searchParams.get('repoPath') ?? ''
        writeJson(res, 200, { ok: true, ...deps.pr!.templates(repoPath) })
        return
      }

      if (route === '/pr/templates' && method === 'POST') {
        const body = (await readJsonBody(req)) as {
          name?: unknown
          content?: unknown
          repoPath?: unknown
          kind?: unknown
        } | null
        const name = typeof body?.name === 'string' ? body.name : ''
        const content = typeof body?.content === 'string' ? body.content : ''
        const repoPath = typeof body?.repoPath === 'string' ? body.repoPath : undefined
        // `pr` 也收：模板层早就有这个 kind（「＋ 新建 PR」的「套用模板」读它），
        // 之前这里只放行 review/test，导致 pr 模板只能靠用户副本文件覆盖。
        const kind = body?.kind === 'review' || body?.kind === 'test' || body?.kind === 'pr' || body?.kind === 'prGuide'
          ? body.kind
          : null
        if (name === '' || content === '') {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: 'name 与 content 都必须非空。' } satisfies ErrorResponse)
          return
        }
        writeJson(res, 200, {
          ok: true,
          item: deps.pr!.saveTemplate({
            name,
            content,
            ...(repoPath === undefined ? {} : { repoPath }),
            kind,
          }),
        })
        return
      }

      /**
       * AI 起草 PR 标题与描述。
       *
       * 两步：① 宿主抓 `compare`（源分支 vs 目标分支的真实提交与文件差异）+ `pr-guide`
       * 模板 → 拼 prompt；② 在**所选主会话**下起子智能体跑这段 prompt（与 AI 审核
       * 同一套投递机制，不往主会话插用户消息）。
       *
       * 返回的 `runId` 用 `GET /pr/ai-review/subagent?runId=` 轮询（同一个跑批池）。
       */
      if (route === '/pr/draft' && method === 'POST') {
        const body = (await readJsonBody(req)) as {
          sessionId?: unknown
          repoId?: unknown
          repoPath?: unknown
          sourceBranch?: unknown
          targetBranch?: unknown
          /** `session` = 结论同时投进所选主会话（也回填表单）；缺省 `subagent` = 纯后台。 */
          deliver?: unknown
        } | null
        const deliver = body?.deliver === 'session' ? 'session' : 'subagent'
        if (deps.subagentReview === undefined) {
          writeJson(res, 501, {
            ok: false,
            code: 'no-subagents',
            message: '这个版本的宿主没有装配子智能体投递。',
            hint: '升级 DSH 到 0.2.1 以上；或手工写标题与描述。',
          } satisfies ErrorResponse)
          return
        }
        const repoId = Number(body?.repoId)
        const sourceBranch = typeof body?.sourceBranch === 'string' ? body.sourceBranch.trim() : ''
        const targetBranch = typeof body?.targetBranch === 'string' ? body.targetBranch.trim() : ''
        if (!Number.isFinite(repoId) || repoId <= 0 || sourceBranch === '' || targetBranch === '') {
          writeJson(res, 400, {
            ok: false,
            code: 'bad-request',
            message: '需要 repoId、sourceBranch、targetBranch。',
          } satisfies ErrorResponse)
          return
        }
        if (sourceBranch === targetBranch) {
          writeJson(res, 400, {
            ok: false,
            code: 'bad-request',
            message: '源分支与目标分支相同，没有可起草的改动。',
          } satisfies ErrorResponse)
          return
        }
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const repoPath = typeof body?.repoPath === 'string' ? body.repoPath : undefined
        try {
          const rendered = await deps.pr!.draftPull(sessionId, {
            repoId,
            ...(repoPath === undefined ? {} : { repoPath }),
            sourceBranch,
            targetBranch,
          })
          if (deliver === 'session') {
            // 取消勾选「子智能体」：仍然起子智能体，但 delivery='parent' ——
            // 结论会以结算消息落进所选主会话（人看得见、可以接着追问），
            // 同时结果照旧回本插件，客户端轮询到就回填表单。
            const label = `PR 起草 ${sourceBranch} → ${targetBranch}`
            const started = await deps.subagentReview({ sessionId, prompt: rendered.prompt, label, delivery: 'parent' })
            writeJson(res, 200, {
              ok: true,
              dispatched: true,
              deliveredTo: 'session',
              runId: started.runId,
              childId: started.childId,
              prompt: rendered.prompt,
              commits: rendered.commits,
              files: rendered.files,
              source: rendered.source,
            })
            return
          }
          const label = `PR 起草 ${sourceBranch} → ${targetBranch}`
          const started = await deps.subagentReview({ sessionId, prompt: rendered.prompt, label })
          writeJson(res, 200, {
            ok: true,
            dispatched: true,
            deliveredTo: 'subagent',
            runId: started.runId,
            childId: started.childId,
            prompt: rendered.prompt,
            commits: rendered.commits,
            files: rendered.files,
            source: rendered.source,
          })
        } catch (cause) {
          const failure = cause as { code?: string; message?: string; hint?: string }
          const status = failure.code === 'no-subagents' || failure.code === 'session-not-live' ? 409 : 400
          writeJson(res, status, {
            ok: false,
            code: failure.code ?? 'start-failed',
            message: failure.message ?? '拉起子智能体失败。',
            hint: failure.hint ?? '换一个会话重试，或手工写标题与描述。',
          } satisfies ErrorResponse)
        }
        return
      }

      if (route === '/pr/create' && method === 'POST') {
        const body = (await readJsonBody(req)) as (PrCreateRequest & { sessionId?: unknown }) | null
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        // 建 PR 的**唯一宿主入口**：UI 对话框走它；agent 侧等价能力是直接调
        // MCP 的 `create_enterprise_repo_pull`，两条路径最终落到同一套 Gitee 语义。
        const request = { ...(body as PrCreateRequest & { sessionId: string }) }
        delete (request as { sessionId?: unknown }).sessionId
        const created = await deps.pr!.create(sessionId, request as PrCreateRequest)
        invalidateReadCaches(deps)  // 新 PR 要立刻出现在列表里
        writeJson(res, 200, { ok: true, result: created })
        return
      }

      if (route === '/pr/action' && method === 'POST') {
        const body = (await readJsonBody(req)) as (PrActionRequest & { sessionId?: unknown }) | null
        // sessionId 可选（审计用）；写权限由 MCP 的 token 角色与 PR auths 决定，
        // 不再按「会话是否 Gitee 模式」拦 —— 见本段开头纪律。
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const action = { ...(body as PrActionRequest & { sessionId: string }) }
        delete (action as { sessionId?: unknown }).sessionId
        const detail = await deps.pr!.action(sessionId, action as PrActionRequest)
        invalidateReadCaches(deps)  // 审核/测试/合并/评论后列表与工作项都可能变
        writeJson(res, 200, { ok: true, detail })
        return
      }

      if (route === '/pr/ai-review' && method === 'POST') {
        const body = (await readJsonBody(req)) as (PrAiReviewRequest & { sessionId?: unknown; repoId?: unknown }) | null
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const repoId = typeof body?.repoId === 'number' ? body.repoId : 0
        if (repoId <= 0 || typeof body?.iid !== 'number') {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '缺少 repoId / iid。' } satisfies ErrorResponse)
          return
        }
        const kind = body.template === 'test' ? 'test' : 'review'
        const rawScope = body.scope
        const scope: 'full' | 'code-only' | 'files' = rawScope === 'code-only' || rawScope === 'files' ? rawScope : 'full'
        const rendered = await deps.pr!.aiReview(sessionId, repoId, {
          repoId,
          iid: body.iid,
          template: kind,
          scope,
          ...(Array.isArray(body.files) ? { files: body.files.filter((f): f is string => typeof f === 'string') } : {}),
          autoApprove: body.autoApprove === true,
        })
        // 投递不在这里做：客户端拿到 prompt 后用 ctx.conversation.send 投给当前会话，
        // 这样「谁发出的消息」与会话作用域不会错位。
        writeJson(res, 200, {
          ok: true,
          dispatched: false,
          prompt: rendered.prompt,
          preview: rendered.preview,
          autoApprove: rendered.autoApprove,
        })
        return
      }

      // ── AI 审核交给子智能体（0.5.4，用户 2026-10-26 口径）────────────────────
      // 之前是「渲染 prompt → 投到主会话」，用户要的是「在所选主会话下起子智能体」：
      // 审核是后台活，不该污染主会话的对话；结论回到面板，人再点通过/驳回。
      if (route === '/pr/ai-review/subagent' && method === 'POST') {
        if (deps.subagentReview === undefined) {
          writeJson(res, 501, {
            ok: false,
            code: 'no-subagents',
            message: '这个版本的宿主没有装配子智能体投递。',
            hint: '升级 DSH 到 0.2.1 以上，或把结论手工投给会话。',
          } satisfies ErrorResponse)
          return
        }
        const body = (await readJsonBody(req)) as (PrAiReviewRequest & { sessionId?: unknown; deliver?: unknown }) | null
        const deliverToSession = body?.deliver === 'session'
        const repoId = typeof body?.repoId === 'number' ? body.repoId : 0
        if (repoId <= 0 || typeof body?.iid !== 'number') {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '缺少 repoId / iid。' } satisfies ErrorResponse)
          return
        }
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const kind = body.template === 'test' ? 'test' : 'review'
        const rawScope = body.scope
        const scope: 'full' | 'code-only' | 'files' = rawScope === 'code-only' || rawScope === 'files' ? rawScope : 'full'
        const rendered = await deps.pr!.aiReview(sessionId, repoId, {
          repoId,
          iid: body.iid,
          template: kind,
          scope,
          ...(Array.isArray(body.files) ? { files: body.files.filter((f): f is string => typeof f === 'string') } : {}),
          autoApprove: body.autoApprove === true,
        })
        const label = `PR !${body.iid} ${kind === 'review' ? 'AI 审核' : 'AI 测试'}`
        try {
          const started = await deps.subagentReview({
            sessionId,
            prompt: rendered.prompt,
            label,
            ...(deliverToSession ? { delivery: 'parent' as const } : {}),
          })
          writeJson(res, 200, {
            ok: true,
            dispatched: true,
            deliveredTo: deliverToSession ? 'session' : 'subagent',
            runId: started.runId,
            childId: started.childId,
            prompt: rendered.prompt,
            autoApprove: rendered.autoApprove,
          })
        } catch (cause) {
          const failure = cause as { code?: string; message?: string; hint?: string }
          writeJson(res, 409, {
            ok: false,
            code: failure.code ?? 'start-failed',
            message: failure.message ?? '拉起子智能体失败。',
            hint: failure.hint ?? '选当前会话重试；还不行就把结论手工投给会话。',
          } satisfies ErrorResponse)
        }
        return
      }

      if (route === '/pr/ai-review/subagent' && method === 'GET') {
        const runId = url.searchParams.get('runId') ?? ''
        const snapshot = deps.subagentRun?.(runId) ?? null
        if (snapshot === null) {
          writeJson(res, 404, { ok: false, code: 'run-not-found', message: '这个跑批不存在（可能已过期）。' } satisfies ErrorResponse)
          return
        }
        writeJson(res, 200, { ok: true, run: snapshot })
        return
      }

      if (route === '/pr/ai-review/subagent/cancel' && method === 'POST') {
        const body = (await readJsonBody(req)) as { runId?: unknown } | null
        const runId = typeof body?.runId === 'string' ? body.runId : ''
        const cancelled = deps.subagentCancel?.(runId) === true
        writeJson(res, 200, { ok: true, cancelled })
        return
      }

      if (route === '/write' && method === 'POST') {
        const body = (await readJsonBody(req)) as Partial<IssueWriteRequest> | null
        // 0.5.4 起**不再要求会话处于 Gitee 模式**（与 /pr/* 同一纪律，见 PR 段头）：
        // 能不能写由 token 角色与 hostConfig.allowWrites 决定。这道「该会话未使用
        // Gitee 模式，拒绝写入」曾把「任何模式都能用」直接卡死（改状态失败）。
        // sessionId 只用于审计与文档写的作用域，不参与放行判断。
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const result = await deps.writer.write({
          op: body?.op as IssueWriteRequest['op'],
          ident: String(body?.ident ?? ''),
          stateId: typeof body?.stateId === 'number' ? body.stateId : undefined,
          body: typeof body?.body === 'string' ? body.body : undefined,
          assigneeId: typeof body?.assigneeId === 'number' ? body.assigneeId : undefined,
          sessionId,
        })
        invalidateReadCaches(deps)  // 改状态/评论/指派后，看板与分析数字都可能变
        writeJson(res, 200, result)
        return
      }

      if (route === '/enterprises' && method === 'GET') {
        // 只读：列出 token 可见的企业，并说明「当前用的是哪家、为什么是这家」。
        // 设置页在 token 配好之后直接用它做选择器（不再要求使用者去让 AI 跑命令）。
        writeJson(res, 200, { ok: true, ...(await listEnterprises(deps.runner)) })
        return
      }

      if (route === '/enterprise' && method === 'POST') {
        const body = (await readJsonBody(req)) as { id?: unknown } | null
        const id = Number(body?.id)
        if (!Number.isFinite(id) || id <= 0) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: 'id 必须是正整数' } satisfies ErrorResponse)
          return
        }
        // 写 $DSH_HOME/.gitee-chat/config.json + 失效宿主缓存 + 重解析人格
        // （顺序与原因见 host/enterprise.ts；漏掉后两步会「列表换了、卡片没换」）。
        const result = await switchEnterprise({ runner: deps.runner, role: deps.role }, id)
        writeJson(res, 200, { ok: true, ...result })
        return
      }

      // ── Gitee 企业版 token：界面设置入口写 ~/.dsh/.gitee-chat/token ──────
      // gq 脚本每次调用都现读该文件，所以保存后取数即时生效、无需重启 dsh。
      if (route === '/token' && method === 'GET') {
        const file = tokenFilePath()
        const inFile = existsSync(file) && readFileSync(file, 'utf8').trim() !== ''
        const inEnv = TOKEN_ENVS.some((name) => (process.env[name] ?? '').trim() !== '')
        writeJson(res, 200, {
          ok: true,
          configured: inFile || inEnv,
          source: inFile ? 'file' : inEnv ? 'env' : null,
          path: file,
        })
        return
      }

      if (route === '/token' && method === 'POST') {
        const body = (await readJsonBody(req)) as { token?: unknown } | null
        const token = typeof body?.token === 'string' ? body.token.trim() : ''
        if (token === '') {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: 'token 不能为空' } satisfies ErrorResponse)
          return
        }
        const file = tokenFilePath()
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, token + '\n', 'utf8')
        writeJson(res, 200, { ok: true, source: 'file', path: file })
        return
      }

      // ── 缓存 / 后台刷新开关（「设置 → Gitee 企业项目」那一页）──────────
      //
      // 为什么不走 cordis 插件配置表单：那套表单只出现在「设置 → 插件 → 插件管理」
      // 的格子里，而使用者的心智是「Gitee 的事都在 Gitee 那一页配」。
      // 这里写的是本地覆盖（`$DSH_HOME/.gitee-chat/config.json`），宿主每次现读，
      // 所以点保存就生效，不用重启。
      if (route === '/settings' && method === 'GET') {
        if (deps.settings === undefined) {
          writeJson(res, 501, { ok: false, code: 'unsupported', message: '宿主没有提供设置服务（旧版本或只读部署）' })
          return
        }
        const values = deps.settings.resolve()
        writeJson(res, 200, { ok: true, values, path: deps.settings.path })
        return
      }

      if (route === '/settings' && method === 'POST') {
        if (deps.settings === undefined) {
          writeJson(res, 501, { ok: false, code: 'unsupported', message: '宿主没有提供设置服务（旧版本或只读部署）' })
          return
        }
        const body = (await readJsonBody(req)) as {
          cache?: Record<string, unknown>
          autoRefresh?: Record<string, unknown>
        } | null
        const cache = body?.cache
        const autoRefresh = body?.autoRefresh
        if (
          (cache === undefined || typeof cache !== 'object' || cache === null)
          && (autoRefresh === undefined || typeof autoRefresh !== 'object' || autoRefresh === null)
        ) {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '至少要给 cache 或 autoRefresh 一项' })
          return
        }
        // 只取认识的键：多余字段不透传到配置文件里（免得手滑写入垃圾键）
        const patch: SettingsPatch = {}
        if (cache !== undefined && cache !== null) {
          patch.cache = {}
          if (typeof cache.agentReadable === 'boolean') patch.cache.agentReadable = cache.agentReadable
          if (typeof cache.persist === 'boolean') patch.cache.persist = cache.persist
          if (typeof cache.ttlSeconds === 'number') patch.cache.ttlSeconds = cache.ttlSeconds
        }
        if (autoRefresh !== undefined && autoRefresh !== null) {
          patch.autoRefresh = {}
          if (typeof autoRefresh.enabled === 'boolean') patch.autoRefresh.enabled = autoRefresh.enabled
          if (typeof autoRefresh.intervalSeconds === 'number') patch.autoRefresh.intervalSeconds = autoRefresh.intervalSeconds
          if (typeof autoRefresh.idleMinutes === 'number') patch.autoRefresh.idleMinutes = autoRefresh.idleMinutes
        }
        const values = deps.settings.write(patch)
        writeJson(res, 200, { ok: true, values, path: deps.settings.path })
        return
      }

      // ── AI 起草 PR 的投递目标（按仓库记住工作区 + 会话）──────────────
      //
      // 为什么需要：同一个 Gitee 项目下的仓库可能分属不同工作区，而工作区之间有
      // 权限边界（有的只有「本区可改」）。起草时要在这个仓库对应的会话/工作区里
      // 起子智能体，否则子智能体拿不到该仓库的本地上下文。配一次之后自动带出。
      if (route === '/draft-target' && method === 'GET') {
        if (deps.settings === undefined) {
          writeJson(res, 501, { ok: false, code: 'unsupported', message: '宿主没有提供设置服务（旧版本或只读部署）' })
          return
        }
        const repoKey = url.searchParams.get('repo') ?? ''
        if (repoKey === '') {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 repo 参数（path_with_namespace 或仓库 id）' })
          return
        }
        writeJson(res, 200, { ok: true, target: deps.settings.getDraftTarget(repoKey) ?? null })
        return
      }

      if (route === '/draft-target' && method === 'POST') {
        if (deps.settings === undefined) {
          writeJson(res, 501, { ok: false, code: 'unsupported', message: '宿主没有提供设置服务（旧版本或只读部署）' })
          return
        }
        const body = (await readJsonBody(req)) as {
          repo?: unknown
          sessionId?: unknown
          sessionTitle?: unknown
          workspaceTitle?: unknown
          deliverSubagent?: unknown
          clear?: unknown
        } | null
        const repoKey = typeof body?.repo === 'string' ? body.repo.trim() : ''
        if (repoKey === '') {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 repo（path_with_namespace 或仓库 id）' })
          return
        }
        if (body?.clear === true) {
          deps.settings.setDraftTarget(repoKey, null)
          writeJson(res, 200, { ok: true, target: null })
          return
        }
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
        if (sessionId === '') {
          writeJson(res, 400, { ok: false, code: 'bad-request', message: '需要 sessionId（要投递的会话）' })
          return
        }
        const target: DraftTarget = {
          sessionId,
          sessionTitle: typeof body?.sessionTitle === 'string' ? body.sessionTitle : '',
          workspaceTitle: typeof body?.workspaceTitle === 'string' ? body.workspaceTitle : '',
          // 勾选框状态与工作区/会话一起存（缺省 = 子智能体）
          deliverSubagent: body?.deliverSubagent === false ? false : true,
          at: new Date().toISOString(),
        }
        writeJson(res, 200, { ok: true, target: deps.settings.setDraftTarget(repoKey, target) ?? null })
        return
      }

      if (route === '/role' && method === 'GET') {
        // 读缓存即可：人格由挂载期预热，浏览器不该为了看一眼身份而触发一次 API 拉取。
        const cached = deps.role.current()
        writeJson(res, 200, cached === null
          ? { ok: false, resolved: false, ...deps.role.snapshot() }
          : { ok: true, resolved: true, ...cached })
        return
      }

      if (route === '/preview' && method === 'GET') {
        // 看板卡片的自包含预览（由 `npm run render-check` 产出）。
        // 存在的意义：让「卡片长什么样」可以直接在浏览器里看，
        // 而不必先跑一轮模型对话去触发工具。
        const file = join(packageRoot(), '.tmp', 'preview', 'board-preview.html')
        if (!existsSync(file)) {
          writeJson(res, 404, {
            ok: false,
            code: 'bad-request',
            message: '预览尚未生成。在开发仓库里跑 `npm run render-check` 后再访问（产物在 .tmp/preview/）。',
          } satisfies ErrorResponse)
          return
        }
        const html = readFileSync(file)
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': html.byteLength,
        })
        res.end(html)
        return
      }

      if (route === '/payload' && method === 'POST') {
        const body = (await readJsonBody(req)) as {
          scope?: unknown
          program?: unknown
          refresh?: unknown
        } | null
        const scope: BoardScope = body?.scope === 'mywork' ? 'mywork' : 'portfolio'
        const program = typeof body?.program === 'number' && Number.isFinite(body.program)
          ? body.program
          : undefined
        const result = await deps.runner.run({ scope, program, refresh: body?.refresh === true })
        const payloadResponse: PayloadResponse = {
          ok: true,
          payload: result.payload,
          cached: result.cached,
          degraded: result.degraded || result.payload.source === 'fixture',
          // 时效性（用户口径 m02223「让 AI 和人都知道」）：界面顶部显示「数据 N 秒前」，
          // 超过新鲜期时再标黄；AI 侧由 `gitee_board` / `gitee_board_snapshot` 输出同一组数字。
          freshness: {
            fetchedAt: result.fetchedAt,
            ageSeconds: Math.round(result.ageMs / 1000),
            stale: result.stale,
            ttlSeconds: Math.round(result.ttlMs / 1000),
            source: result.source,
          },
        }
        writeJson(res, 200, payloadResponse)
        return
      }

      writeJson(res, 404, { ok: false, code: 'bad-request', message: `未知路由 ${method} ${route}` } satisfies ErrorResponse)
    } catch (error) {
      const { status, body } = errorResponse(error)
      writeJson(res, status, body)
    }
  }
}
