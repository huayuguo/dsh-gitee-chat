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
 * `host/mcp-docs` 委派 MCP 工具（这是本层的纪律）。
 * **唯一的例外**是仓库 WIKI 的正文：Gitee 没有任何 HTTP 接口能列它
 * （实测企业 API 全 404、开放 API 是 405），只有 git 形态
 * `{path_with_namespace}.wiki.git` —— 见 `host/wikiCache.ts`。
 * `sessionId` 是必带参数 —— 它是拿到 agent 作用域的唯一钥匙。
 *
 * 每个请求都过与 /api 网关同款的 browser-trust fence（loopback 或部署的
 * trustedHosts，且同源）。这是 DNS-rebinding / 跨站防御，不是认证。
 *
 * **写路由额外要求 `sessionId` 属于一个 Gitee 模式的会话** ——
 * 这条路由挂在 profile 层，浏览器只要在 loopback 就能打到；
 * 用它把"谁能写"收敛到"确实开着 Gitee 模式的会话"。
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
import { listEnterprises, switchEnterprise } from './enterprise.ts'
import type { RoleResolver } from './role.ts'
import type { McpInspection } from './mcpBinary.ts'
import type {
  BoardScope,
  ErrorResponse,
  IssueWriteRequest,
  PayloadResponse,
} from '../types.ts'

/** 路由前缀（webServer 以 prefix 注册，内部按 pathname 分派）。 */
export const ROUTE_PREFIX = '/api/gitee-chat'

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
  /** 身份/人格解析器（/role 直接读缓存，不触发新的脚本执行）。 */
  readonly role: RoleResolver
  /** **唯一写入口**（改状态 / 评论 / 改派）。 */
  readonly writer: IssueWriter
  /** 当前部署的可信 authority 列表（来自 webRuntime；缺失时只用 loopback）。 */
  readonly trustedHosts: () => readonly string[]
  readonly version: string
  /**
   * 随包 MCP 后端的只读状态（供 /ping 与 /health 诊断）。
   * 必须只读：GET 不该有副作用，落地动作在装配期做。
   */
  readonly mcp: () => McpInspection
  /**
   * 知识库文档服务（编排层）。
   *
   * 路由只调它的方法，**不自己拼 Gitee 文档端点** —— 文档能力的唯一实现是 MCP，
   * 见 `host/mcpDocs.ts`。
   */
  readonly docs: DocService
  /**
   * 仓库与仓库 WIKI 的编排层（J 层）。
   *
   * 列表同样只走 MCP；WIKI 正文走 git（Gitee 没有 HTTP 接口），
   * 理由与边界见 `host/wikiCache.ts`。
   */
  readonly repos: RepoService
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

    try {
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
        const data = await deps.runner.execJson<unknown>(args, deps.runner.fixtureFallback)
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
        const data = await deps.runner.execJson<unknown>(args, deps.runner.fixtureFallback)
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
        const data = await deps.runner.execJson<unknown>(['states', '--type', String(typeId)], deps.runner.fixtureFallback)
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
        const data = await deps.runner.execJson<unknown>(['members', '--program', String(program)], deps.runner.fixtureFallback)
        writeJson(res, 200, { ok: true, ...(data as object) })
        return
      }

      // ── 知识库文档（全部委派 MCP）──────────────────────
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
      // 插件再把文本读回来。**插件不自己取 attach_files 端点**。
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

      // ── 仓库 + 仓库 WIKI（J 层）────────────────────────
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
      // 三条约束，缺一不可：
      //   1. 过浏览器信任栅栏（函数入口已经做了）；
      //   2. `sessionId` 必须属于一个 **Gitee 模式的会话** —— 这条路由挂在
      //      profile 层，任何人只要在 loopback 上就能打到，用它把"谁能写"
      //      收敛到"确实开着 Gitee 模式的会话"；
      //   3. 具体动作由 `deps.writer` 单点校验与执行（见 host/write.ts）。
      if (route === '/write' && method === 'POST') {
        const body = (await readJsonBody(req)) as Partial<IssueWriteRequest> | null
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        const gitee = sessionId === '' ? undefined : await deps.isGiteeSession(sessionId)
        if (gitee !== true) {
          writeJson(res, 403, {
            ok: false,
            code: 'forbidden',
            message: gitee === undefined
              ? '无法确认该会话的模式，拒绝写入（请刷新页面后重试）'
              : '该会话未使用 Gitee 模式，拒绝写入',
          } satisfies ErrorResponse)
          return
        }
        const result = await deps.writer.write({
          op: body?.op as IssueWriteRequest['op'],
          ident: String(body?.ident ?? ''),
          stateId: typeof body?.stateId === 'number' ? body.stateId : undefined,
          body: typeof body?.body === 'string' ? body.body : undefined,
          assigneeId: typeof body?.assigneeId === 'number' ? body.assigneeId : undefined,
          sessionId,
        })
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
        const file = join(packageRoot(), 'preview', 'board-preview.html')
        if (!existsSync(file)) {
          writeJson(res, 404, {
            ok: false,
            code: 'bad-request',
            message: '预览尚未生成。在包目录执行 `node scripts/render-check.mjs` 后再访问。',
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
