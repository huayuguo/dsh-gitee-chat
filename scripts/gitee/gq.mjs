#!/usr/bin/env node
/**
 * gq — dsh-gitee-chat 取数脚本（零依赖 Node ESM）。
 *
 * 设计口径（来自需求方）：
 *   1. **以会话拉取为准 = 最新数据**，不维护任何本地数据库/持久缓存。
 *   2. **AI 只负责触发**：模型调用工具 → 宿主执行本脚本 → 模型只看到 `summary`
 *      摘要（几十 token），全量结构化数据由看板卡片经 HTTP 路由直接取用。
 *      这样「上下文占用」与「数据量」彻底解耦。
 *   3. 只有一个例外允许落盘：同参数的**秒级短时缓存**（`--cache-ttl`），
 *      用来抑制同一轮里卡片与工具重复拉取；默认关闭，且只写 /tmp。
 *
 * 用法（读）：
 *   gq.mjs portfolio [--program ID] [--json] [--fixture] [--enterprise ID]
 *   gq.mjs mywork                          # 我相关的工作项
 *   gq.mjs issues --program ID [--state S] # 单项目工作项
 *   gq.mjs issue --ident DM0001            # 工作项详情：描述/前置依赖/评论讨论
 *   gq.mjs states --type 100           # 某工作项类型的可选状态（改状态用）
 *   gq.mjs members --program ID            # 项目成员（改派用）
 *   gq.mjs role [--mode m] [--program ID]  # 身份 → 人格
 *   gq.mjs enterprises [--use ID|--clear]  # 企业列表 / 切换
 *   gq.mjs matrix                          # 打印能力矩阵
 *   gq.mjs health                          # 环境自检（token/企业/连通性）
 *
 * 用法（写 —— 全包唯一的写出口，见 apiSend）：
 *   gq.mjs set-state --ident DM0001 --state-id 9000001
 *   gq.mjs comment   --ident DM0001 --body-file -      # 正文从 stdin 读
 *   gq.mjs assign    --ident DM0001 --assignee-id 901
 *
 * 输出：
 *   默认  → 紧凑 Markdown 摘要（给人看，可直接进会话）
 *   --json → 完整结构化 payload（给看板卡片渲染用，字段见 buildPayload）
 *
 * 认证（必须同时满足，否则企业版端点返回
 * "Only For MCP Gitee Enterprise Application"）：
 *   Authorization: Bearer <token>
 *   User-Agent:    $GITEE_ENT_USER_AGENT 或内置默认值
 *
 * 可移植性：企业 id、API base、UA、阈值、token 位置全部可从环境变量覆盖，
 * 不写死任何「本机/本公司」的东西。详见 README「换一台机器 / 换一个同事」。
 *
 * @module dsh-gitee-chat/scripts/gq
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  THRESHOLD_DEFAULTS,
  codeMatches,
  codeOfTitle,
  computeCapacity,
  computeDelivery,
  computeMilestones,
  computeProgress,
  parseTemplate,
  resolveRefs,
  resolveThresholds,
} from './analysis.mjs'

/** 与 mcp-gitee-ent 一致的端点基址。 */
export const DEFAULT_API_BASE = 'https://api.gitee.com/enterprises'
/**
 * 企业版端点校验「MCP 应用标识」，缺 UA 直接返回
 * "Only For MCP Gitee Enterprise Application"。
 *
 * ⚠️ 这是**默认值**。Gitee 只校验前缀 `mcp-gitee-ent`，版本段是给日志看的；
 * 换平台/换 MCP 版本时用 `GITEE_ENT_USER_AGENT` 覆盖，不要改代码。
 */
export const MCP_USER_AGENT = 'mcp-gitee-ent 0.1.11 Go/linux/amd64/go1.24.0'

/** 实际使用的 UA：环境变量优先。 */
export function mcpUserAgent(env = process.env) {
  const custom = env.GITEE_ENT_USER_AGENT
  return typeof custom === 'string' && custom.trim() !== '' ? custom.trim() : MCP_USER_AGENT
}

/** 单次取数最多翻几页（100/页）。企业工作项上千时靠它兜住时延。 */
export const DEFAULT_MAX_PAGES = 5

export { THRESHOLD_DEFAULTS, resolveThresholds, parseTemplate, resolveRefs, codeOfTitle, codeMatches }

/** 视为「未完成」的状态（用于逾期判定）。 */
const CLOSED_STATES = new Set(['closed', 'rejected'])

// ── 参数解析 ────────────────────────────────────────────────────────────────

/** 解析 argv 为 { cmd, flags }。 */
function parseArgs(argv) {
  const out = { cmd: argv[0] ?? 'portfolio', flags: {} }
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out.flags[key] = true
    else {
      out.flags[key] = next
      i++
    }
  }
  return out
}

// ── token / 企业解析 ────────────────────────────────────────────────────────

/** 允许的 token 文件位置（按优先级）。只读，不写。 */
function tokenFileCandidates() {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return [
    join(dshHome, '.gitee-chat', 'token'),
    join(dshHome, 'gitee-chat-token'),
    join(homedir(), '.gitee-token'),
  ]
}

/**
 * 解析访问 token：环境变量 → token 文件。
 * @returns {{ token: string, source: string } | null}
 */
export function resolveToken() {
  for (const key of ['GITEE_ENT_MCP_ACCESS_TOKEN', 'GITEE_ACCESS_TOKEN', 'GITEE_TOKEN']) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim() !== '') {
      return { token: value.trim(), source: `env:${key}` }
    }
  }
  for (const path of tokenFileCandidates()) {
    if (!existsSync(path)) continue
    const value = readFileSync(path, 'utf8').trim()
    if (value !== '') return { token: value, source: `file:${path}` }
  }
  return null
}

/**
 * 可写的本地配置（**不是数据库**，只是"选哪个企业"这类一次性设定）。
 * 放在 token 旁边，改完下一次调用即生效——不需要重启 DSH。
 */
export function configPath() {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, '.gitee-chat', 'config.json')
}

/** 读本地配置（缺失/损坏都返回空对象）。 */
export function readConfig() {
  try {
    const path = configPath()
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 写本地配置（合并写入）。 */
export function writeConfig(patch) {
  const path = configPath()
  mkdirSync(join(path, '..'), { recursive: true })
  const next = { ...readConfig(), ...patch }
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n')
  return next
}

/** 当前 API base。 */
export function apiBase() {
  return process.env.GITEE_ENT_API_BASE ?? DEFAULT_API_BASE
}

/**
 * 发起一次企业版 GET。
 * @param {string} path - 以 / 开头的路径（含企业 id 段）。
 * @param {Record<string, string|number|undefined>} params
 * @param {{ token: string, signal?: AbortSignal }} auth
 */
export async function apiGet(path, params, auth) {
  const url = new URL(`${apiBase()}${path}`)
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${auth.token}`,
      'User-Agent': mcpUserAgent(),
    },
    signal: auth.signal,
  })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? '（token 无效或无权限：确认是企业版 MCP token）'
      : ''
    throw new Error(`GET ${url.pathname} → HTTP ${res.status} ${hint} ${text.slice(0, 200)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`GET ${url.pathname} → 响应不是 JSON：${text.slice(0, 200)}`)
  }
}

/**
 * 发起一次企业版写请求（POST / PUT）。
 *
 * **这是全包唯一的写通道实现**：所有改状态的入口（`set-state` / `comment` /
 * `assign` 子命令）最终都汇到这里，便于统一审计与限流。
 *
 * @param {'POST'|'PUT'} method
 * @param {string} path - 以 / 开头的路径（含企业 id 段）
 * @param {Record<string, unknown>} body - JSON 载荷
 * @param {{ token: string, signal?: AbortSignal }} auth
 */
export async function apiSend(method, path, body, auth) {
  const url = new URL(`${apiBase()}${path}`)
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.token}`,
      'User-Agent': mcpUserAgent(),
    },
    body: JSON.stringify(body ?? {}),
    signal: auth.signal,
  })
  const text = await res.text()
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403
      ? '（token 无权执行该写操作，或该操作在 Gitee 侧被限制）'
      : ''
    throw new Error(`${method} ${url.pathname} → HTTP ${res.status} ${hint} ${text.slice(0, 300)}`)
  }
  try {
    return text.trim() === '' ? {} : JSON.parse(text)
  } catch {
    throw new Error(`${method} ${url.pathname} → 响应不是 JSON：${text.slice(0, 200)}`)
  }
}

/** 剥掉 { total_count, data } 分页包装；已是数组则原样返回。 */
function unwrap(value) {
  if (Array.isArray(value)) return value
  if (value && Array.isArray(value.data)) return value.data
  return []
}

/**
 * 解析企业 id：显式参数 → 环境变量 → `/list` 的首个企业。
 * @returns {Promise<{ id: number, name: string, source: string }>}
 */
export async function resolveEnterprise(explicit, auth) {
  if (explicit !== undefined && explicit !== true && Number(explicit) > 0) {
    const id = Number(explicit)
    // 补名字：显式指定时也去 /list 里认一下，否则看板只能显示「企业 <id>」
    let name = ''
    try {
      const found = unwrap(await apiGet('/list', { per_page: 100 }, auth)).find((e) => Number(e.id) === id)
      name = String(found?.name ?? '')
    } catch { /* 取不到名字不影响主流程 */ }
    return { id, name, source: 'flag' }
  }
  const fromEnv = process.env.GITEE_ENT_ID ?? process.env.GITEE_CHAT_ENTERPRISE_ID
  if (fromEnv && Number(fromEnv) > 0) {
    return { id: Number(fromEnv), name: '', source: 'env' }
  }
  const fromFile = readConfig().enterpriseId
  if (Number(fromFile) > 0) {
    const id = Number(fromFile)
    let name = ''
    try {
      const found = unwrap(await apiGet('/list', { per_page: 100 }, auth)).find((e) => Number(e.id) === id)
      name = String(found?.name ?? '')
    } catch { /* 名字取不到不影响取数 */ }
    return { id, name, source: 'config-file' }
  }

  const raw = await apiGet('/list', { per_page: 100 }, auth)
  const list = unwrap(raw)
  if (list.length === 0) throw new Error('token 可用但未返回任何企业（/list 为空）')

  // 只有一个企业：自动使用，不打扰用户。
  if (list.length === 1) {
    return { id: Number(list[0].id), name: String(list[0].name ?? ''), source: 'auto', all: list }
  }

  // 多个企业：**必须显式指定**。
  // 静默取 list[0] 会拿错公司的数据（实测：本人 3 个企业，第一个是 0 工作项的个人企业，
  // 真实工作在另一个 68 工作项的企业里）。宁可报错，也不能给错数据。
  const options = list.map((e) => `  --enterprise ${e.id}   # ${e.name}`).join('\n')
  const error = new Error(
    `你属于 ${list.length} 个企业，必须显式指定要操作哪一个（未指定时不会自动挑选，避免拿错公司的数据）。\n`
    + `可选项：\n${options}\n`
    + '指定方式（任选其一）：\n'
    + '  1. 运行 `gq enterprises --use <id>` 写入本地配置（最简，无需重启）\n'
    + '  2. 环境变量 GITEE_ENT_ID=<id>\n'
    + '  3. 插件配置 enterpriseId: <id>\n'
    + '  4. 命令行 --enterprise <id>',
  )
  error.code = 'ambiguous-enterprise'
  error.enterprises = list.map((e) => ({ id: Number(e.id), name: String(e.name ?? ''), path: String(e.path ?? '') }))
  throw error
}

/** 列出当前 token 可见的全部企业（配置企业时用）。 */
export async function listEnterprises(auth) {
  const list = unwrap(await apiGet('/list', { per_page: 100 }, auth))
  return list.map((e) => ({ id: Number(e.id), name: String(e.name ?? ''), path: String(e.path ?? '') }))
}

// ── 数据抓取 ────────────────────────────────────────────────────────────────

/** 拉取项目（program）列表。 */
async function fetchPrograms(enterpriseId, auth) {
  const raw = await apiGet(`/${enterpriseId}/programs`, { per_page: 100 }, auth)
  return unwrap(raw).map((p) => ({
    id: Number(p.id),
    name: String(p.name ?? ''),
    ident: String(p.ident ?? ''),
    category: String(p.category ?? ''),
    status: Number(p.status ?? 0),
    assignee: p.assignee ? String(p.assignee.name ?? p.assignee.login ?? '') : '',
    issuesCount: Number(p.issues_count ?? 0),
    reposCount: Number(p.projects_count ?? 0),
    usersCount: Number(p.users_count ?? 0),
    // program 对象**没有 updated_at**（实测），用 created_at 代替
    createdAt: String(p.created_at ?? ''),
    updatedAt: String(p.created_at ?? ''),
  }))
}

/**
 * 拉取工作项。**一次企业级查询再本地分组**，避免按项目 N 次调用。
 *
 * 翻页：`per_page=100` 逐页取到不足一页为止，最多 `maxPages` 页。
 * 早先只取第一页，企业工作项超过 100 时看板会静默少算——这是正确性问题，
 * 不只是性能问题。超过上限时返回值里带 `truncated`，界面会明说。
 *
 * @param {number} enterpriseId
 * @param {object} filters
 * @param {{ token: string }} auth
 * @param {{ maxPages?: number }} [opts]
 */
