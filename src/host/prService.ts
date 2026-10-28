/**
 * 合并请求（PR）编排层（host 平面，0.5.4）。
 *
 * 分工与 `repoService` / `docService` 一致：
 *   - 数据一律经 `mcpDocs` 委派 MCP 工具，**这里不拼 Gitee 端点**；
 *   - 这一层只做：选视角、拼详情、把 MCP 报错翻成**白话 + 机器码**、
 *     给 AI 审核渲染 prompt。
 *
 * ## 三条纪律（来自 M0 实测，2026-10-26）
 *
 *   1. **权限不猜**：`auth` 只认 `get_enterprise_pull_auth` 的返回；
 *      取不到就是 `null`，界面显示「权限未知」。
 *   2. **写动作后重新取详情**：不自己推演状态（审查人 state、checkState 都由服务端定）。
 *   3. **驳回是半终态**：同一审查人 reject 后再 accept 会被服务端 400 拒；
 *      必须先 `action=reset` 再审 —— 这条要作为白话提示回到界面。
 *
 * @module dsh-gitee-chat/host/prService
 */

import type { Runner } from './gq.ts'
import { findLocalRepo, localCompare } from './localRepo.ts'
import type { McpDocs } from './mcpDocs.ts'
import type { PrTemplates } from './prTemplates.ts'
import type {
  PrActionRequest,
  PrAiReviewRequest,
  PrAuth,
  PrComment,
  PrCounts,
  PrCreateRequest,
  PrCreateResult,
  PrDetail,
  PrFile,
  PrListResponse,
  PrPerson,
  PrSummary,
  PrTemplatesResponse,
} from '../types.ts'

/** 审查/测试人数：缺省 1，夹在 0–10（0 = 这个 PR 不要求审查/测试）。 */
function clampCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1
  return Math.min(10, Math.max(0, Math.trunc(value)))
}

/** 编排层依赖。 */
export interface PrServiceDeps {
  readonly docs: McpDocs
  readonly templates: PrTemplates
  /** 取数脚本：`compare`（分支比对）走它 —— MCP 没有「比较两个分支」的工具。 */
  readonly runner: Runner
  /** 会话工作目录（本地仓库快路径用；缺省时只走远端 compare）。 */
  readonly cwdOf?: (sessionId: string) => string
}

/** 带机器码的 PR 错误（路由层直接翻成 Envelope）。 */
export class PrError extends Error {
  readonly code: string
  readonly hint: string
  readonly status: number

  constructor(code: string, message: string, hint = '', status = 400) {
    super(message)
    this.name = 'PrError'
    this.code = code
    this.hint = hint
    this.status = status
  }
}

/** 列表查询参数。 */
export interface PrListQuery {
  scope: 'assign' | 'test' | 'create' | 'all'
  state: 'opened' | 'merged' | 'closed' | 'all'
  repoId?: number
  q?: string
  page?: number
}

/** MCP 的 scope 枚举：我们把界面 4 个视角翻成 MCP 认识的值。 */
function mcpScopeOf(scope: PrListQuery['scope']): string {
  if (scope === 'assign') return 'assign'
  if (scope === 'test') return 'test'
  if (scope === 'create') return 'create'
  return 'related_to_me'
}