async function fetchIssues(enterpriseId, filters, auth, opts = {}) {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES
  const perPage = 100
  const raw = []
  let page = 1
  for (; page <= maxPages; page++) {
    const res = await apiGet(`/${enterpriseId}/issues`, { per_page: perPage, page, ...filters }, auth)
    const batch = unwrap(res)
    raw.push(...batch)
    if (batch.length < perPage) break
  }
  const truncated = page > maxPages
  return { rows: raw.map(mapIssue), truncated }
}

/** 把 API 的 snake_case 工作项映射成本包内部字段。 */
function mapIssue(it) {
  return {
    id: Number(it.id),
    ident: String(it.ident ?? ''),
    title: String(it.title ?? ''),
    state: String(it.state ?? ''),
    priority: Number(it.priority ?? 0),
    priorityHuman: String(it.priority_human ?? ''),
    programId: it.program_id == null ? 0 : Number(it.program_id),
    assignee: it.assignee ? String(it.assignee.name ?? it.assignee.login ?? '') : '',
    assigneeId: it.assignee ? Number(it.assignee.id) : 0,
    deadline: String(it.deadline ?? ''),
    // 以下字段供「固定分析」用（时间线 / 工时 / 标签 / 父子 / 里程碑）
    planStartedAt: String(it.plan_started_at ?? ''),
    finishedAt: String(it.finished_at ?? ''),
    startedAt: String(it.started_at ?? ''),
    createdAt: String(it.created_at ?? ''),
    updatedAt: String(it.updated_at ?? ''),
    estimatedMinutes: Number(it.estimated_duration ?? 0),
    registeredMinutes: Number(it.registered_duration ?? 0),
    labels: Array.isArray(it.labels) ? it.labels.map((l) => String(l.name ?? '')) : [],
    typeTitle: it.issue_type ? String(it.issue_type.title ?? '') : '',
    typeId: it.issue_type ? Number(it.issue_type.id ?? 0) : 0,
    /** 里程碑对象原样保留（含 id/title/state/start_date/due_date），供 E-09 用。 */
    milestone: it.milestone ?? null,
    hasMilestone: it.milestone != null,
    parentId: Number(it.parent_id ?? 0),
    rootId: Number(it.root_id ?? 0),
    commentsCount: Number(it.comments_count ?? 0),
  }
}

/** 拉取当前用户。 */
async function fetchMe(auth) {
  const raw = await apiGet('/users', {}, auth)
  const me = Array.isArray(raw) ? raw[0] : raw
  if (!me) return null
  return {
    id: Number(me.id),
    name: String(me.name ?? ''),
    login: String(me.login ?? ''),
  }
}

// ── 汇总计算 ────────────────────────────────────────────────────────────────

/** 是否逾期。 */
function isOverdue(issue, now) {
  if (!issue.deadline) return false
  if (CLOSED_STATES.has(issue.state)) return false
  const t = Date.parse(issue.deadline)
  return Number.isFinite(t) && t < now
}

/** 逾期天数（正数=已逾期）。 */
function overdueDays(issue, now) {
  const t = Date.parse(issue.deadline)
  if (!Number.isFinite(t)) return 0
  return Math.round((now - t) / 86400000)
}

/**
 * 由原始数据算出 KPI / 风险 / 分布（纯函数，便于测试）。
 * @param {{ programs: any[], issues: any[], now?: number }} input
 */
export function computeBoard(input) {
  const now = input.now ?? Date.now()
  const issues = input.issues
  const programs = input.programs

  const byState = new Map()
  for (const it of issues) byState.set(it.state, (byState.get(it.state) ?? 0) + 1)

  const overdues = issues.filter((it) => isOverdue(it, now))
  const unassigned = issues.filter((it) => !it.assignee && !CLOSED_STATES.has(it.state))
  const urgentOpen = issues.filter(
    (it) => (it.priority >= 3 || it.priorityHuman === '高' || it.priorityHuman === '紧急')
      && !CLOSED_STATES.has(it.state),
  )

  // 每项目聚合
  const perProgram = new Map()
  for (const it of issues) {
    const key = it.programId
    const bucket = perProgram.get(key) ?? { total: 0, done: 0, overdue: 0, progressing: 0 }
    bucket.total++
    if (it.state === 'closed') bucket.done++
    if (it.state === 'progressing') bucket.progressing++
    if (isOverdue(it, now)) bucket.overdue++
    perProgram.set(key, bucket)
  }

  const programRows = programs.map((p) => {
    const b = perProgram.get(p.id) ?? { total: 0, done: 0, overdue: 0, progressing: 0 }
    return {
      ...p,
      total: b.total,
      done: b.done,
      overdue: b.overdue,
      progressing: b.progressing,
      progress: b.total === 0 ? 0 : Math.round((b.done / b.total) * 100),
    }
  })

  // 风险清单：先逾期，再紧急未完成，再无人认领
  const risks = [
    ...overdues.map((it) => ({
      kind: 'overdue',
      level: it.priority >= 3 ? 'high' : 'mid',
      ident: it.ident,
      title: it.title,
      owner: it.assignee,
      programId: it.programId,
      detail: `逾期 ${overdueDays(it, now)} 天 · 截止 ${it.deadline.slice(0, 10)}`,
    })),
    ...urgentOpen.filter((it) => !isOverdue(it, now)).map((it) => ({
      kind: 'urgent',
      level: 'mid',
      ident: it.ident,
      title: it.title,
      owner: it.assignee,
      programId: it.programId,
      detail: `${it.priorityHuman || '高'}优先级 · 未完成 · 截止 ${it.deadline ? it.deadline.slice(0, 10) : '未定'}`,
    })),
    ...unassigned.map((it) => ({
      kind: 'unassigned',
      level: 'low',
      ident: it.ident,
      title: it.title,
      owner: '',
      programId: it.programId,
      detail: '无负责人',
    })),
  ].slice(0, 40)

  return {
    kpi: {
      programs: programs.length,
      issues: issues.length,
      progressing: byState.get('progressing') ?? 0,
      done: byState.get('closed') ?? 0,
      overdue: overdues.length,
      unassigned: unassigned.length,
    },
    distribution: [...byState.entries()].map(([state, count]) => ({ state, count }))
      .sort((a, b) => b.count - a.count),
    programs: programRows,
    risks,
  }
}

// ── 固定分析（不需要 AI 参与的确定性计算）────────────────────────────────────
//
// 口径：**凡是能用规则算出来的，就不要让模型算。**
// 模型算同类结论会：慢、贵、每次不一样、还可能算错。这里全部是纯函数，
// 同一个输入永远得到同一个输出，且能在冒烟测试里断言。
//
// 需要判断力/跨领域推理的部分（WBS 合理性、风险根因、复盘）仍留给 AI ——
// 但要基于这里算出来的事实，而不是让它自己数数。

/** 停滞判定：未完成且多久没动（默认值，可被 GITEE_CHAT_STALL_DAYS 覆盖）。 */
const STALL_DAYS = THRESHOLD_DEFAULTS.stallDays
/** 负载过重阈值：未完成数与逾期数同时超过。 */
const OVERLOAD_OPEN = THRESHOLD_DEFAULTS.overloadOpen
const OVERLOAD_OVERDUE = THRESHOLD_DEFAULTS.overloadOverdue
/**
 * 规范要求的标签数（职能域 × 优先级 × 阶段）。
 *
 * ⚠️ 这是**特定团队的约定**，不是 Gitee 的规则。别的团队用 2 个或 4 个标签时，
 * 用 `GITEE_CHAT_REQUIRED_LABELS` 覆盖，或设为 0 关闭这项检查。
 */
const REQUIRED_LABELS = THRESHOLD_DEFAULTS.requiredLabels

/** 天数差（正数=已经过去）。 */
function daysSince(iso, now) {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.floor((now - t) / 86400000) : null
}

/** 健康度评分：由两个可解释的比率扣分，不做黑箱加权。 */
function healthScore({ openCount, overdueCount, unassignedCount, stalledCount }) {
  if (openCount === 0) return 100
  const overdueRate = overdueCount / openCount
  const unassignedRate = unassignedCount / openCount
  const stalledRate = stalledCount / openCount
  const score = 100 - (55 * overdueRate + 20 * unassignedRate + 25 * stalledRate)
  return Math.max(0, Math.round(score))
}

/** 分数 → 等级。 */
function healthLevel(score) {
  if (score >= 80) return 'good'
  if (score >= 60) return 'warn'
  return 'bad'
}

/**
 * 全部确定性分析。纯函数：给定同样的 programs/issues/now，输出永远一致。
 * @param {{ programs: any[], issues: any[], now?: number }} input
 */
export function computeAnalysis(input) {
  const now = input.now ?? Date.now()
  const issues = input.issues
  const programs = input.programs
  const programName = new Map(programs.map((p) => [p.id, p.name]))
  // 阈值：默认值具名在 analysis.mjs，部署可用环境变量覆盖，且随结果一起下发
  const th = input.thresholds ?? resolveThresholds()
  const STALL = th.stallDays
  const OVER_OPEN = th.overloadOpen
  const OVER_DUE = th.overloadOverdue
  const LABELS = th.requiredLabels

  const isOpen = (it) => !CLOSED_STATES.has(it.state)
  const overdueOf = (it) => isOpen(it) && it.deadline !== '' && Date.parse(it.deadline) < now
  const idleDaysOf = (it) => daysSince(it.updatedAt, now)
  const isStalled = (it) => isOpen(it) && it.state !== 'open' && (idleDaysOf(it) ?? 0) >= STALL

  const openIssues = issues.filter(isOpen)

  // ① 项目健康度
  const health = programs.map((p) => {
    const mine = issues.filter((it) => it.programId === p.id)
    const mineOpen = mine.filter(isOpen)
    const mineOverdue = mineOpen.filter(overdueOf)
    const mineUnassigned = mineOpen.filter((it) => !it.assignee)
    const mineStalled = mineOpen.filter(isStalled)
    const done = mine.filter((it) => it.state === 'closed').length
    const score = healthScore({
      openCount: mineOpen.length,
      overdueCount: mineOverdue.length,
      unassignedCount: mineUnassigned.length,
      stalledCount: mineStalled.length,
    })
    return {
      programId: p.id,
      name: p.name,
      score,
      level: healthLevel(score),
      total: mine.length,
      open: mineOpen.length,
      overdue: mineOverdue.length,
      unassigned: mineUnassigned.length,
      stalled: mineStalled.length,
      completionRate: mine.length === 0 ? 0 : Math.round((done / mine.length) * 100),
    }
  }).sort((a, b) => a.score - b.score)

  // ② 成员负载
  const byOwner = new Map()
  for (const it of openIssues) {
    const key = it.assignee || '(未指派)'
    const b = byOwner.get(key) ?? { name: key, open: 0, progressing: 0, overdue: 0, highPriority: 0 }
    b.open++
    if (it.state === 'progressing') b.progressing++
    if (overdueOf(it)) b.overdue++
    if (it.priority >= 3) b.highPriority++
    byOwner.set(key, b)
  }
  const workload = [...byOwner.values()]
    .map((b) => ({
      ...b,
      level: b.overdue >= OVER_DUE && b.open >= OVER_OPEN
        ? 'overloaded'
        : b.overdue >= OVER_DUE ? 'at-risk' : 'ok',
    }))
    .sort((a, b) => b.overdue - a.overdue || b.open - a.open)

  // ③ 延期清单（按逾期天数倒序）
  const slips = openIssues
    .filter(overdueOf)
    .map((it) => ({
      ident: it.ident,
      title: it.title,
      owner: it.assignee,
      programId: it.programId,
      programName: programName.get(it.programId) ?? '',
      overdueDays: Math.round((now - Date.parse(it.deadline)) / 86400000),
      priorityHuman: it.priorityHuman,
    }))
    .sort((a, b) => b.overdueDays - a.overdueDays)

  // ④ 停滞任务（进行中但很久没动）
  const stalled = openIssues
    .filter(isStalled)
    .map((it) => ({
      ident: it.ident,
      title: it.title,
      owner: it.assignee,
      programId: it.programId,
      programName: programName.get(it.programId) ?? '',
      idleDays: idleDaysOf(it) ?? 0,
      state: it.state,
    }))
    .sort((a, b) => b.idleDays - a.idleDays)

  // ⑤ 规范体检（纯规则：负责人 / 截止 / 计划时间 / 标签数量）
  const compliance = openIssues.map((it) => {
    const problems = []
    if (!it.assignee) problems.push('无负责人')
    if (it.deadline === '') problems.push('无截止日期')
    if (it.planStartedAt === '') problems.push('无计划开始时间')
    // LABELS = 0 表示该企业不采用「固定标签数」约定 —— 关掉这项检查
    if (LABELS > 0) {
      if (it.labels.length === 0) problems.push('无标签')
      else if (it.labels.length !== LABELS) problems.push(`标签数 ${it.labels.length}≠${LABELS}`)
    }
    if (it.typeTitle === '') problems.push('无工作项类型')
    return {
      ident: it.ident,
      title: it.title,
      owner: it.assignee,
      programId: it.programId,
      programName: programName.get(it.programId) ?? '',
      problems,
    }
  }).filter((row) => row.problems.length > 0)

  return {
    thresholds: th,
    health,
    workload,
    slips,
    stalled: stalled.slice(0, 30),
    compliance: compliance.slice(0, 40),
    totals: {
      open: openIssues.length,
      overdue: slips.length,
      unassigned: openIssues.filter((it) => !it.assignee).length,
      stalled: stalled.length,
      nonCompliant: compliance.length,
      overloadedOwners: workload.filter((w) => w.level === 'overloaded').length,
    },
  }
}