/** 把 MCP 报错翻成白话。 */
function toPrError(error: unknown): PrError {
  if (error instanceof PrError) return error
  const message = error instanceof Error ? error.message : String(error)

  if (/已对该pr标记了|已对该\s*pr\s*标记/i.test(message)) {
    return new PrError(
      'already-reviewed',
      '你已把该 PR 标记为「不通过」，不能直接改成通过。',
      '先点「撤销我的审查」（action=reset），再重新审核通过。',
    )
  }
  // 企业版对「撤销一个本来就没有结论的审查」回 400「目标不存在或状态错误」——
  // 这不是故障，是「没什么可撤」，要给人话（实测于 2026-10-26，PR !3 checkState=1 未审）。
  if (/目标不存在或状态错误/.test(message)) {
    return new PrError(
      'nothing-to-reset',
      '这条审查线现在没有可撤销的结论（没人标记过「不通过」）。',
      '只有在你（或别人）标记过「不通过」之后才需要撤销；如果是想开启审查流程，用「仅开启审核流程」。',
      )
  }
  if (/审查失败/.test(message)) {
    return new PrError(
      'check-failed',
      `审查没有成功：${message}`,
      '确认你是该 PR 的审查人、且 PR 仍在打开状态；如果你之前已经标记过结论（通过或不通过），要先「撤销我的审查」才能改判。',
    )
  }
  if (/测试失败/.test(message)) {
    return new PrError('test-failed', `测试没有成功：${message}`, '确认你是该 PR 的测试人；开启测试流程后才能通过。')
  }
  if (/not.*merge|不能合并|无法合并|merge.*fail/i.test(message)) {
    return new PrError(
      'not-mergeable',
      '当前还不能合并。',
      '合并要求审查与测试都通过（checkState=2 且 testState=2），并且没有冲突。',
    )
  }
  if (/403|401|forbidden|未授权|权限/.test(message)) {
    return new PrError(
      'forbidden',
      `没有权限：${message}`,
      '该 token 缺「拉取请求」写权限，或你在此仓库没有对应角色。到「设置 → Gitee 企业项目」确认 token。',
    )
  }
  if (/UNKNOWN_TOOL/i.test(message)) {
    return new PrError(
      'unknown-tool',
      'MCP 里没有这个 PR 工具。',
      '随包 MCP 二进制需要 0.2.5-dsh.7 及以上（新增了审查/测试/权限/文件 4 个工具，'
        + '且 PR 工具参数已按上游 v0.2.5 改名为 pull_request_iid）；重装插件或重建二进制。',
      500,
    )
  }
  if (/no-token|缺少.*token|令牌/i.test(message)) {
    return new PrError('no-token', '没有找到企业 token。', '打开「设置 → Gitee 企业项目」粘贴企业版 token。')
  }
  return new PrError('pr-failed', message, '稍后重试；如果一直失败，把这条错误发给维护者。', 500)
}

/** 由列表行算「我是否待办」——计数用，不去逐个取 auth（那会很慢）。 */
function pendingReview(item: PrSummary): boolean {
  return item.state === 'opened' && item.checkState === 1
}

function pendingTest(item: PrSummary): boolean {
  return item.state === 'opened' && item.testState === 1
}