/** 生成给模型看的紧凑 Markdown 摘要（这是唯一进入上下文的取数结果）。 */
export function renderSummary(payload) {
  const { kpi, programs, risks } = payload
  const L = []
  L.push(`## Gitee 看板 · ${payload.enterprise.name || `企业 ${payload.enterprise.id}`} · ${payload.scope}`)
  L.push(`> 数据源 ${payload.source === 'fixture' ? '**样例数据**' : '实时拉取'} · ${payload.generatedAt}`)
  L.push('')
  L.push(`工作项 ${kpi.issues}（进行中 ${kpi.progressing} / 已完成 ${kpi.done}）｜ 逾期 **${kpi.overdue}** ｜ 无人认领 ${kpi.unassigned} ｜ 项目 ${kpi.programs}`)
  L.push('')
  if (programs.length > 0) {
    L.push('| 项目 | 类型 | 负责人 | 进度 | 逾期 |')
    L.push('|---|---|---|---|---|')
    for (const p of programs.slice(0, 12)) {
      const bar = p.total === 0 ? '—' : `${'▓'.repeat(Math.round(p.progress / 10))}${'░'.repeat(10 - Math.round(p.progress / 10))} ${p.progress}%`
      L.push(`| ${p.name} | ${p.category || '—'} | ${p.assignee || '—'} | ${bar} | ${p.overdue > 0 ? `⚠️${p.overdue}` : '0'} |`)
    }
    L.push('')
  }
  // 固定分析：这些结论由脚本算出，模型只需解读、不必自己统计
  const an = payload.analysis
  if (an) {
    const levelDot = { good: '🟢', warn: '🟡', bad: '🔴' }
    const t = an.totals
    L.push('### 📐 固定分析（脚本计算，无需 AI 统计）')
    L.push(`健康度 ${an.health.filter((x) => x.level === 'bad').length} 🔴 / ${an.health.filter((x) => x.level === 'warn').length} 🟡 / ${an.health.filter((x) => x.level === 'good').length} 🟢`
      + ` ｜ 未完成 ${t.open} ｜ 逾期 ${t.overdue} ｜ 停滞>${an.thresholds.stallDays}天 ${t.stalled}`
      + ` ｜ 无人认领 ${t.unassigned} ｜ 规范不合规 ${t.nonCompliant} ｜ 过载人员 ${t.overloadedOwners}`)
    const worst = an.health.filter((x) => x.level !== 'good').slice(0, 4)
    for (const x of worst) {
      L.push(`- ${levelDot[x.level]} ${x.name} 健康度 ${x.score}（未完成 ${x.open} / 逾期 ${x.overdue} / 无人认领 ${x.unassigned} / 停滞 ${x.stalled}）`)
    }
    if (an.slips.length > 0) {
      L.push(`- 最长逾期：${an.slips.slice(0, 3).map((x) => `${x.ident} ${x.overdueDays}天`).join('、')}`)
    }
    if (an.workload.filter((w) => w.level !== 'ok').length > 0) {
      const hot = an.workload.filter((w) => w.level !== 'ok').slice(0, 3)
      L.push(`- 负载告警：${hot.map((w) => `${w.name}(未完成${w.open}/逾期${w.overdue})`).join('、')}`)
    }
    if (t.nonCompliant > 0) {
      L.push(`- 规范体检：${t.nonCompliant} 项不合规（缺负责人/截止/计划时间/类型${an.thresholds.requiredLabels > 0 ? ` 或 标签数≠${an.thresholds.requiredLabels}` : ''}）`)
    }
    // 第二批固定分析（E-07 ~ E-10）：同样是脚本结论，模型只管解读
    const pr = an.progress
    if (pr) {
      L.push(`- 进度偏差：按期开工率 ${pr.totals.onTimeStartRate === null ? '无样本' : `${pr.totals.onTimeStartRate}%`}`
        + ` ｜ 平均开工偏差 ${pr.totals.avgStartDelay === null ? '—' : `${pr.totals.avgStartDelay} 天`}`
        + ` ｜ 已完成项平均交付偏差 ${pr.totals.avgFinishDelay === null ? '—' : `${pr.totals.avgFinishDelay} 天`}`
        + ` ｜ 未完成且无截止 ${pr.totals.openWithoutPlan} 项`)
    }
    const ms = an.milestones
    if (ms && ms.totals.count > 0) {
      L.push(`- 里程碑：${ms.totals.count} 个 ｜ 达成 ${ms.totals.achieved} ｜ 逾期未达 ${ms.totals.missed} 🔴 ｜ 有风险 ${ms.totals.atRisk} 🟡`
        + `（覆盖 ${ms.totals.coveredIssues}/${ms.totals.totalIssues} 个工作项）`)
      for (const m of ms.rows.filter((x) => x.verdict === 'missed' || x.verdict === 'at-risk').slice(0, 3)) {
        L.push(`  - ${m.verdict === 'missed' ? '🔴 已逾期' : '🟡 有风险'} ${m.title}（${m.programName} ${m.dueDate}，未完成 ${m.open}/${m.total}）`)
      }
    }
    const cp = an.capacity
    if (cp) {
      L.push(`- 迭代容量（按截止周，每周容量 ${cp.weeklyCapacity} 项）：未来 ${cp.totals.weeksAhead} 周已排 ${cp.totals.plannedAhead} 项`
        + `（周均 ${cp.totals.avgPerWeekAhead}）｜ 超载周 ${cp.totals.overloadedWeeks}`
        + ` ｜ 逾期积压 ${cp.totals.carryOver} 项 ｜ 无截止 ${cp.noDeadline} 项`)
      if (!cp.hoursTracked) L.push('  - ⚠️ 工时口径不可用：本企业工作项未登记预估工时，容量只能按项数衡量')
    }
    const dl = an.delivery
    if (dl) {
      L.push(`- 交付趋势（近 ${dl.weeks} 周）：新增 ${dl.totals.created} ｜ 完成 ${dl.totals.finished} ｜ 净增 ${dl.totals.net >= 0 ? '+' : ''}${dl.totals.net}`
        + ` ｜ 周均完成 ${dl.totals.avgFinishedPerWeek}`
        + `${dl.totals.velocityTrend === null ? '' : ` ｜ 后段较前段 ${dl.totals.velocityTrend >= 0 ? '+' : ''}${dl.totals.velocityTrend}%`}`)
    }
    L.push('')
  }

  if (risks.length > 0) {
    L.push(`### ⚠️ 风险 ${risks.length} 项（前 8）`)
    for (const r of risks.slice(0, 8)) {
      L.push(`- \`${r.ident}\` ${r.title} · ${r.owner || '未指派'} · ${r.detail}`)
    }
    L.push('')
  }
  L.push('> 看板卡片已在会话中渲染（完整数据不进模型上下文）。')
  return L.join('\n')
}

// ── 人格推导（本包的核心规则）────────────────────────────────────────────────
//
// 人格**不是让人选的**，而是从 MCP 那边能拿到的身份关系推出来的：
//   1. 当前 token 是谁（get_user_info）
//   2. 他在企业里是什么角色（members 的 enterprise_role.ident）
//   3. 哪些项目的负责人是他（programs[].assignee.id === me.id）
//   4. 哪些工作项的负责人是他（issues[].assignee.id === me.id）
//
// 规则（按需求方口径）：
//   - 企业级管理角色（拥有者/超管/管理员）        → enterprise-admin 企业管理者
//   - 是企业里某个项目的负责人（== 当前 token）   → program-owner   项目执行（负责人视角）
//   - 没有项目负责人身份，但有工作项负责人身份    → workitem-executor 工作项执行
//   - 两者都没有                                  → observer        观察者（只读）
//
// 注意：这里推的是**基础人格**（由 token 决定，进程级）。某个具体项目里
// 「我是负责人还是执行者」是**会话级**的，取决于当前聚焦的项目。

/** 企业级管理角色 → 管理者人格。 */
const ADMIN_ROLES = new Set(['enterprise_owner', 'super_admin', 'admin'])

/** 角色中文名（缺失时回落 ident 原文）。 */
const ROLE_LABELS = {
  enterprise_owner: '企业拥有者',
  super_admin: '超级管理员',
  admin: '管理员',
  member: '普通成员',
  outsourced_member: '外包成员',
  human_resources: 'HR管理员',
  viewer: '观察者',
}

// ── 能力矩阵：本文件的唯一真源 ───────────────────────────────────────────────
//
// 三个能力档，对应「2 个人格」：
//   管理者        manager
//   项目执行      executor ─┬─ 负责人档 project（开启项目管理与分析）
//                          └─ 执行档   exec   （只有执行功能）
//
// 每一档声明：能做什么、不能做什么、能做哪些分析、以及**对应哪些 MCP 工具**。
// 文档、注入上下文、工具集门禁全部从这张表派生，因此三者不会漂移。
//
// 说明：MCP 工具集用于 `mcp-gitee-ent --enabled-toolsets`，
// 让「不可以做」变成**根本调不到**，而不只是提示词里写着。

/** 全档只读的公共工具（任何人格都能查）。 */
const READ_COMMON = [
  'list_enterprises', 'get_user_info', 'list_programs',
  // 文档读取：任何能进项目的成员都该能看文档
  'list_doc_nodes', 'list_program_doc_nodes',
  // **附件内容读取**（本 fork 独有，v0.2.1-dsh.3 加入）。
  //
  // 为什么必须有它：`list_doc_nodes` 只给文件名，正文/二进制取不回来 ——
  // 实测（2026-09-15）本企业知识库全是 `DocDirectory` + `AttachFile`，
  // 没有 WikiInfo 文档，所以下面那一族 `*_enterprise_document*` 全返回 0，
  // 真正的项目资料只能靠这个工具读。
  //
  // 归**读取档**：它只写**本地磁盘**（下载到 output_directory），不改 Gitee 上
  // 任何东西 —— 与 `download_enterprise_document` 同一口径，因此不归 allowWrites 管；
  // 真正限制它的是 MCP 那侧的目录沙箱（workspace / GITEE_ENT_MCP_ALLOWED_FILE_ROOTS）。
  'download_attach_file',
  // 企业知识库「文档正文」那一半（上游 v0.2.0 引入，本 fork 已并入）：
  // 平铺列举/搜索、列页面、读页面正文与历史版本。
  // `download_enterprise_document` 也放读取档：它把文档**导出到本地磁盘**，不改
  // Gitee 上的任何东西（export 端点），所以不归 allowWrites 管；真正限制它的是
  // MCP 那侧的 GITEE_ENT_MCP_ALLOWED_FILE_ROOTS 沙箱。
  'list_enterprise_documents',
  'list_enterprise_document_pages',
  'get_enterprise_document_page',
  'download_enterprise_document',
  'list_enterprise_issues', 'get_enterprise_issue_detail', 'list_enterprise_issue_comments',
  'list_issue_types', 'list_issue_type_states', 'list_enterprise_labels',
  'list_enterprise_repositories', 'get_enterprise_repo_tree',
  'get_enterprise_repository_file_content', 'list_enterprise_repo_releases',
  'list_enterprise_pulls', 'get_enterprise_pull_detail', 'get_enterprise_pull_diff',
  'list_enterprise_pull_comments',
]

/** 执行档就能用的写工具（围绕本人工作项）。 */
const WRITE_EXEC = [
  'create_enterprise_issue', 'update_enterprise_issue', 'comment_enterprise_issue',
  'create_enterprise_repo_pull', 'comment_enterprise_pull', 'update_enterprise_pull',
  // 文档写入：在「他能获取到的写入目录」内建/改文档不受限（需求方口径）
  'create_doc_node', 'attach_doc_file',
  // 改页面正文（带 expected_version 乐观锁，版本变了服务端会拒绝）与批量导入
  'update_enterprise_document_page', 'upload_enterprise_document_files',
]

/** 负责人档追加的写工具（本项目范围内）。 */
const WRITE_PROJECT = ['create_scrum_sprint', 'create_wiki', 'move_doc_node']

/** 管理者档追加的写工具（企业级 / 不可逆动作）。 */
const WRITE_MANAGER = [
  'create_program', 'create_enterprise_repository', 'merge_enterprise_pull', 'create_enterprise_repo_release',
  // 文档的权限与删除属企业级动作
  'set_doc_node_auth', 'recycle_doc_node', 'delete_doc_node',
]

/**
 * 每档的**写**工具子集。
 *
 * 用途只有一个：`allowWrites: false`（只读部署）时，门禁要把这些**硬拦**。
 * `allowWrites` 早先只管界面上的写按钮与 `/write` 路由，管不到 MCP —— 而
 * preset 的 `--enabled-toolsets` 是静态的、不随部署变。所以只读部署下 AI 仍能
 * 通过 MCP 建工作项、改状态。这条把「只读」这个承诺补成真的。
 *
 * 只列**会改 Gitee 上东西**的工具。`download_enterprise_document` 不在此列：
 * 它导出到本地磁盘，不改 Gitee。
 */
const WRITES_EXEC = [...WRITE_EXEC]
const WRITES_PROJECT = [...WRITE_EXEC, ...WRITE_PROJECT]
const WRITES_MANAGER = [...WRITE_EXEC, ...WRITE_PROJECT, ...WRITE_MANAGER]

/** 负责人档与管理者档才需要的读（成员/团队/迭代/版本）。 */
const READ_SCOPED = ['list_enterprise_members', 'list_enterprise_groups', 'list_scrum_sprints', 'list_scrum_versions']

/** 三档能力矩阵。 */
export const TIERS = {
  manager: {
    persona: 'manager',
    label: '管理者',
    who: '企业拥有者 / 超管 / 管理员',
    scope: '企业级：跨项目组合视角',
    management: true,
    can: [
      '跨项目组合视图：全部项目的健康度、进度、逾期、风险一览',
      '跨项目分析：资源负载、风险汇总、里程碑偏差、交付趋势',
      '建项目（Program）与建仓库（Repository）',
      '建/配工作项：建工作项、指定负责人与协作者、配标签、挂迭代',
      '推进**任意**项目的任意工作项状态',
      'PR 评审与**合并**、建 Release',
      '企业成员、团队、角色与权限查看',
      '企业知识库的完整管理：知识库节点树的权限设置、回收与删除',
      '周报/月报汇总（跨项目）',
    ],
    cannot: [
      '不可转让企业所有权、不可解散企业（Gitee 侧限制）',
      '不可删除任何实体（MCP 无删除能力，只能到 Web UI 操作）',
    ],
    analyses: ['组合健康度', '资源负载', '风险汇总', '里程碑偏差', '交付趋势', 'WBS 合理性审核'],
    tools: [...READ_COMMON, ...READ_SCOPED, ...WRITE_EXEC, ...WRITE_PROJECT, ...WRITE_MANAGER],
    /** 本档的写工具（只读部署时门禁按它硬拦）。 */
    writes: WRITES_MANAGER,
  },
  project: {
    persona: 'executor',
    label: '项目执行 · 负责人档',
    who: '你在某项目里是负责人（programs[].assignee == 当前 token 用户）',
    scope: '项目级：你负责的那些项目，开项目管理与分析',
    management: true,
    can: [
      '本项目全景：本项目工作项列表、责任人、进度、逾期、阻塞',
      '本项目分析：进度偏差、风险清单、成员负载、迭代容量',
      '在**本项目内**建工作项与子任务，指派负责人与协作者（平台允许所有成员创建）',
      '推进**本项目内任意**工作项状态（含改派给本项目成员）',
      '维护迭代（建 Scrum 迭代 —— 需项目管理员/拥有者权限，❓待实测负责人身份是否满足）、查看版本里程碑',
      '写评论、做评审、提交 PR',
      '管理本项目知识库：建节点与 Wiki、移动文档、上传附件、按项目浏览知识库',
      '本项目周报',
    ],
    cannot: [
      '【平台限制】不得建项目 / 建仓库（需管理员级别）',
      '【平台限制】不得合并 PR（需仓库管理员/被授权者，除非企业角色本身是管理角色）',
      '【插件策略】不得跨项目批量改动他项目的实体（平台允许单点改，插件策略上不主动做）',
    ],
    analyses: ['项目进度偏差', '项目风险清单', '成员负载', '迭代容量', '逾期与阻塞'],
    tools: [...READ_COMMON, ...READ_SCOPED, ...WRITE_EXEC, ...WRITE_PROJECT],
    /** 本档的写工具（只读部署时门禁按它硬拦）。 */
    writes: WRITES_PROJECT,
  },
  exec: {
    persona: 'executor',
    label: '项目执行 · 执行档',
    who: '你不是任何项目的负责人',
    scope: '工作项级：围绕本人相关的工作项工作',
    management: false,
    can: [
      '查看本人相关的工作项（含前置条件、验收标准、产出物要求）',
      '推进工作项状态（本人的；以及经用户明确要求时，项目内他人的）',
      '**建立工作项与子任务，并指派负责人与协作者**（平台允许所有成员创建）',
      '写评论：日报、阻塞上报、评审意见、交接说明',
      '登记产出物（链接、分支、文档）',
      '知识库文档：查看/搜索企业文档、读页面正文与历史版本，在自己可写的目录里改页面、导入文件、导出到本地',
      '查看所属项目与仓库信息、提交并查看 PR',
      '完成后通知：在评论里 @ 项目负责人',
    ],
    cannot: [
      '【平台限制】不能建项目、不能建仓库（需管理员级别）',
      '【平台限制】不能建 Scrum 迭代（需项目管理员/拥有者）',
      '【平台限制】不能合并 PR、不能建 Release（需仓库管理员/被授权者）',
      '【平台限制】数据范围受限：普通成员只能读到自己已加入的项目',
      '【插件策略】不开启项目管理与分析功能：不主动做项目全景、成员负载与风险分析',
      '【插件策略】不主动批量改动他人工作项（平台允许，需用户明确要求才做）',
    ],
    analyses: ['仅本人任务视角：我的待办、我的逾期、我的产出'],
    tools: [...READ_COMMON, ...WRITE_EXEC],
    /** 本档的写工具（只读部署时门禁按它硬拦）。 */
    writes: WRITES_EXEC,
  },
}

/** 档 → 人格（人格只有 2 个：管理者 / 项目执行）。 */
export function personaOf(tier) {
  return TIERS[tier]?.persona ?? 'executor'
}

/**
 * 由身份关系推导能力档（**纯函数**，便于单测覆盖全部分支）。
 * @param {{ enterpriseRole?: string, ownedPrograms?: any[], ownedIssueCount?: number }} input
 * @returns {'manager'|'project'|'exec'}
 */
export function deriveTier(input) {
  if (ADMIN_ROLES.has(input.enterpriseRole ?? '')) return 'manager'
  if ((input.ownedPrograms ?? []).length > 0) return 'project'
  return 'exec'
}

/** 兼容旧名。 */
export const derivePersona = deriveTier

/** 组装注入用的人格上下文文本（紧凑，供 systemPrompt.context 同步取用）。 */
export function renderPersonaContext(role) {
  const tier = TIERS[role.tier] ?? TIERS.exec
  const lines = []
  lines.push(`<gitee-role persona="${role.persona}" tier="${role.tier}" label="${tier.label}" resolved-at="${role.generatedAt}">`)
  lines.push(`  <me id="${role.me?.id ?? 0}" name="${role.me?.name ?? ''}" login="${role.me?.login ?? ''}"/>`)
  lines.push(`  <enterprise-role ident="${role.enterpriseRole ?? 'unknown'}" label="${ROLE_LABELS[role.enterpriseRole] ?? role.enterpriseRole ?? '未知'}"/>`)
  // 这个布尔就是那个「开关」：true=开启项目管理与分析功能。
  lines.push(`  <project-management enabled="${tier.management ? 'true' : 'false'}"/>`)
  if (role.managedPrograms.length > 0) {
    lines.push(`  <programs-managed count="${role.managedPrograms.length}">`)
    for (const p of role.managedPrograms.slice(0, 10)) {
      lines.push(`    <program id="${p.id}" name="${p.name}"/>`)
    }
    lines.push('  </programs-managed>')
  } else {
    lines.push('  <programs-managed count="0"/>')
  }
  lines.push(`  <workitems-owned count="${role.ownedIssueCount}"/>`)
  // 逐项目开合规则：这是行为规则，必须让模型看到——开合是按项目判的，不是一个全局开关。
  lines.push('  <rule>项目管理与分析只对 &lt;programs-managed&gt; 里列出的项目开启；聚焦到其他项目时按执行档处理（不开启项目管理与分析），只做该项目的执行工作。</rule>')
  lines.push(`  <scope>${tier.scope}</scope>`)
  lines.push('  <can>')
  for (const item of tier.can) lines.push(`    <item>${item}</item>`)
  lines.push('  </can>')
  lines.push('  <cannot>')
  for (const item of tier.cannot) lines.push(`    <item>${item}</item>`)
  lines.push('  </cannot>')
  // 分析功能也必须进上下文：人格一确认，这一类加工就随之开/关。
  lines.push('  <analyses enabled="' + (tier.management ? 'true' : 'false') + '">')
  for (const item of tier.analyses) lines.push(`    <item>${item}</item>`)
  lines.push('  </analyses>')
  // 界面事实：会话里有整屏标签页，数据和图表在那儿，不必让模型复述数字
  lines.push('  <ui>')
  lines.push('    <tab name="Gitee 项目">与 对话/轨迹/上下文 并列的第 4 个标签页，自带取数与刷新，不消耗模型上下文。</tab>')
  lines.push('    <panel name="项目">企业 KPI、项目列表、工作项表；点任一行看详情（描述 / 前置依赖 / 评论讨论），并可直接改状态、改派、发评论。</panel>')
  lines.push('    <panel name="固定分析">项目健康度、成员负载、延期清单、停滞、规范体检、进度偏差、交付容量、里程碑达成、交付趋势 —— 全部由脚本计算。</panel>')
  lines.push('    <panel name="仓库">按项目（或"企业内部开源"）列仓库；选中一个仓库就看它的 **WIKI**（Gitee 的 WIKI 是仓库的子功能）。文件点开由右侧栏预览。</panel>')
  lines.push('    <panel name="知识库">知识库节点树（文件夹 + 上传的附件），支持查看正文。带缓存徽标：已缓存 / 远端已更新 —— 点开命中缓存就不重新下载。</panel>')
  lines.push('    <rule>用户问「项目情况 / 哪些逾期 / 健康度 / 里程碑」时：先用 gitee_board 触发取数并给出摘要，然后让用户看标签页拿完整数据；不要试图把明细念出来。</rule>')
  lines.push('  </ui>')
  // 知识库文件类工具的**目录作用域规则**必须进上下文。
  //
  // 为什么：上传/导出打的是 MCP 进程所在机器的本地路径，而"当前会话的工作区在哪"
  // 只有调用方知道。所以目录作用域由**每次调用传的 workspace 参数**决定 ——
  // 模型不知道这条，就会把文件路径丢过去然后被拒（或者更糟：落到进程 cwd 上）。
  lines.push('  <doc-files>')
  lines.push('    <rule>知识库的「导入本地文件」与「导出到本地」两个工具，必须带上 workspace 参数 —— 传**当前会话工作区的绝对路径**（不确定就先 `pwd` 确认）。不传的话目录作用域会落在 MCP 进程的工作目录上，通常不是你想要的。</rule>')
  lines.push('    <rule>可访问范围就是该工作区；工作区之外的路径一律被拒，别试图绕过。若组织另行配置了服务器侧的上限，workspace 只会更严、不会更宽。</rule>')
  lines.push('    <rule>「把 AI 生成的内容挂上去」用 attach_doc_file（内容以 base64 传，进程不碰文件系统）；「把本地整理好的资料批量导入」才用 import 工具（读本地路径，1–20 个文件、单个 ≤6 MiB）。</rule>')
  lines.push('    <rule>读附件内容用 download_attach_file 时**两个参数都要给**：workspace（上限）与 output_directory（落到哪）。'
    + '⚠️ output_directory **必须已经存在** —— MCP 侧对它做 EvalSymlinks + Stat，目录不存在会直接报 param_error，'
    + '报错信息长这样：`cannot resolve "…": lstat …: no such file or directory`。所以先建目录再调它。</rule>')
  lines.push('  </doc-files>')
  // 知识库文档的**读取与回写准则**。
  //
  // 🔴 这块曾经**整段指向一条本企业恒为 0 的路**：
  //   主规则写的是 `list_enterprise_document_pages`（页级 version 那套 WikiInfo 形态），
  //   而实测本企业一篇 WikiInfo 都没有 —— 真实资料是 `doc_nodes` 的
  //   「文件夹 + 上传附件」。于是 AI 被指引着走空路，还不会报错，
  //   只会回答"这家企业没有文档"。这跟 UI 那次的"绑错数据源"是同一类错误，
  //   只是发生在 AI 平面上。
  //
  // 现在的结构：**主路径 = 节点树 + 附件**，**仓库 WIKI 单列**（它不是 MCP 取的），
  // WikiInfo 那套降级到一个条件块里（只有该企业真有这种文档时才适用）。
  lines.push('  <docs>')
  lines.push('    <layout>Gitee 企业里的「文档」有**三种不同形态**，别混：'
    + '（a）**知识库节点树** —— `doc_nodes` 的 `DocDirectory`（文件夹）+ `AttachFile`（上传的 .md/.docx/.pdf/.png…），'
    + '挂企业级或某个项目下，**这是本企业实际在用的形态**；'
    + '（b）**仓库 WIKI** —— 每个仓库自己的 git WIKI（`{path}.wiki.git`，一堆 .md），**不是 MCP 工具取的**；'
    + '（c）**WikiInfo 在线文档** —— `doc_nodes` 里 `file_type=WikiInfo` 的那种，有"页"、有页级 version、可协作编辑。'
    + '（c）在有些企业一篇都没有，**先探测再假设**。</layout>')
  lines.push('    <rule>读知识库（主路径）：先用 list_program_doc_nodes 拿到**项目知识库的根节点**，'
    + '再 list_doc_nodes(parent_id, program_id) **逐层**展开 —— 一次只列一层，不要试图全量遍历。'
    + '企业级公共知识库用 list_doc_nodes(parent_id=0) 不带 program_id。</rule>')
  lines.push('    <rule>节点里只有**文件名**。要读**内容**必须用 download_attach_file(file_id, output_directory, workspace) —— '
    + '⚠️ 这是本 fork 独有的工具；`attach_file.download_url` 指向 Web 域、要会话 Cookie，用 token 打是 401，**不要照它取**。</rule>')
  lines.push('    <rule>建/挂文档：建文件夹或节点用 create_doc_node；把内容挂上去用 attach_doc_file（base64，进程不碰文件系统）；'
    + '移动用 move_doc_node；权限用 set_doc_node_auth；删除是不可逆的（recycle_doc_node / delete_doc_node），**动手前先向用户确认**。</rule>')
  lines.push('    <rule>读**仓库 WIKI**：先 list_enterprise_repositories 看该仓库的 `wiki_enabled_with_content` —— '
    + 'false 就是没有 WIKI，别去试。要读正文就 `git clone https://gitee.com/{path_with_namespace}.wiki.git`。'
    + '⚠️ 必须用 `path_with_namespace`，**不能用 `name`**：两者经常不同（name=demo-docs 而 path=docs），用错就是 404。</rule>')
  lines.push('    <rule>插件的「Gitee 项目」标签页里有「仓库」与「知识库」两个分段，已经能浏览仓库列表、仓库 WIKI、知识库节点树与附件正文。'
    + '用户问"有哪些文档 / 看下 XX 仓库的 WIKI"时，先告诉他去标签页看，**不要用工具把清单念一遍**。</rule>')
  lines.push('    <wikiinfo>上面（c）那种形态**仅当该企业确实有**才用：先 list_enterprise_documents，返回 0 就跳过整段。'
    + '有的话：list_enterprise_document_pages 一次带回全部页的 version，与本地清单比对，只 get 变化的那一页；'
    + '写页面必须先 get 拿当前 version，update 时带 expected_version 与 commit_message，content 是**整页替换**；'
    + '版本不符服务端会拒 —— **重新读再改，绝不绕过乐观锁**；两边都改过就是冲突，**不自动合并**，把两个版本摆出来交人决策。'
    + '注意：关键词搜索（search 参数）与 program_id **互斥**，也就是**不能按项目过滤**（搜索恒为企业级）；'
    + '整篇导出（download_enterprise_document）**不返回版本号**，markdown/html 产出的是 ZIP，可当离线归档但**不能当版本基线**。</wikiinfo>')
  lines.push('    <limit>本插件在本地维护一份**按需缓存**（`$DSH_HOME/gitee/docs`，按 `pj-&lt;programId&gt;/` 与 `_common/` 分目录）。'
    + '它是「读过才在」的缓存 + 工作副本，**不是镜像** —— 不见得有你没读过的那篇。'
    + '附件的缓存状态（已缓存 / 远端已更新）以标签页显示的为准，**不要自己推断**。</limit>')
  lines.push('  </docs>')
  lines.push('</gitee-role>')
  return lines.join('\n')
}