/** 渲染 AI 审核 / 测试的 prompt。 */
function renderPrompt(input: {
  kind: 'review' | 'test'
  template: string
  detail: PrDetail
  files: PrFile[]
  scope: 'full' | 'code-only' | 'files'
  onlyFiles: string[]
  autoApprove: boolean
}): string {
  const { kind, template, detail, files, scope, onlyFiles, autoApprove } = input

  let picked = files
  if (scope === 'files') {
    const wanted = new Set(onlyFiles)
    picked = files.filter((f) => wanted.has(f.filename))
  }
  // 体量护栏：diff 太长就截断（模型侧有上下文上限，截断比报错友好）。
  //
  // 2026-10-27：上限 60k → 32k，并先剔掉「锁文件 / 构建产物 / 压缩产物 / 快照」。
  // 理由：这些文件的 diff 动辄几千行，对审核结论几乎没有信息量，却能把预算吃干，
  // 逼着我们截断真正要看的源码（一次审核 60k 字符 ≈ 2 万 token，剔除后常见 1/3）。
  const MAX_DIFF = 32_000
  const NOISE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|go\.sum|\.lock)$|(^|\/)(dist|build|out|node_modules|vendor)\/|\.min\.(js|css)$|\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|map)$|(__snapshots__|fixtures?)\//i
  let used = 0
  let truncated = false
  const skipped: string[] = []
  const chunks: string[] = []
  for (const file of picked) {
    const isCode = /\.(go|ts|tsx|js|mjs|cjs|py|java|kt|rs|c|h|cc|cpp|hpp|cs|php|rb|swift|sh|sql|json|ya?ml|toml|md)$/i.test(file.filename)
    if (scope === 'code-only' && !isCode) continue
    if (NOISE.test(file.filename)) {
      skipped.push(file.filename)
      continue
    }
    const head = `\n### ${file.filename} (${file.status} +${file.additions}/-${file.deletions})\n`
    const room = MAX_DIFF - used - head.length
    if (room <= 200) {
      truncated = true
      break
    }
    const body = file.diff.length > room ? `${file.diff.slice(0, room)}\n…（diff 已截断）` : file.diff
    used += head.length + body.length
    chunks.push(head + '```diff\n' + body + '\n```\n')
    if (body.length < file.diff.length) {
      truncated = true
      break
    }
  }

  const autoLine = autoApprove
    ? kind === 'review'
      ? '自动通过：**开**。若结论是「可以合并」（没有任何阻断项），请在评论后调用 `review_enterprise_pull`（action=accept）；结论有阻断项则只评论、把 action 交给人。'
      : '自动通过：**开**。若测试结论是「通过」，请在评论后调用 `test_enterprise_pull`。'
    : '自动通过：**关**。只输出结论与评论，**不要**调用 `review_enterprise_pull` / `test_enterprise_pull` / `merge_enterprise_pull`，通过与否由人点。'

  return [
    `# 用下面的模板${kind === 'review' ? '审查' : '验收测试'}这个 PR`,
    '',
    `PR：${detail.repoPath === '' ? '（仓库未知）' : detail.repoPath} !${detail.iid} · ${detail.title}`,
    `分支：${detail.sourceBranch} → ${detail.targetBranch}`,
    `状态：${detail.state} · 审查 ${detail.checkState} · 测试 ${detail.testState}`,
    '',
    '## 模板（必须按它的结构与分级来写结论）',
    '',
    template.trim(),
    '',
    '## 变更',
    '',
    picked.length === 0 ? '（没有取到变更文件）' : chunks.join(''),
    skipped.length === 0
      ? ''
      : `\n> 已省略 ${skipped.length} 个不含审核信息的文件（锁文件 / 构建产物 / 压缩资源 / 二进制）：${skipped.slice(0, 8).join('、')}${skipped.length > 8 ? ' 等' : ''}\n`,
    truncated ? `\n> 注意：diff 已截断（超出 ${MAX_DIFF / 1000}k 字符），结论里说明这一点。\n` : '',
    '## 硬约束',
    '',
    '1. **只读**：不要改仓库、不要改 PR 标题、不要合并。',
    '2. 结论写成 Markdown：结论一句 + 分级清单（阻断 / 重要 / 次要 / nit），每条必须带 `文件:行`。',
    `3. 用 \`comment_enterprise_pull\` 把结论发到这个 PR（project_id=${detail.repoId}，pull_request_iid=${detail.iid}）。`,
    `4. ${autoLine}`,
    '5. 结论基于给定 diff；看不到的上下文要写明「未验证」，不要臆测。',
    '6. **最终回复只写结论正文**：它会被原样展示在面板上，不要复述工具调用、不要写「评论已发布 / 下一步我将…」这类过程说明，也不要自我复盘。',

  ].join('\n')
}

/** 创建 PR 编排服务。 */
export function createPrService(deps: PrServiceDeps) {
  // `runner` 必须一起解构：`draftPull` 里用 `runner.execJson(['compare', …])` 取分支比对，
  // 漏解构时运行期就是 `ReferenceError: runner is not defined`（0.5.4 实测报错原文）。
  const { docs, templates, runner } = deps

  /** 当前用户 id（缓存 60s，避免每次列表都打一次 get_user_info）。 */
  let meCache: { at: number; id: number; name: string } | null = null
  /**
   * 仓库路径兜底（建 PR 的链接用）。
   *
   * MCP 的 `create_enterprise_repo_pull` 不回 `html_url`，而面板可能没传 `repoPath`。
   * 这里按 repoId 去仓库列表里补一次 `path_with_namespace`（60s 缓存，最多 2 页），
   * 补不到就不拼链接（返回空串，宁可没链接也别给一个 404 的死链）。
   */
  let repoPathCache: { at: number; map: Map<number, string> } | null = null
  async function repoPathOf(sessionId: string, repoId: number, given: string): Promise<string> {
    if (given !== '') return given
    if (repoPathCache === null || Date.now() - repoPathCache.at > 60_000) {
      const map = new Map<number, string>()
      try {
        for (const page of [1, 2]) {
          const repos = await docs.listRepositories(sessionId, { perPage: 100, page })
          for (const repo of repos) map.set(repo.repoId, repo.pathWithNamespace)
          if (repos.length < 100) break
        }
      } catch {
        // 补不到就用空串：建 PR 本身已经成功了，不能因为补链接失败而报错
      }
      repoPathCache = { at: Date.now(), map }
    }
    return repoPathCache.map.get(repoId) ?? ''
  }

  async function me(sessionId: string): Promise<{ id: number; name: string }> {
    if (meCache !== null && Date.now() - meCache.at < 60_000) return meCache
    try {
      const user = await docs.currentUser(sessionId)
      meCache = { at: Date.now(), id: user.id, name: user.name }
      return meCache
    } catch {
      return { id: 0, name: '' }
    }
  }

  /** 取详情（含文件/评论/权限），任一块失败都不影响其它块。 */
  async function detail(sessionId: string, repoId: number, iid: number): Promise<PrDetail> {
    if (repoId <= 0 || iid <= 0) throw new PrError('bad-request', 'repoId 与 iid 必须是正数。')
    let raw: Record<string, unknown>
    try {
      raw = await docs.getPullDetail(sessionId, { repoId, iid })
    } catch (error) {
      throw toPrError(error)
    }
    if (raw.id === undefined) throw new PrError('not-found', `没有找到 PR !${iid}。`, '确认仓库与 PR 序号；也可能该 token 无权访问。', 404)

    const [files, comments, authResult] = await Promise.all([
      docs.listPullFiles(sessionId, { repoId, iid }).catch(() => [] as PrFile[]),
      docs.listPullComments(sessionId, { repoId, iid }).catch(() => [] as PrComment[]),
      docs
        .getPullAuth(sessionId, { repoId, iid })
        .then((auth: PrAuth | null) => ({ auth, hint: auth === null ? '服务端没有返回权限信息（可能你不是审查人/测试人）。' : '' }))
        .catch((error: unknown) => ({
          auth: null as PrAuth | null,
          hint: `取权限失败：${error instanceof Error ? error.message : String(error)}`,
        })),
    ])

    // 详情里的行级信息由 mcpDocs 归一（同一套 toPrSummary），这里补上附加字段。
    const summary = detailSummaryOf(raw)
    const assignees = arrayOf(raw.assignees).map(toPerson)
    const testers = arrayOf(raw.testers).map(toPerson)
    return {
      ...summary,
      body: typeof raw.body === 'string' ? raw.body : '',
      bodyHtml: typeof raw.body_html === 'string' ? raw.body_html : '',
      assignees,
      testers,
      auth: authResult.auth,
      authHint: authResult.hint,
      files,
      comments,
      commitsCount: typeof raw.commits_count === 'number' ? raw.commits_count : 0,
      canChangeAssigner: raw.can_change_pr_assigner === true,
      canChangeTester: raw.can_change_pr_tester === true,
    }
  }

  return {
    /** 列 PR + 4 张分类卡的数字。 */
    async list(sessionId: string, query: PrListQuery): Promise<PrListResponse> {
      const state = query.state === 'all' ? undefined : query.state
      const page = query.page ?? 1
      const [main, byAssign, byTest, byCreate] = await Promise.all([
        docs
          .listPulls(sessionId, {
            scope: mcpScopeOf(query.scope),
            ...(state === undefined ? {} : { state }),
            ...(query.repoId === undefined ? {} : { repoId: query.repoId }),
            ...(query.q === undefined || query.q === '' ? {} : { search: query.q }),
            page,
            perPage: 20,
          })
          .catch((error: unknown) => {
            throw toPrError(error)
          }),
        docs.listPulls(sessionId, { scope: 'assign', state: 'opened', perPage: 50 }).catch(() => ({ items: [] as PrSummary[], total: 0 })),
        docs.listPulls(sessionId, { scope: 'test', state: 'opened', perPage: 50 }).catch(() => ({ items: [] as PrSummary[], total: 0 })),
        docs.listPulls(sessionId, { scope: 'create', state: 'opened', perPage: 50 }).catch(() => ({ items: [] as PrSummary[], total: 0 })),
      ])

      // 「可合并」要按 PR 去重：同一个 PR 可能既是「待我审核」又是「待我测试」，
      // 直接拼三个列表会把一张卡算两遍。
      const mergeableKeys = new Set(
        [...byAssign.items, ...byTest.items, ...byCreate.items]
          .filter((item) => item.mergeable && item.state === 'opened')
          .map((item) => `${item.repoId ?? 0}:${item.iid}`),
      )
      const counts: PrCounts = {
        review: byAssign.items.filter(pendingReview).length,
        test: byTest.items.filter(pendingTest).length,
        mine: byCreate.items.length,
        mergeable: mergeableKeys.size,
      }
      return { items: main.items, total: main.total, page, counts, scope: query.scope, state: query.state }
    },

    /** 详情。 */
    detail,

    /** 写动作：执行后重新取详情。 */
    async action(sessionId: string, request: PrActionRequest): Promise<PrDetail> {
      const { repoId, iid } = request
      if (repoId <= 0 || iid <= 0) throw new PrError('bad-request', 'repoId 与 iid 必须是正数。')

      try {
        switch (request.action) {
          case 'check': {
            await docs.reviewPull(sessionId, { repoId, iid, action: request.mode })
            if (request.comment !== undefined && request.comment.trim() !== '') {
              await docs.commentPull(sessionId, { repoId, iid, body: request.comment }).catch(() => undefined)
            }
            break
          }
          case 'test': {
            await docs.testPull(sessionId, { repoId, iid })
            if (request.comment !== undefined && request.comment.trim() !== '') {
              await docs.commentPull(sessionId, { repoId, iid, body: request.comment }).catch(() => undefined)
            }
            break
          }
          case 'merge':
            await docs.mergePull(sessionId, { repoId, iid, method: request.method })
            break
          case 'comment':
            if (request.body.trim() === '') throw new PrError('bad-request', '评论不能为空。')
            await docs.commentPull(sessionId, { repoId, iid, body: request.body })
            break
          case 'state':
            await docs.updatePull(sessionId, { repoId, iid, patch: { state_event: request.event } })
            break
          case 'openCheck':
            await docs.updatePull(sessionId, { repoId, iid, patch: { check_state: 1 } })
            break
          case 'openTest':
            await docs.updatePull(sessionId, { repoId, iid, patch: { test_state: 1 } })
            break
          default: {
            const never: never = request
            throw new PrError('bad-request', `未知动作：${JSON.stringify(never)}`)
          }
        }
      } catch (error) {
        throw toPrError(error)
      }
      return detail(sessionId, repoId, iid)
    },

    /**
     * 建 PR —— UI 对话框与 agent 直接调 MCP 共用这一份校验。
     *
     * 本地只拦「显然错」的（空标题、源=目标、人数越界），分支不存在 / 无权限 /
     * 目标分支保护这些交给 Gitee，再由 `toPrError` 翻成可行动文案。
     */
    async create(sessionId: string, input: PrCreateRequest): Promise<PrCreateResult> {
      // 全部按「可能是 undefined」处理：HTTP 入参不保证类型（`{}` 这种空体也会打进来），
      // 这里先归一成空串，再交给下面的必填校验报人话，而不是抛 `.trim of undefined`。
      const sourceBranch = typeof input.sourceBranch === 'string' ? input.sourceBranch.trim() : ''
      const targetBranch = typeof input.targetBranch === 'string' ? input.targetBranch.trim() : ''
      const title = typeof input.title === 'string' ? input.title.trim() : ''
      const body = typeof input.body === 'string' ? input.body.trim() : ''
      if (!Number.isFinite(input.repoId) || input.repoId <= 0) {
        throw new PrError('bad-request', '缺少仓库（repoId）。', '从仓库详情页的「合并请求」进入会自带仓库。')
      }
      if (sourceBranch === '') throw new PrError('bad-request', '源分支不能为空。', '填你推上去的开发分支，比如 feature/xxx。')
      if (targetBranch === '') throw new PrError('bad-request', '目标分支不能为空。', '一般是 master / main。')
      if (sourceBranch === targetBranch) {
        throw new PrError('bad-request', `源分支与目标分支相同（${sourceBranch}）。`, '换成你的开发分支，目标分支留 master。')
      }
      if (title === '') throw new PrError('bad-request', '标题不能为空。')

      let raw: Record<string, unknown>
      try {
        raw = await docs.createPull(sessionId, {
          repoId: input.repoId,
          ...(input.repoPath === undefined || input.repoPath === '' ? {} : { repoPath: input.repoPath }),
          sourceBranch,
          targetBranch,
          title,
          ...(body === '' ? {} : { body }),
          prAssignNum: clampCount(input.prAssignNum),
          prTestNum: clampCount(input.prTestNum),
          draft: input.draft === true,
        })
      } catch (error) {
        throw toPrError(error)
      }

      const iid = typeof raw.iid === 'number' ? raw.iid : typeof raw.number === 'number' ? raw.number : 0
      if (iid <= 0) {
        throw new PrError('bad-request', 'Gitee 没有返回 PR 序号，建 PR 可能没成功。', JSON.stringify(raw).slice(0, 300), 502)
      }
      const repoPath = input.repoPath ?? (typeof raw.repo_path === 'string' ? raw.repo_path : '')
      const url = typeof raw.html_url === 'string' && raw.html_url !== ''
        ? raw.html_url
        : `https://gitee.com/${await repoPathOf(sessionId, input.repoId, repoPath)}/pulls/${iid}`
      return { iid, url, title }
    },

    /** 模板：读 / 存。 */
    templates(repoPath: string): PrTemplatesResponse {
      return templates.active(repoPath)
    },

    saveTemplate(input: {
      name: string
      content: string
      repoPath?: string | null
      kind?: 'review' | 'test' | 'pr' | null
    }) {
      try {
        return templates.save(input)
      } catch (error) {
        throw new PrError('bad-request', error instanceof Error ? error.message : String(error))
      }
    },

    /**
     * 起草 PR 标题与正文（渲染 prompt，不发送）。
     *
     * 数据面：`gq compare --repo <id> --base <目标> --head <源> --patches`
     * （企业版 `/projects/{id}/compare/{base}...{head}`；MCP 没有这个能力）。
     * 写作要求来自 `pr-guide` 模板（带每节说明的那份，不是干净骨架）。
     */
    async draftPull(
      sessionId: string,
      input: { repoId: number; repoPath?: string; sourceBranch: string; targetBranch: string },
    ): Promise<{ prompt: string; preview: string; commits: number; files: number; source: 'local' | 'remote' }> {
      const repoPath = input.repoPath ?? ''
      const args = [
        'compare',
        '--repo', String(input.repoId),
        '--base', input.targetBranch,
        '--head', input.sourceBranch,
        '--patches',
      ]
      let cmp: {
        commits: Array<{ shortId: string; title: string; author: string }>
        diffs: Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }>
        tooManyCommits: boolean
      }
      // 快路径：会话工作目录里就有这个仓库的克隆 → 直接用本地 git 比对（毫秒级、diff 完整）。
      // 只在「分支在本地都能解析」时生效；否则安静回落远端 compare（本地没 fetch 也很常见）。
      let source: 'local' | 'remote' = 'remote'
      const localHit = (() => {
        const cwd = deps.cwdOf?.(sessionId) ?? ''
        if (cwd === '') return undefined
        const root = findLocalRepo(cwd, repoPath)
        if (root === undefined) return undefined
        return localCompare(root, input.targetBranch, input.sourceBranch)
      })()
      if (localHit !== undefined && (localHit.commits.length > 0 || localHit.diffs.length > 0)) {
        cmp = localHit
        source = 'local'
      } else {
        try {
          cmp = await runner.execJson<typeof cmp>(args, runner.fixtureFallback)
        } catch (error) {
          throw toPrError(error)
        }
      }
      if (cmp.commits.length === 0 && cmp.diffs.length === 0) {
        throw new PrError(
          'nothing-to-compare',
          '这两个分支之间没有差异，写不出 PR 内容。',
          '确认源分支已经 push 过、且确实包含了目标分支没有的提交。',
        )
      }
      const guide = templates.resolve('prGuide', repoPath)
      const prompt = renderDraftPrompt({
        repoPath,
        repoId: input.repoId,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        commits: cmp.commits,
        diffs: cmp.diffs,
        // 说明版开头有一段 HTML 注释（是写给人看的元信息），塞进 prompt 只是浪费 token
        guide: guide.content.replace(/<!--[\s\S]*?-->/g, '').trim(),
        tooManyCommits: cmp.tooManyCommits,
      })
      return {
        prompt,
        preview: prompt.slice(0, 600),
        commits: cmp.commits.length,
        files: cmp.diffs.length,
        source,
      }
    },

    /** 渲染 AI prompt（**不发送**：投递由 client 用 ctx.conversation.send 做）。 */
    async aiReview(sessionId: string, repoId: number, request: PrAiReviewRequest): Promise<{ prompt: string; preview: string; autoApprove: boolean }> {
      const pr = await detail(sessionId, repoId, request.iid)
      const template = templates.resolve(request.template, pr.repoPath)
      const prompt = renderPrompt({
        kind: request.template,
        template: template.content,
        detail: pr,
        files: pr.files,
        scope: request.scope,
        onlyFiles: request.files ?? [],
        autoApprove: request.autoApprove,
      })
      return {
        prompt,
        preview: prompt.slice(0, 600),
        autoApprove: request.autoApprove,
      }
    },

    /** 当前用户（客户端显示「我」用）。 */
    async me(sessionId: string): Promise<{ id: number; name: string }> {
      return me(sessionId)
    },
  }
}