/** 人格的 Markdown 摘要（给模型和用户看的版本）。 */
export function renderRoleSummary(role) {
  const tier = TIERS[role.tier] ?? TIERS.exec
  const L = []
  L.push(`## 当前身份与人格 · ${tier.label}`)
  L.push('')
  L.push(`- 我是：${role.me?.name || '(未知)'}${role.me?.login ? `（${role.me.login}）` : ''}`)
  L.push(`- 企业角色：${ROLE_LABELS[role.enterpriseRole] ?? role.enterpriseRole ?? '未知'}`)
  L.push(`- 人格：**${role.persona === 'manager' ? '管理者' : '项目执行'}**${role.persona === 'executor' ? `（${tier.label.split(' · ')[1] ?? ''}）` : ''}`)
  L.push(`- 项目管理与分析功能：${tier.management ? '**已开启**' : '未开启（仅执行）'}`)
  L.push(`- 我以负责人身份管理的项目：${role.managedPrograms.length === 0 ? '无' : role.managedPrograms.map((p) => `${p.name}(${p.id})`).join('、')}`)
  L.push(`- 我名下的工作项：${role.ownedIssueCount} 个`)
  L.push('')
  L.push(`**判定依据**：${role.reason}`)
  L.push('')
  L.push(`### 我可以做（${tier.can.length} 项）`)
  for (const item of tier.can) L.push(`- ${item}`)
  L.push('')
  L.push(`### 我不可以做（${tier.cannot.length} 项）`)
  for (const item of tier.cannot) L.push(`- ${item}`)
  L.push('')
  L.push(`### 可用的分析（${tier.analyses.length} 项）`)
  L.push(tier.analyses.join('、'))
  return L.join('\n')
}

/** 打印三档能力矩阵对照表（用于评审「人格到底有哪些功能」）。 */
export function renderMatrix() {
  const L = []
  L.push('# Gitee 人格能力矩阵')
  L.push('')
  L.push('2 个人格：**管理者** / **项目执行**；项目执行内部按「是否项目负责人」开合项目管理与分析功能。')
  L.push('')
  L.push('| | 管理者 | 项目执行 · 负责人档 | 项目执行 · 执行档 |')
  L.push('|---|---|---|---|')
  const row = (label, fn) => L.push(`| **${label}** | ${fn(TIERS.manager)} | ${fn(TIERS.project)} | ${fn(TIERS.exec)} |`)
  row('谁', (t) => t.who)
  row('视角', (t) => t.scope)
  row('项目管理与分析', (t) => (t.management ? '✅ 开' : '❌ 关'))
  row('可用 MCP 工具数', (t) => String(t.tools.length))
  L.push('')
  const maxCan = Math.max(...Object.values(TIERS).map((t) => t.can.length))
  L.push('## 可以做什么')
  L.push('')
  L.push('| 能力 | 管理者 | 负责人档 | 执行档 |')
  L.push('|---|---|---|---|')
  for (let i = 0; i < maxCan; i++) {
    const cells = ['manager', 'project', 'exec'].map((k) => TIERS[k].can[i] ?? '')
    L.push(`| ${i + 1} | ${cells[0]} | ${cells[1]} | ${cells[2]} |`)
  }
  L.push('')
  L.push('## 分析功能')
  L.push('')
  for (const key of ['manager', 'project', 'exec']) {
    L.push(`- **${TIERS[key].label}**：${TIERS[key].analyses.join('、')}`)
  }
  L.push('')
  L.push('## 不可以做什么')
  L.push('')
  for (const key of ['manager', 'project', 'exec']) {
    L.push(`**${TIERS[key].label}**`)
    for (const item of TIERS[key].cannot) L.push(`- ${item}`)
    L.push('')
  }
  L.push('## MCP 工具集（可直接给 --enabled-toolsets）')
  L.push('')
  for (const key of ['manager', 'project', 'exec']) {
    L.push(`**${TIERS[key].label}**（${TIERS[key].tools.length}）`)
    L.push('```')
    L.push(TIERS[key].tools.join(','))
    L.push('```')
    L.push('')
  }
  return L.join('\n')
}

/**
 * 解析当前 token 的身份关系并推导能力档。
 * @param {number} enterpriseId
 * @param {{ token: string }} auth
 * @param {'auto'|'manager'|'project'|'exec'} mode - 人工强制（默认 auto 推导）
 */
export async function resolveRole(enterpriseId, auth, mode = 'auto', focusProgramId = undefined) {
  const me = await fetchMe(auth)
  if (!me) throw new Error('无法识别当前 token 对应的用户（/users 返回空）')

  let enterpriseRole = ''
  try {
    const members = unwrap(await apiGet(`/${enterpriseId}/members`, { per_page: 100 }, auth))
    const mine = members.find((m) => Number(m.id) === me.id || Number(m.user?.id) === me.id)
    enterpriseRole = String(mine?.enterprise_role?.ident ?? '')
  } catch {
    enterpriseRole = ''
  }

  const programs = await fetchPrograms(enterpriseId, auth)
  const managedPrograms = programs
    .filter((p) => p.assignee !== '' && (p.assignee === me.name || p.assignee === me.login))
    .map((p) => ({ id: p.id, name: p.name }))

  let ownedIssueCount = 0
  try {
    const mine = unwrap(await apiGet(`/${enterpriseId}/issues`, { assignee_id: me.id, per_page: 100, page: 1 }, auth))
    ownedIssueCount = Array.isArray(mine) ? mine.length : 0
  } catch {
    ownedIssueCount = 0
  }

  const forced = mode === 'manager' || mode === 'project' || mode === 'exec'
  const isAdmin = ADMIN_ROLES.has(enterpriseRole)
  const baseTier = deriveTier({ enterpriseRole, ownedPrograms: managedPrograms, ownedIssueCount })

  // ── 逐项目开合 ──────────────────────────────────────────────────────────
  // 管理者身份与企业级无关项目，不受聚焦项目影响；其余按「这个项目的负责人是不是我」判定。
  const focusId = focusProgramId === undefined || focusProgramId === null ? undefined : Number(focusProgramId)
  const focusProgram = focusId === undefined ? undefined : managedPrograms.find((p) => p.id === focusId)
  const inManaged = focusId !== undefined && focusProgram !== undefined

  let tier = baseTier
  if (forced) {
    tier = mode
  } else if (focusId !== undefined && !isAdmin) {
    tier = inManaged ? 'project' : 'exec'
  }
  const persona = personaOf(tier)

  const reason = forced
    ? `由配置强制指定为「${TIERS[tier].label}」（mode=${mode}）`
    : focusId !== undefined && !isAdmin
      ? inManaged
        ? `聚焦项目 ${focusId}（${focusProgram.name}）的负责人是你 → 该项目开启项目管理与分析`
        : `你在项目 ${focusId} 里不是负责人 → 该项目按执行档处理（不开启项目管理与分析）`
      : isAdmin
        ? `企业角色是「${ROLE_LABELS[enterpriseRole] ?? enterpriseRole}」→ 管理者`
        : managedPrograms.length > 0
          ? `你是 ${managedPrograms.length} 个项目的负责人（${managedPrograms.map((p) => p.name).join('、')}），且与当前 token 为同一人 → 项目执行（负责人档，开启项目管理与分析）`
          : '你不是任何项目的负责人 → 项目执行（执行档，仅执行功能）'

  const role = {
    ok: true,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    mode,
    enterprise: { id: enterpriseId },
    me,
    enterpriseRole,
    tier,
    persona,
    /** 聚焦判定：本次是否为某个具体项目的判定。 */
    focusProgramId: focusId ?? null,
    focusManaged: focusId === undefined ? null : inManaged,
    canManageProject: TIERS[tier].management,
    /** 本档可用的 MCP 工具集（门禁与 --enabled-toolsets 共用这一份）。 */
    tools: TIERS[tier].tools,
    /** 本档的写工具子集：只读部署（allowWrites=false）时门禁按它硬拦。 */
    writes: TIERS[tier].writes,
    managedPrograms,
    ownedPrograms: managedPrograms,
    ownedIssueCount,
    reason,
  }
  role.contextText = renderPersonaContext(role)
  role.summary = renderRoleSummary(role)
  return role
}

/**
 * 拉取单个项目的工作项清单（整屏视图下钻用）。
 * @param {number} enterpriseId
 * @param {number} programId
 * @param {{ token: string }} auth
 * @param {string} [state] - 可选状态过滤
 */
export async function listProgramIssues(enterpriseId, programId, auth, state) {
  const now = Date.now()
  const filters = { program_id: programId }
  if (state) filters.state = state
  const { rows: raw, truncated } = await fetchIssues(enterpriseId, filters, auth)
  const issues = raw.map((it) => ({
    ...it,
    overdue: isOverdue(it, now),
    overdueDays: isOverdue(it, now) ? overdueDays(it, now) : 0,
  }))
  const byState = new Map()
  for (const it of issues) byState.set(it.state, (byState.get(it.state) ?? 0) + 1)
  return {
    ok: true,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    programId,
    total: issues.length,
    /** true = 工作项超过翻页上限，列表被截断（界面会明说）。 */
    truncated,
    kpi: {
      total: issues.length,
      overdue: issues.filter((it) => it.overdue).length,
      unassigned: issues.filter((it) => !it.assignee && !CLOSED_STATES.has(it.state)).length,
    },
    distribution: [...byState.entries()].map(([st, count]) => ({ state: st, count })).sort((a, b) => b.count - a.count),
    issues,
  }
}

// ── 工作项详情（描述 / 前置依赖 / 评论讨论）──────────────────────────────────
//
// 数据来源（3 次调用，全部只读）：
//   1. GET /{eid}/issues/{ident}            → 描述 + 全部结构化字段
//   2. GET /{eid}/issues/{ident}/notes      → 评论（讨论）
//   3. GET /{eid}/issues                   → 仅是**为解析前置依赖**取一次编号索引
//
// 为什么第 3 步必要：描述里的「## 前置依赖」写的是一串工作项编号，
// 要知道它「完成没有」必须拿到那些编号的状态。企业级一次列表就能建索引，
// 比对每个依赖单独查一次便宜得多。

/** 评论里正文的长度上限（防止一条巨型评论把整份 payload 撑大）。 */
const COMMENT_MAX_CHARS = 4000

/**
 * 取一个工作项的完整详情。
 *
 * @param {number} enterpriseId
 * @param {string} ident - 工作项编号（如 DM0001）
 * @param {{ token: string }} auth
 * @param {{ commentLimit?: number }} [opts]
 */