/**
 * 渲染「AI 起草 PR 标题 + 描述」的 prompt（**只拼字符串，不发送**）。
 *
 * 输入都是真实仓库比对结果（`compare` 的 commits/diffs），所以 prompt 里明确写
 * 「只依据这些数据，不要编造」——AI 起草最怕的就是凭空补一段没发生的改动。
 *
 * 输出协议故意做成**严格 JSON**：客户端拿到后直接填进两个输入框，
 * 不做二次解析（模型偶尔包 ```json 围栏，客户端会剥掉）。
 */
function renderDraftPrompt(input: {
  repoPath: string
  repoId: number
  sourceBranch: string
  targetBranch: string
  commits: Array<{ shortId: string; title: string; author: string }>
  diffs: Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }>
  guide: string
  tooManyCommits: boolean
}): string {
  const L: string[] = []
  L.push('你在为一个**还没创建**的 PR 起草「标题」和「描述」。下面是从 Gitee 真实比对出来的改动，')
  L.push('**只依据这些数据写，不要编造没发生的改动、不要编造测试结果**。信息不够就写「待补充」。')
  // 别让子智能体去「查代码」：它手上已经有 diff，再调工具/读文件只是白白多几轮往返
  // （实测一次起草 40 秒里有大半是这些无谓的工具调用）。
  L.push('**不要调用任何工具**（不要查仓库、不要调 MCP、不要读文件、不要跑命令）：要用的数据都在下面，一次写成。')
  L.push('')
  L.push('## 仓库与分支')
  L.push(`- 仓库：${input.repoPath === '' ? `id ${input.repoId}` : input.repoPath}`)
  L.push(`- 源分支：${input.sourceBranch} → 目标分支：${input.targetBranch}`)
  L.push('')
  L.push(`## 提交（${input.commits.length} 个${input.tooManyCommits ? '，超过服务端上限，只列前 30 个' : ''}）`)
  if (input.commits.length === 0) L.push('- （无提交：可能两个分支内容一致）')
  for (const c of input.commits.slice(0, 30)) L.push(`- ${c.shortId} ${c.title}${c.author === '' ? '' : `（${c.author}）`}`)
  L.push('')
  L.push(`## 改动文件（${input.diffs.length} 个）`)
  for (const d of input.diffs.slice(0, 60)) L.push(`- ${d.filename} · ${d.status} · +${d.additions}/-${d.deletions}`)
  const withPatch = input.diffs.filter((d) => d.patch !== '')
  if (withPatch.length > 0) {
    L.push('')
    L.push('## 关键文件 diff（截断）')
    for (const d of withPatch.slice(0, 8)) {
      L.push('')
      L.push(`### ${d.filename}`)
      L.push('```diff')
      L.push(d.patch.trimEnd())
      L.push('```')
    }
  }
  L.push('')
  L.push('## 写作要求（来自本仓 PR 模板的填写说明）')
  L.push(input.guide.trimEnd())
  L.push('')
  L.push('## 输出格式（**只输出这一段 JSON**，不要解释、不要代码围栏、不要多余文字）')
  L.push('{"title":"<类型>: <一句话，不超过 50 字>","body":"<Markdown 正文，按上面模板的小标题组织>"}')
  return L.join('\n') + '\n'
}