export async function issueDetail(enterpriseId, ident, auth, opts = {}) {
  const commentLimit = opts.commentLimit ?? 50
  const raw = await apiGet(`/${enterpriseId}/issues/${ident}`, { qt: 'ident' }, auth)
  const notesRaw = await apiGet(`/${enterpriseId}/issues/${ident}/notes`, {
    qt: 'ident', per_page: commentLimit, page: 1, sort: 'created_at', direction: 'asc',
  }, auth).catch(() => ({ data: [] }))

  // 编号索引：一次企业级列表，用来解析「前置依赖」里的编号指向哪个工作项
  const index = new Map()
  try {
    const { rows } = await fetchIssues(enterpriseId, {}, auth, { maxPages: DEFAULT_MAX_PAGES })
    for (const it of rows) index.set(it.ident, it)
  } catch { /* 索引取不到不影响详情主体，只是依赖项无法标注状态 */ }

  const milestone = raw.milestone ?? null
  const description = String(raw.description ?? '')
  const tpl = parseTemplate(description)
  // 依赖引用可能是 Gitee 编号，也可能是标题里的 WBS 编码（`ME-02` ↔ `DEMO900-ME-02`），
  // 所以交给 resolveRefs 统一反查，而不是在这里按编号硬查。
  const dependencies = resolveRefs(tpl.dependencyRefs, [...index.values()], String(raw.ident ?? ident))
  const blockers = dependencies.filter((d) => d.known && !d.done && !d.self)

  const comments = (Array.isArray(notesRaw?.data) ? notesRaw.data : []).map((n) => ({
    id: Number(n.id ?? 0),
    type: String(n.type ?? 'issue_note'),
    author: String(n.author?.name ?? n.author?.login ?? ''),
    authorId: Number(n.author?.id ?? 0),
    createdAt: String(n.created_at ?? ''),
    updatedAt: String(n.updated_at ?? ''),
    content: String(n.content ?? '').slice(0, COMMENT_MAX_CHARS),
    truncated: String(n.content ?? '').length > COMMENT_MAX_CHARS,
  }))

  return {
    ok: true,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    enterpriseId,
    detail: {
      ident: String(raw.ident ?? ident),
      id: Number(raw.id ?? 0),
      title: String(raw.title ?? ''),
      state: String(raw.state ?? ''),
      stateId: Number(raw.issue_state_id ?? 0),
      stateTitle: String(raw.issue_state?.title ?? ''),
      stateColor: String(raw.issue_state?.color ?? ''),
      priority: Number(raw.priority ?? 0),
      priorityHuman: String(raw.priority_human ?? ''),
      typeId: Number(raw.issue_type?.id ?? 0),
      typeTitle: String(raw.issue_type?.title ?? ''),
      programId: Number(raw.program_id ?? 0),
      programName: String(raw.program?.name ?? ''),
      owner: String(raw.assignee?.name ?? raw.assignee?.login ?? ''),
      ownerId: Number(raw.assignee?.id ?? 0),
      author: String(raw.author?.name ?? raw.author?.login ?? ''),
      collaborators: (Array.isArray(raw.collaborators) ? raw.collaborators : [])
        .map((u) => String(u?.name ?? u?.login ?? '')).filter((s) => s !== ''),
      parentIdent: String(raw.parent?.ident ?? ''),
      parentTitle: String(raw.parent?.title ?? ''),
      rootId: Number(raw.root_id ?? 0),
      createdAt: String(raw.created_at ?? ''),
      updatedAt: String(raw.updated_at ?? ''),
      planStartedAt: String(raw.plan_started_at ?? ''),
      startedAt: String(raw.started_at ?? ''),
      deadline: String(raw.deadline ?? ''),
      finishedAt: String(raw.finished_at ?? ''),
      estimatedMinutes: Number(raw.estimated_duration ?? 0),
      registeredMinutes: Number(raw.registered_duration ?? 0),
      labels: (Array.isArray(raw.labels) ? raw.labels : []).map((l) => ({
        name: String(l?.name ?? ''), color: String(l?.color ?? ''),
      })).filter((l) => l.name !== ''),
      milestone: milestone === null ? null : {
        id: Number(milestone.id ?? 0),
        title: String(milestone.title ?? ''),
        state: String(milestone.state ?? ''),
        startDate: String(milestone.start_date ?? ''),
        dueDate: String(milestone.due_date ?? ''),
      },
      url: String(raw.issue_url ?? ''),
      description,
      descriptionType: String(raw.description_type ?? 'md'),
    },
    /** 描述里的结构化分段（## 目标 / ## 前置依赖 / ## 交付物 …）。 */
    template: { sections: tpl.sections, hasTemplate: tpl.hasTemplate },
    dependencies,
    /** 依赖里「还没完成」的那些 —— 这才是真正卡住本项的东西。 */
    blockers,
    comments,
    commentsTotal: Number(notesRaw?.total_count ?? comments.length),
  }
}

/** 列出某工作项类型下的全部状态（改状态的选项来源）。 */
export async function listIssueStates(enterpriseId, issueTypeId, auth) {
  const raw = await apiGet(`/${enterpriseId}/issue_types/${issueTypeId}/issue_states`, { per_page: 50 }, auth)
  const states = unwrap(raw).map((s) => ({
    id: Number(s.id ?? 0),
    title: String(s.title ?? ''),
    color: String(s.color ?? ''),
    serial: Number(s.serial ?? 0),
  })).sort((a, b) => a.serial - b.serial)
  return { ok: true, issueTypeId, states }
}

// ── 写通道（全包唯一的写入口）──────────────────────────────────────────────
//
// 纪律：**所有改动作都从这里出去**。UI 的按钮、路由、将来的其它入口，
// 一律调用下面这三个函数（它们内部共用 apiSend）。
// 这样"谁在什么时候改了什么"只有一处可以审计，也不会出现两套写逻辑漂移。

/**
 * 改工作项状态。
 * @param {number} enterpriseId
 * @param {string} ident
 * @param {number} stateId - `listIssueStates` 给出的状态 id
 * @param {{ token: string }} auth
 */
export async function setIssueState(enterpriseId, ident, stateId, auth) {
  const data = await apiSend('PUT', `/${enterpriseId}/issues/${ident}`, {
    qt: 'ident', issue_state_id: stateId,
  }, auth)
  return {
    ok: true,
    op: 'set-state',
    ident,
    stateId,
    state: String(data?.state ?? ''),
    stateTitle: String(data?.issue_state?.title ?? ''),
  }
}

/**
 * 给工作项写评论。
 * @param {number} enterpriseId
 * @param {string} ident
 * @param {string} body
 * @param {{ token: string }} auth
 */
export async function commentIssue(enterpriseId, ident, body, auth) {
  const text = String(body ?? '').trim()
  if (text === '') throw new Error('评论内容不能为空')
  if (text.length > 8000) throw new Error(`评论过长（${text.length} 字，上限 8000）`)
  const data = await apiSend('POST', `/${enterpriseId}/issues/${ident}/notes`, {
    qt: 'ident', body: text,
  }, auth)
  return {
    ok: true,
    op: 'comment',
    ident,
    noteId: Number(data?.id ?? 0),
    createdAt: String(data?.created_at ?? ''),
  }
}

/**
 * 改派负责人。
 * @param {number} enterpriseId
 * @param {string} ident
 * @param {number} assigneeId - 0 表示取消指派
 * @param {{ token: string }} auth
 */
export async function assignIssue(enterpriseId, ident, assigneeId, auth) {
  const data = await apiSend('PUT', `/${enterpriseId}/issues/${ident}`, {
    qt: 'ident', assignee_id: assigneeId,
  }, auth)
  return {
    ok: true,
    op: 'assign',
    ident,
    assigneeId: Number(assigneeId),
    owner: String(data?.assignee?.name ?? ''),
  }
}

/** 项目成员（改派时的候选人；取不到就给空数组，不阻断流程）。 */
export async function listProgramMembers(enterpriseId, programId, auth) {
  const raw = await apiGet(`/${enterpriseId}/programs/${programId}/users`, { per_page: 100 }, auth).catch(() => null)
  const list = raw === null ? [] : unwrap(raw)
  return {
    ok: true,
    programId,
    members: list.map((u) => ({
      id: Number(u.id ?? 0),
      name: String(u.name ?? u.login ?? ''),
      username: String(u.username ?? u.login ?? ''),
    })).filter((u) => u.id > 0),
  }
}

// ── 样例数据（无 token 时用于渲染链路自检）──────────────────────────────────

/** 确定性样例数据：用于在没有 token 的环境下验证渲染管线。 */
export function fixtureRaw() {
  const programs = [
    { id: 1001, name: '示例项目 A（硬件）', ident: 'demo-a', category: 'scrum', status: 0, assignee: { name: '成员甲' }, issues_count: 18, projects_count: 2, users_count: 6, updated_at: '2026-09-10T12:00:00+08:00' },
    { id: 1002, name: '示例项目 B（平台）', ident: 'demo-b', category: 'standard', status: 0, assignee: { name: '成员乙' }, issues_count: 11, projects_count: 1, users_count: 4, updated_at: '2026-09-09T09:00:00+08:00' },
    { id: 1003, name: '示例项目 C（接入）', ident: 'demo-c', category: 'kanban', status: 1, assignee: { name: '成员丙' }, issues_count: 7, projects_count: 1, users_count: 3, updated_at: '2026-09-05T15:00:00+08:00' },
  ]
  const mk = (id, ident, title, state, priority, programId, owner, deadline, labelCount = 3, idleDays = 1, extra = {}) => ({
    id, ident, title, state,
    priority,
    priority_human: priority === 4 ? '紧急' : priority === 3 ? '高' : priority === 2 ? '中' : '低',
    program_id: programId,
    assignee: owner ? { id: id + 100, name: owner } : null,
    deadline,
    plan_started_at: extra.plan_started_at ?? new Date(Date.now() - 20 * 86400000).toISOString(),
    // 实际开始 = 计划开始 + startDelay 天（负数 = 提前开工）
    started_at: extra.started_at ?? (state === 'open' ? null : new Date(Date.now() - (20 - (extra.startDelay ?? 0)) * 86400000).toISOString()),
    finished_at: state === 'closed' ? new Date(Date.now() - (extra.finishDelay ?? 1) * 86400000).toISOString() : null,
    created_at: new Date(Date.now() - 40 * 86400000).toISOString(),
    updated_at: new Date(Date.now() - idleDays * 86400000).toISOString(),
    estimated_duration: 480,
    registered_duration: 300,
    labels: Array.from({ length: labelCount }, (_, i) => ({ id: i + 1, name: ['硬件电气', 'P0', 'M2-原理图设计', '额外'][i] ?? `L${i}` })),
    issue_type: { id: 100, title: '任务' },
    milestone: extra.milestone ?? null,
    comments_count: extra.commentsCount ?? 0,
  })
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString()
  /** 里程碑样例：一个已达成、一个已逾期未达、一个临近有风险。 */
  const MILE_DONE = { id: 9001, title: 'M1 示例里程碑（已达成）', state: 'closed', start_date: day(-40).slice(0, 10), due_date: day(-10).slice(0, 10), program_id: 1001 }
  const MILE_MISSED = { id: 9002, title: 'M2 示例里程碑（逾期未达）', state: 'open', start_date: day(-30).slice(0, 10), due_date: day(-4).slice(0, 10), program_id: 1001 }
  const MILE_RISK = { id: 9003, title: 'M3 示例里程碑（有风险）', state: 'open', start_date: day(-10).slice(0, 10), due_date: day(3).slice(0, 10), program_id: 1002 }
  const issues = [
    mk(1, 'DM0001', '【DEMO-HE-05】示例任务：供电纹波超标', 'progressing', 4, 1001, '成员甲', day(-2), 3, 1, { milestone: MILE_MISSED, startDelay: 9, commentsCount: 3 }),
    mk(2, 'DM0002', '【DEMO-ME-02】示例任务：结构适配设计', 'progressing', 3, 1001, '成员乙', day(4), 3, 1, { startDelay: 1 }),
    mk(3, 'DM0003', '【DEMO-CA-01】示例任务：控制板打样', 'open', 3, 1001, '', day(6), 0, 1, { milestone: MILE_RISK }),
    mk(4, 'DM0004', '示例任务：人机界面开发', 'open', 2, 1001, '成员丙', day(9)),
    mk(5, 'DM0005', '示例任务：驱动适配', 'closed', 2, 1001, '成员丙', day(-3), 3, 1, { milestone: MILE_DONE, finishDelay: 2 }),
    mk(6, 'DM0006', '示例任务：EMC 预测试', 'progressing', 3, 1001, '成员甲', day(1), 2, 40),
    mk(7, 'DM0007', '示例任务：数据看板联调', 'progressing', 2, 1002, '成员乙', day(-1), 3, 1, { startDelay: 5 }),
    mk(8, 'DM0008', '示例任务：寿命模型标定', 'open', 2, 1002, '成员乙', day(12), 3, 20, { milestone: MILE_RISK }),
    mk(9, 'DM0009', '示例任务：部署手册编写', 'open', 1, 1002, '', day(15), 3, 1),
    mk(10, 'DM0010', '示例任务：固件升级', 'closed', 2, 1003, '成员丙', day(-5), 3, 1, { finishDelay: 0 }),
    mk(11, 'DM0011', '示例任务：主题规范评审', 'progressing', 1, 1003, '成员丙', day(3), 3, 1),
    mk(12, 'DM0012', '示例任务：接入拆分设计', 'progressing', 3, 1003, '成员乙', day(2), 3, 1, { startDelay: 12 }),
  ]
  return { programs, issues, me: { id: 1, name: '我' } }
}