/** 编排服务类型。 */
export type PrService = ReturnType<typeof createPrService>

/** 从原始 JSON 取详情摘要（与 mcpDocs 的 toPrSummary 同口径，避免再引一次私有函数）。 */
function detailSummaryOf(raw: Record<string, unknown>): PrSummary {
  const project = (raw.project ?? {}) as Record<string, unknown>
  const src = (raw.source_branch ?? {}) as Record<string, unknown>
  const tgt = (raw.target_branch ?? {}) as Record<string, unknown>
  const author = (raw.author ?? {}) as Record<string, unknown>
  const assignees = arrayOf(raw.assignees).map(toPerson)
  const testers = arrayOf(raw.testers).map(toPerson)
  const checkState = triState(raw.check_state)
  const testState = triState(raw.test_state)
  const iid = numberOr(raw.iid, 0)
  const repoPath = stringOr(project.path_with_namespace, '')
  return {
    id: numberOr(raw.id, 0),
    iid,
    title: stringOr(raw.title, ''),
    state: raw.state === 'merged' || raw.state === 'closed' ? raw.state : 'opened',
    draft: raw.draft === true,
    repoId: numberOr(project.id, numberOr(raw.project_id, 0)),
    repoPath,
    sourceBranch: stringOr(src.branch, ''),
    targetBranch: stringOr(tgt.branch, ''),
    author: toPerson(author),
    checkState,
    testState,
    prAssignNum: numberOr(raw.pr_assign_num, 0),
    prTestNum: numberOr(raw.pr_test_num, 0),
    checkPassed: assignees.filter((p) => p.state === 1).length,
    testPassed: testers.filter((p) => p.state === 1).length,
    mergeable: raw.can_merge === true && checkState === 2 && testState === 2,
    updatedAt: stringOr(raw.updated_at, ''),
    url: repoPath === '' || iid <= 0 ? '' : `https://gitee.com/${repoPath}/pulls/${iid}`,
  }
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function triState(value: unknown): 0 | 1 | 2 {
  return value === 1 || value === 2 ? value : 0
}

function toPerson(value: unknown): PrPerson {
  const r = (value ?? {}) as Record<string, unknown>
  const state = numberOr(r.state, 0)
  return {
    id: numberOr(r.id, 0),
    name: stringOr(r.name, stringOr(r.username, '')),
    username: stringOr(r.username, ''),
    state: state === 1 ? 1 : state === 2 ? 2 : 0,
  }
}