/** 样例工作项详情（fixture 模式下验证 F-09 详情面板的渲染链路）。 */
export function fixtureIssueDetail(ident) {
  const raw = fixtureRaw()
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString()
  const target = raw.issues.find((it) => it.ident === ident) ?? raw.issues[0]
  const desc = [
    '## 目标',
    '示例描述：把供电纹波压到验收线以内，满足预测试要求。',
    '',
    '## 前置依赖',
    '- ME-02 结构适配设计',
    '- 无（选型已冻结）',
    '',
    '## 交付物',
    '- 改版原理图',
    '- 实测波形报告',
    '',
    '## 验收标准',
    '- 满载与轻载两种工况下均达标',
  ].join('\n')
  const tpl = parseTemplate(desc)
  // 与真实路径共用 resolveRefs，fixture 才能真的验到解析逻辑
  const index = raw.issues.map((it) => ({
    ident: it.ident, title: it.title, state: it.state,
    assignee: it.assignee?.name ?? '',
  }))
  const dependencies = resolveRefs(tpl.dependencyRefs, index, target.ident)
  return {
    ok: true,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    enterpriseId: 0,
    detail: {
      ident: target.ident,
      id: target.id,
      title: target.title,
      state: target.state,
      stateId: 9000001,
      stateTitle: target.state === 'closed' ? '已完成' : target.state === 'progressing' ? '进行中' : '待办的',
      stateColor: '#8c92a4',
      priority: target.priority,
      priorityHuman: target.priority_human,
      typeId: 100,
      typeTitle: '任务',
      programId: target.program_id,
      programName: raw.programs.find((p) => p.id === target.program_id)?.name ?? '',
      owner: target.assignee?.name ?? '',
      ownerId: target.assignee?.id ?? 0,
      author: '成员乙',
      collaborators: ['成员乙', '成员丙'],
      parentIdent: '',
      parentTitle: '',
      rootId: 0,
      createdAt: target.created_at,
      updatedAt: target.updated_at,
      planStartedAt: target.plan_started_at,
      startedAt: target.started_at ?? '',
      deadline: target.deadline,
      finishedAt: target.finished_at ?? '',
      estimatedMinutes: 480,
      registeredMinutes: 300,
      labels: target.labels.map((l) => ({ name: l.name, color: '' })),
      milestone: target.milestone === null ? null : {
        id: target.milestone.id, title: target.milestone.title, state: target.milestone.state,
        startDate: target.milestone.start_date, dueDate: target.milestone.due_date,
      },
      url: '',
      description: desc,
      descriptionType: 'md',
    },
    template: { sections: tpl.sections, hasTemplate: tpl.hasTemplate },
    dependencies,
    blockers: dependencies.filter((d) => d.known && !d.done && !d.self),
    comments: [
      { id: 1, type: 'issue_note', author: '成员乙', authorId: 2, createdAt: day(-6), updatedAt: day(-6), content: '选型已经冻结，这个问题按这个方向排查。', truncated: false },
      { id: 2, type: 'issue_note', author: '成员甲', authorId: 1, createdAt: day(-3), updatedAt: day(-3), content: '已换用低 ESR 电容，实测降到 62mV，还差一点。\n\n下一步：调整反馈环路补偿。', truncated: false },
      { id: 3, type: 'issue_note', author: '成员乙', authorId: 2, createdAt: day(-1), updatedAt: day(-1), content: '> 已换用低 ESR 电容，实测降到 62mV\n\n补偿网络我可以一起看，明天给你结论。', truncated: false },
    ],
    commentsTotal: 3,
  }
}

/** 样例状态列表（fixture 模式下验证改状态入口的渲染链路）。 */
export function fixtureStates(issueTypeId = 100) {
  return {
    ok: true,
    issueTypeId: Number(issueTypeId),
    states: [
      { id: 9000001, title: '待办的', color: '#8c92a4', serial: 0 },
      { id: 9000002, title: '进行中', color: '#0086d6', serial: 1 },
      { id: 9000003, title: '已完成', color: '#00b42a', serial: 2 },
      { id: 9000004, title: '已拒绝', color: '#f53f3f', serial: 3 },
    ],
  }
}

/** 样例成员列表（fixture 模式下验证改派入口的渲染链路）。 */
export function fixtureMembers(programId = 1001) {
  return {
    ok: true,
    programId: Number(programId),
    members: [
      { id: 901, name: '成员甲', username: 'member-a' },
      { id: 902, name: '成员乙', username: 'member-b' },
      { id: 903, name: '成员丙', username: 'member-c' },
      { id: 904, name: '成员丁', username: 'member-d' },
    ],
  }
}

// ── 短时缓存（唯一允许的落盘，且只在 /tmp）──────────────────────────────────

/** 缓存文件路径。 */
function cachePath(key) {
  return join(tmpdir(), `dsh-gitee-chat-${key.replace(/[^\w.-]/g, '_')}.json`)
}

/** 读秒级缓存；过期返回 null。 */
function readCache(key, ttlMs) {
  try {
    const path = cachePath(key)
    if (!existsSync(path)) return null
    const { at, payload } = JSON.parse(readFileSync(path, 'utf8'))
    if (Date.now() - at > ttlMs) return null
    return payload
  } catch {
    return null
  }
}

/** 写秒级缓存（失败静默：缓存是优化，不是依赖）。 */
function writeCache(key, payload) {
  try {
    mkdirSync(tmpdir(), { recursive: true })
    writeFileSync(cachePath(key), JSON.stringify({ at: Date.now(), payload }))
  } catch {
    /* 忽略 */
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

/**
 * 构建看板 payload。
 * @param {{ scope: string, program?: number, fixture?: boolean, enterprise?: number }} opts
 */
export async function buildPayload(opts) {
  const scope = opts.scope ?? 'portfolio'
  const now = Date.now()

  if (opts.fixture) {
    const raw = fixtureRaw()
    const board = computeBoard({ programs: raw.programs.map((p) => ({
      id: Number(p.id), name: p.name, ident: p.ident, category: p.category, status: p.status,
      assignee: p.assignee?.name ?? '', issuesCount: p.issues_count, reposCount: p.projects_count,
      usersCount: p.users_count, updatedAt: p.updated_at,
    })), issues: raw.issues.map((it) => ({
      id: it.id, ident: it.ident, title: it.title, state: it.state, priority: it.priority,
      priorityHuman: it.priority_human, programId: it.program_id,
      assignee: it.assignee?.name ?? '', assigneeId: it.assignee?.id ?? 0,
      deadline: it.deadline, updatedAt: it.updated_at, typeTitle: it.issue_type?.title ?? '',
    })), now })
    return finalize({
      scope,
      enterprise: { id: 0, name: '样例企业' },
      source: 'fixture',
      board,
      me: raw.me,
      issues: raw.issues.map((it) => ({
        id: it.id, ident: it.ident, title: it.title, state: it.state, priority: it.priority,
        priorityHuman: it.priority_human, programId: it.program_id,
        assignee: it.assignee?.name ?? '', assigneeId: it.assignee?.id ?? 0,
        deadline: it.deadline, planStartedAt: it.plan_started_at ?? '', finishedAt: it.finished_at ?? '',
        startedAt: it.started_at ?? '', createdAt: it.created_at ?? '', updatedAt: it.updated_at ?? '',
        estimatedMinutes: it.estimated_duration ?? 0, registeredMinutes: it.registered_duration ?? 0,
        labels: Array.isArray(it.labels) ? it.labels.map((l) => l.name) : [],
        typeTitle: it.issue_type?.title ?? '', typeId: it.issue_type?.id ?? 0,
        milestone: it.milestone ?? null, hasMilestone: it.milestone != null,
        parentId: it.parent_id ?? 0, rootId: it.root_id ?? 0, commentsCount: it.comments_count ?? 0,
      })),
    })
  }

  const auth = resolveToken()
  if (!auth) {
    throw new Error(
      '未找到 Gitee 企业版 token。请设置 GITEE_ENT_MCP_ACCESS_TOKEN 环境变量，'
      + `或写入 ${tokenFileCandidates()[0]}。`,
    )
  }
  const ent = await resolveEnterprise(opts.enterprise, auth)
  const enterpriseId = ent.id

  // 工作项过滤：mywork 只看与我相关；program 只看该项目
  const issueFilters = {}
  if (opts.program !== undefined) issueFilters.program_id = opts.program

  const [programsRaw, me] = await Promise.all([
    fetchPrograms(enterpriseId, auth),
    fetchMe(auth).catch(() => null),
  ])
  // mywork 精确按「负责人是我」过滤，而不是 only_related_me（后者会把未指派的也算进来）
  if (scope === 'mywork' && me) issueFilters.assignee_id = me.id
  const { rows: issuesRaw, truncated } = await fetchIssues(enterpriseId, issueFilters, auth)

  let programs = programsRaw
  const issues = issuesRaw
  if (opts.program !== undefined) {
    programs = programs.filter((p) => p.id === Number(opts.program))
  }
  if (scope === 'mywork') {
    const withMine = new Set(issues.map((it) => it.programId))
    programs = programs.filter((p) => withMine.has(p.id))
  }

  const board = computeBoard({ programs, issues, now })
  return finalize({ scope, enterprise: { id: enterpriseId, name: ent.name }, source: 'live', board, me, issues, truncated })
}

/** 补齐公共字段并生成摘要。 */
function finalize({ scope, enterprise, source, board, me, issues, truncated = false }) {
  const thresholds = resolveThresholds()
  const issuesSafe = issues ?? []
  const payload = {
    ok: true,
    scope,
    source,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    enterprise,
    me: me ? { id: me.id, name: me.name } : null,
    /** true = 工作项超过翻页上限被截断（所有统计都只覆盖已取到的部分）。 */
    truncated,
    ...board,
    // 固定分析：纯脚本计算，模型与卡片拿到的是同一份计算结果
    analysis: {
      ...computeAnalysis({ programs: board.programs, issues: issuesSafe, thresholds }),
      // 第二批（E-07 ~ E-10）：同样零额外调用，全部基于已取到的字段
      progress: computeProgress({ issues: issuesSafe, programs: board.programs, now: Date.now() }),
      capacity: computeCapacity({ issues: issuesSafe, programs: board.programs, now: Date.now(), thresholds }),
      milestones: computeMilestones({ issues: issuesSafe, programs: board.programs, now: Date.now(), thresholds }),
      delivery: computeDelivery({ issues: issuesSafe, now: Date.now(), thresholds }),
    },
  }
  payload.summary = renderSummary(payload)
  return payload
}

/** 样例人格数据（覆盖「项目负责人」这一档）。 */
export function fixtureRole(mode = 'auto', focusProgramId = undefined) {
  const managedPrograms = [{ id: 1001, name: '示例项目 A（硬件）' }]
  const forced = mode === 'manager' || mode === 'project' || mode === 'exec'
  const focusId = focusProgramId === undefined || focusProgramId === null ? undefined : Number(focusProgramId)
  const focusProgram = focusId === undefined ? undefined : managedPrograms.find((p) => p.id === focusId)
  const inManaged = focusId !== undefined && focusProgram !== undefined

  let tier = forced ? mode : 'project'
  if (!forced && focusId !== undefined) tier = inManaged ? 'project' : 'exec'

  const role = {
    ok: true,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    mode,
    enterprise: { id: 0 },
    me: { id: 901, name: '成员甲', login: 'member-a' },
    enterpriseRole: tier === 'manager' ? 'admin' : 'member',
    tier,
    persona: personaOf(tier),
    focusProgramId: focusId ?? null,
    focusManaged: focusId === undefined ? null : inManaged,
    canManageProject: TIERS[tier].management,
    tools: TIERS[tier].tools,
    /// 写工具子集：只读部署（allowWrites=false）的门禁按它硬拦。
    /// fixture 必须带上，否则冒烟里"只读部署"那条会因为收到空数组而失效。
    writes: TIERS[tier].writes,
    managedPrograms: tier === 'exec' && focusId !== undefined ? [] : managedPrograms,
    ownedPrograms: managedPrograms,
    ownedIssueCount: 3,
    reason: forced
      ? `由配置强制指定为「${TIERS[tier].label}」（mode=${mode}）`
      : focusId !== undefined
        ? inManaged
          ? `聚焦项目 ${focusId}（${focusProgram.name}）的负责人是你 → 该项目开启项目管理与分析`
          : `你在项目 ${focusId} 里不是负责人 → 该项目按执行档处理（不开启项目管理与分析）`
        : '你是 1 个项目的负责人（示例项目 A（硬件）），且与当前 token 为同一人 → 项目执行（负责人档，开启项目管理与分析）',
  }
  role.contextText = renderPersonaContext(role)
  role.summary = renderRoleSummary(role)
  return role
}

/** 样例工作项清单（fixture 模式，供渲染自检）。 */
export function fixtureProgramIssues(programId) {
  const raw = fixtureRaw()
  const now = Date.now()
  const mine = raw.issues
    .filter((it) => it.program_id === Number(programId))
    .map((it) => {
      const deadline = it.deadline ?? ''
      const t = Date.parse(deadline)
      const late = !CLOSED_STATES.has(it.state) && Number.isFinite(t) && t < now
      return {
        id: it.id,
        ident: it.ident,
        title: it.title,
        state: it.state,
        priority: it.priority,
        priorityHuman: it.priority_human,
        programId: it.program_id,
        assignee: it.assignee?.name ?? '',
        assigneeId: it.assignee?.id ?? 0,
        deadline,
        updatedAt: it.updated_at,
        typeTitle: it.issue_type?.title ?? '',
        overdue: late,
        overdueDays: late ? Math.round((now - t) / 86400000) : 0,
      }
    })
  const byState = new Map()
  for (const it of mine) byState.set(it.state, (byState.get(it.state) ?? 0) + 1)
  return {
    ok: true,
    generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
    programId: Number(programId),
    total: mine.length,
    kpi: {
      total: mine.length,
      overdue: mine.filter((it) => it.overdue).length,
      unassigned: mine.filter((it) => !it.assignee && !CLOSED_STATES.has(it.state)).length,
    },
    distribution: [...byState.entries()].map(([st, count]) => ({ state: st, count })),
    issues: mine,
  }
}

/** 环境自检：token / 企业 / 连通性。 */
export async function health() {
  const auth = resolveToken()
  if (!auth) {
    return { ok: false, stage: 'token', message: '未配置 token', candidates: tokenFileCandidates() }
  }
  try {
    const ent = await resolveEnterprise(undefined, auth)
    const programs = await apiGet(`/${ent.id}/programs`, { per_page: 1 }, auth)
    const count = Array.isArray(programs) ? programs.length : (programs.total_count ?? 0)
    return {
      ok: true,
      stage: 'ok',
      tokenSource: auth.source,
      enterprise: { id: ent.id, name: ent.name },
      programsSeen: count,
      apiBase: apiBase(),
    }
  } catch (error) {
    return { ok: false, stage: 'api', message: error instanceof Error ? error.message : String(error) }
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2))
  const scope = cmd === 'mywork' ? 'mywork' : 'portfolio'
  try {
    /** 取一次 token + 企业，写操作与详情都用得到。 */
    const needAuth = () => {
      const auth = resolveToken()
      if (!auth) throw new Error(`未找到 Gitee 企业版 token。请设置 GITEE_ENT_MCP_ACCESS_TOKEN，或写入 ${tokenFileCandidates()[0]}。`)
      return auth
    }

    if (cmd === 'health') {
      const result = await health()
      process.stdout.write(JSON.stringify(result, null, 2) + '\n')
      process.exit(result.ok ? 0 : 3)
    }

    // ── 工作项详情（描述 / 前置依赖 / 评论讨论）──────────────────────────
    if (cmd === 'issue') {
      const ident = typeof flags.ident === 'string' ? flags.ident : ''
      if (ident === '') throw new Error('issue 需要 --ident <工作项编号>')
      const useFixture = flags.fixture === true || process.env.GITEE_CHAT_FIXTURE === '1'
      const result = useFixture
        ? fixtureIssueDetail(ident.toUpperCase())
        : await (async () => {
            const auth = needAuth()
            const ent = await resolveEnterprise(flags.enterprise, auth)
            return issueDetail(ent.id, ident.toUpperCase(), auth, {
              commentLimit: flags['comment-limit'] !== undefined ? Number(flags['comment-limit']) : undefined,
            })
          })()
      if (flags.json) {
        process.stdout.write(JSON.stringify(result) + '\n')
      } else {
        const d = result.detail
        const L = [`## ${d.ident} ${d.title}`, '', `- 状态：${d.stateTitle || d.state} ｜ 负责人：${d.owner || '未指派'} ｜ 截止：${d.deadline ? d.deadline.slice(0, 10) : '—'}`]
        if (result.blockers.length > 0) L.push(`- ⚠️ 被 ${result.blockers.length} 个未完成的前置项阻塞：${result.blockers.map((b) => b.ident).join('、')}`)
        L.push('', '### 描述', '', d.description || '(空)')
        if (result.comments.length > 0) {
          L.push('', `### 评论（${result.commentsTotal}）`, '')
          for (const c of result.comments) L.push(`- **${c.author}** ${c.createdAt.slice(0, 16)}：${c.content.split('\n')[0]}`)
        }
        process.stdout.write(L.join('\n') + '\n')
      }
      process.exit(0)
    }

    // ── 状态选项（改状态的候选）─────────────────────────────────────────
    if (cmd === 'states') {
      const typeId = flags.type !== undefined && flags.type !== true ? Number(flags.type) : NaN
      if (!Number.isFinite(typeId)) throw new Error('states 需要 --type <工作项类型id>')
      const useFixture = flags.fixture === true || process.env.GITEE_CHAT_FIXTURE === '1'
      const result = useFixture
        ? fixtureStates(typeId)
        : await (async () => {
            const auth = needAuth()
            const ent = await resolveEnterprise(flags.enterprise, auth)
            return listIssueStates(ent.id, typeId, auth)
          })()
      process.stdout.write(flags.json ? JSON.stringify(result) + '\n'
        : result.states.map((s) => `- \`${s.id}\` ${s.title}`).join('\n') + '\n')
      process.exit(0)
    }

    // ── 项目成员（改派候选）─────────────────────────────────────────────
    if (cmd === 'members') {
      const pid = flags.program !== undefined && flags.program !== true ? Number(flags.program) : NaN
      if (!Number.isFinite(pid)) throw new Error('members 需要 --program <项目id>')
      const useFixture = flags.fixture === true || process.env.GITEE_CHAT_FIXTURE === '1'
      const result = useFixture
        ? fixtureMembers(pid)
        : await (async () => {
            const auth = needAuth()
            const ent = await resolveEnterprise(flags.enterprise, auth)
            return listProgramMembers(ent.id, pid, auth)
          })()
      process.stdout.write(flags.json ? JSON.stringify(result) + '\n'
        : result.members.map((m) => `- \`${m.id}\` ${m.name}`).join('\n') + '\n')
      process.exit(0)
    }

    // ── 写操作（唯一写入口，三个子命令）─────────────────────────────────
    if (cmd === 'set-state' || cmd === 'comment' || cmd === 'assign') {
      const ident = typeof flags.ident === 'string' ? flags.ident : ''
      if (ident === '') throw new Error(`${cmd} 需要 --ident <工作项编号>`)
      const auth = needAuth()
      const ent = await resolveEnterprise(flags.enterprise, auth)
      let result
      if (cmd === 'set-state') {
        const stateId = flags['state-id'] !== undefined && flags['state-id'] !== true ? Number(flags['state-id']) : NaN
        if (!Number.isFinite(stateId)) throw new Error('set-state 需要 --state-id <状态id>（用 `gq states --type <类型id>` 查）')
        result = await setIssueState(ent.id, ident.toUpperCase(), stateId, auth)
      } else if (cmd === 'comment') {
        const body = flags['body-file'] === '-' || flags['body-stdin'] === true
          ? readFileSync(0, 'utf8')
          : (typeof flags.body === 'string' ? flags.body : '')
        result = await commentIssue(ent.id, ident.toUpperCase(), body, auth)
      } else {
        const assigneeId = flags['assignee-id'] !== undefined && flags['assignee-id'] !== true ? Number(flags['assignee-id']) : NaN
        if (!Number.isFinite(assigneeId)) throw new Error('assign 需要 --assignee-id <用户id>（0 = 取消指派）')
        result = await assignIssue(ent.id, ident.toUpperCase(), assigneeId, auth)
      }
      process.stdout.write(JSON.stringify(result) + '\n')
      process.exit(0)
    }

    if (cmd === 'enterprises') {
      const auth = resolveToken()
      if (!auth) throw new Error(`未找到 Gitee 企业版 token。请设置 GITEE_ENT_MCP_ACCESS_TOKEN，或写入 ${tokenFileCandidates()[0]}。`)
      const list = await listEnterprises(auth)

      // --use <id>：写入本地配置文件，下一次调用即生效（无需重启）
      if (flags.use !== undefined && flags.use !== true) {
        const id = Number(flags.use)
        const hit = list.find((e) => e.id === id)
        if (!hit) {
          throw new Error(`企业 ${id} 不在当前 token 可见范围内：${list.map((e) => `${e.id}=${e.name}`).join('、')}`)
        }
        writeConfig({ enterpriseId: id })
        if (flags.json) {
          process.stdout.write(JSON.stringify({ ok: true, selected: { id, name: hit.name }, configPath: configPath() }) + '\n')
        } else {
          process.stdout.write(`已选定企业：${hit.name}（${id}）\n写入 ${configPath()}\n` +
            '后续所有取数都用这个企业；随时可用 `gq enterprises --use <id>` 切换。\n')
        }
        process.exit(0)
      }
      if (flags.clear === true) {
        writeConfig({ enterpriseId: 0 })
        process.stdout.write('已清除企业选择，恢复为自动模式（多企业时会报错要求指定）。\n')
        process.exit(0)
      }

      // 「当前生效」要综合考虑来源优先级：flag > env > 配置文件 > 未指定
      // （只看配置文件会误导——数据可能来自插件配置传下来的 --enterprise）
      const flagId = flags.enterprise !== undefined && flags.enterprise !== true ? Number(flags.enterprise) : 0
      const envId = Number(process.env.GITEE_ENT_ID ?? process.env.GITEE_CHAT_ENTERPRISE_ID ?? 0) || 0
      const fileId = Number(readConfig().enterpriseId) || 0
      const current = flagId || envId || fileId
      const source = flagId ? '插件配置(--enterprise)' : envId ? '环境变量 GITEE_ENT_ID' : fileId ? '本地配置文件' : '未指定（自动）'
      const lines = ['## 当前 token 可见的企业', '']
      for (const e of list) {
        const mark = Number(current) === e.id ? ' ← **当前使用**' : ''
        lines.push(`- \`${e.id}\`  **${e.name}**  (path: ${e.path})${mark}`)
      }
      lines.push('')
      lines.push(`当前生效：${current > 0 ? current : '（未指定）'}　来源：${source}`)
      lines.push(`本地配置文件：${configPath()}（当前值 ${fileId || '未设'}）`)
      lines.push('')
      lines.push('切换：`gq enterprises --use <id>`（写入配置文件，无需重启 DSH）')
      lines.push('清除：`gq enterprises --clear`')
      // 注意：必须带 ok:true —— host 侧的 execJson 用它与业务失败信封区分
      process.stdout.write((flags.json
        ? JSON.stringify({ ok: true, enterprises: list, current: current || null, source, fileEnterpriseId: fileId || null, configPath: configPath() })
        : lines.join('\n')) + '\n')
      process.exit(0)
    }

    if (cmd === 'issues') {
      const pid = flags.program !== undefined && flags.program !== true ? Number(flags.program) : NaN
      if (!Number.isFinite(pid)) throw new Error('issues 需要 --program <项目id>')
      const useFixture = flags.fixture === true || process.env.GITEE_CHAT_FIXTURE === '1'
      let result
      if (useFixture) {
        result = fixtureProgramIssues(pid)
      } else {
        const auth = resolveToken()
        if (!auth) throw new Error(`未找到 Gitee 企业版 token。请设置 GITEE_ENT_MCP_ACCESS_TOKEN，或写入 ${tokenFileCandidates()[0]}。`)
        const ent = await resolveEnterprise(flags.enterprise, auth)
        result = await listProgramIssues(ent.id, pid, auth, typeof flags.state === 'string' ? flags.state : undefined)
      }
      if (flags.json) {
        process.stdout.write(JSON.stringify(result) + '\n')
      } else {
        const L = [`## 项目 ${pid} 工作项（${result.total}）`, '']
        for (const it of result.issues.slice(0, 30)) {
          L.push(`- \`${it.ident}\` ${it.title} · ${it.assignee || '未指派'} · ${it.state}${it.overdue ? ` · ⚠️逾期${it.overdueDays}天` : ''}`)
        }
        process.stdout.write(L.join('\n') + '\n')
      }
      process.exit(0)
    }

    if (cmd === 'matrix') {
      process.stdout.write(renderMatrix() + '\n')
      process.exit(0)
    }

    if (cmd === 'role') {
      const useFixture = flags.fixture === true || process.env.GITEE_CHAT_FIXTURE === '1'
      const mode = typeof flags.mode === 'string' ? flags.mode : 'auto'
      let role
      if (useFixture) {
        role = fixtureRole(mode, flags.program !== undefined && flags.program !== true ? Number(flags.program) : undefined)
      } else {
        const auth = resolveToken()
        if (!auth) throw new Error(`未找到 Gitee 企业版 token。请设置 GITEE_ENT_MCP_ACCESS_TOKEN，或写入 ${tokenFileCandidates()[0]}。`)
        const ent = await resolveEnterprise(flags.enterprise, auth)
        role = await resolveRole(
          ent.id,
          auth,
          mode,
          flags.program !== undefined && flags.program !== true ? Number(flags.program) : undefined,
        )
      }
      process.stdout.write(flags.json ? JSON.stringify(role) + '\n' : role.summary + '\n')
      process.exit(0)
    }

    const key = `${scope}:${flags.program ?? 'all'}:${flags.fixture ? 'fx' : 'live'}`
    const ttl = flags['cache-ttl'] ? Number(flags['cache-ttl']) : 0
    let payload = ttl > 0 ? readCache(key, ttl) : null
    if (!payload) {
      payload = await buildPayload({
        scope,
        program: flags.program !== undefined && flags.program !== true ? Number(flags.program) : undefined,
        fixture: flags.fixture === true || process.env.GITEE_CHAT_FIXTURE === '1',
        enterprise: flags.enterprise !== undefined && flags.enterprise !== true ? Number(flags.enterprise) : undefined,
      })
      if (ttl > 0) writeCache(key, payload)
    }
    process.stdout.write(flags.json ? JSON.stringify(payload) + '\n' : payload.summary + '\n')
    process.exit(0)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (flags.json) {
      process.stdout.write(JSON.stringify({ ok: false, error: message, scope }) + '\n')
    } else {
      process.stderr.write(`gq 失败：${message}\n`)
    }
    process.exit(1)
  }
}

// 仅在被直接执行时跑 CLI（被 import 时不跑）
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
}
