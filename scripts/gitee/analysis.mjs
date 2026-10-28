/**
 * 固定分析（第二批）—— 全部是**纯函数**，零额外网络调用。
 *
 * 口径（沿用第一批）：
 *   **凡是能用规则算出来的，就不要让模型算。**
 *
 * 这一批只吃「工作项清单」里已经拿到的字段（`deadline` / `plan_started_at` /
 * `started_at` / `finished_at` / `created_at` / `milestone` / `state`），
 * 所以打开它们**不增加任何一次 API 调用**，也不增加模型上下文。
 *
 * 四个分析：
 *   E-07 进度偏差   计划开始 vs 实际开始、计划完成 vs 实际完成
 *   E-08 迭代容量   按截止周（或里程碑）分桶，计划投入 vs 每周容量
 *   E-09 里程碑达成 按 milestone 聚合，达成 / 逾期未达 / 有风险
 *   E-10 交付趋势   逐周「新增 vs 完成」，看净增与积压走向
 *
 * 阈值全部具名、可被环境变量覆盖，并随结果一起下发给界面——
 * 结论永远可以复算，口径不含糊。
 *
 * @module dsh-gitee-chat/scripts/analysis
 */

/** 视为「未完成」的状态。 */
const CLOSED_STATES = new Set(['closed', 'rejected'])

/** 阈值默认值（同时也是文档里的口径）。 */
export const THRESHOLD_DEFAULTS = {
  /** 停滞判定：进行中且超过这么多天没更新。 */
  stallDays: 14,
  /** 负载过载：未完成数下限。 */
  overloadOpen: 8,
  /** 负载过载：逾期数下限。 */
  overloadOverdue: 2,
  /** 规范要求的三维标签数（0 = 关闭该检查）。 */
  requiredLabels: 3,
  /** 每周交付容量（项）：用于「迭代容量」的超载判定。 */
  weeklyCapacity: 10,
  /** 交付趋势回看的周数。 */
  trendWeeks: 8,
  /** 里程碑「有风险」窗口：剩余天数小于它且尚有未完成项。 */
  milestoneRiskDays: 7,
}

/**
 * 从环境变量解析阈值（部署可调，不必改代码）。
 *
 * 支持的名字：`GITEE_CHAT_STALL_DAYS`、`GITEE_CHAT_OVERLOAD_OPEN`、
 * `GITEE_CHAT_OVERLOAD_OVERDUE`、`GITEE_CHAT_REQUIRED_LABELS`、
 * `GITEE_CHAT_WEEKLY_CAPACITY`、`GITEE_CHAT_TREND_WEEKS`、
 * `GITEE_CHAT_MILESTONE_RISK_DAYS`。
 *
 * @param {Record<string, string|undefined>} [env]
 */
export function resolveThresholds(env = process.env) {
  const positive = (key, fallback) => {
    const raw = env[key]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? value : fallback
  }
  // 标签数允许 0（= 关闭这项检查），所以单独解析
  const labelRaw = env.GITEE_CHAT_REQUIRED_LABELS
  const requiredLabels = labelRaw === undefined || labelRaw === ''
    ? THRESHOLD_DEFAULTS.requiredLabels
    : (Number.isInteger(Number(labelRaw)) && Number(labelRaw) >= 0
        ? Number(labelRaw)
        : THRESHOLD_DEFAULTS.requiredLabels)

  return {
    stallDays: positive('GITEE_CHAT_STALL_DAYS', THRESHOLD_DEFAULTS.stallDays),
    overloadOpen: positive('GITEE_CHAT_OVERLOAD_OPEN', THRESHOLD_DEFAULTS.overloadOpen),
    overloadOverdue: positive('GITEE_CHAT_OVERLOAD_OVERDUE', THRESHOLD_DEFAULTS.overloadOverdue),
    requiredLabels,
    weeklyCapacity: positive('GITEE_CHAT_WEEKLY_CAPACITY', THRESHOLD_DEFAULTS.weeklyCapacity),
    trendWeeks: positive('GITEE_CHAT_TREND_WEEKS', THRESHOLD_DEFAULTS.trendWeeks),
    milestoneRiskDays: positive('GITEE_CHAT_MILESTONE_RISK_DAYS', THRESHOLD_DEFAULTS.milestoneRiskDays),
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** 解析成毫秒；不可解析返回 null。 */
function ms(iso) {
  if (typeof iso !== 'string' || iso === '') return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/** 天数差（round）。任一不可解析返回 null。 */
function daysBetween(fromIso, toIso) {
  const a = ms(fromIso)
  const b = ms(toIso)
  if (a === null || b === null) return null
  return Math.round((b - a) / 86400000)
}

/** 日期 → `YYYY-MM-DD`。 */
function isoDay(t) {
  return new Date(t).toISOString().slice(0, 10)
}

/** 取该时间所在周的周一 00:00（UTC，够用且稳定）。 */
function weekStart(t) {
  const d = new Date(t)
  d.setUTCHours(0, 0, 0, 0)
  const dow = (d.getUTCDay() + 6) % 7 // 周一 = 0
  return d.getTime() - dow * 86400000
}

/** 是否未完成。 */
function isOpen(issue) {
  return !CLOSED_STATES.has(issue.state)
}

// ── E-07 进度偏差 ───────────────────────────────────────────────────────────

/**
 * 计划 vs 实际。
 *
 * 口径（三条，全部可解释）：
 *   - **开工偏差** = 实际开始 − 计划开始（正数 = 晚开工）
 *   - **完工偏差** = 实际完成 − 截止日期（正数 = 晚交付，仅已完成项有意义）
 *   - **剩余天数** = 截止日期 − 现在（负数 = 已逾期）
 *
 * 缺计划时间的工作项不会被算成「准时」，而是单独计入 `noPlan`——
 * 没有计划就无从谈偏差，这是规范问题，不是进度问题。
 *
 * @param {{ issues: any[], programs: any[], now: number }} input
 */
export function computeProgress(input) {
  const { issues, programs, now } = input
  const programName = new Map(programs.map((p) => [p.id, p.name]))

  const rows = []
  const byProgram = new Map()

  for (const it of issues) {
    const open = isOpen(it)
    const startDelayDays = daysBetween(it.planStartedAt, it.startedAt)
    const finishDelayDays = open ? null : daysBetween(it.deadline, it.finishedAt)
    const remainingDays = it.deadline === '' ? null : daysBetween(new Date(now).toISOString(), it.deadline)

    /** 计划完整性：有截止才算有计划。 */
    const hasPlan = it.deadline !== ''
    /** 开工是否迟到（需要两个时间都在）。 */
    const lateStart = startDelayDays !== null && startDelayDays > 0

    rows.push({
      ident: it.ident,
      title: it.title,
      owner: it.assignee,
      programId: it.programId,
      programName: programName.get(it.programId) ?? '',
      state: it.state,
      open,
      hasPlan,
      planStartedAt: it.planStartedAt,
      startedAt: it.startedAt,
      deadline: it.deadline,
      finishedAt: it.finishedAt,
      startDelayDays,
      finishDelayDays,
      remainingDays,
      lateStart,
    })

    const b = byProgram.get(it.programId) ?? {
      programId: it.programId,
      name: programName.get(it.programId) ?? '',
      measured: 0, lateStarts: 0, noPlan: 0, delaySum: 0,
      finishedLate: 0, finishedMeasured: 0, finishDelaySum: 0,
    }
    if (startDelayDays !== null) {
      b.measured++
      b.delaySum += startDelayDays
      if (lateStart) b.lateStarts++
    }
    if (!open && finishDelayDays !== null) {
      b.finishedMeasured++
      b.finishDelaySum += finishDelayDays
      if (finishDelayDays > 0) b.finishedLate++
    }
    if (!hasPlan && open) b.noPlan++
    byProgram.set(it.programId, b)
  }

  const projectRows = [...byProgram.values()]
    .map((b) => ({
      programId: b.programId,
      name: b.name,
      measured: b.measured,
      lateStarts: b.lateStarts,
      /** 平均开工偏差（天，正数=平均晚开工）；无样本时为 null。 */
      avgStartDelay: b.measured === 0 ? null : Math.round((b.delaySum / b.measured) * 10) / 10,
      /** 按期开工率（0-100）；无样本时为 null。 */
      onTimeStartRate: b.measured === 0 ? null : Math.round(((b.measured - b.lateStarts) / b.measured) * 100),
      finishedMeasured: b.finishedMeasured,
      finishedLate: b.finishedLate,
      avgFinishDelay: b.finishedMeasured === 0 ? null : Math.round((b.finishDelaySum / b.finishedMeasured) * 10) / 10,
      /** 未完成且完全没有截止日期（无计划）的项数。 */
      openWithoutPlan: b.noPlan,
    }))
    .sort((a, b) => (b.avgStartDelay ?? -999) - (a.avgStartDelay ?? -999))

  // 最需要关注的偏差：晚开工最多的未完成项
  const worst = rows
    .filter((r) => r.open && r.lateStart && r.remainingDays !== null)
    .sort((a, b) => (b.startDelayDays ?? 0) - (a.startDelayDays ?? 0))
    .slice(0, 20)

  const measuredAll = rows.filter((r) => r.startDelayDays !== null)
  const lateAll = measuredAll.filter((r) => r.lateStart)
  const finishedAll = rows.filter((r) => !r.open && r.finishDelayDays !== null)

  return {
    totals: {
      measured: measuredAll.length,
      lateStarts: lateAll.length,
      onTimeStartRate: measuredAll.length === 0
        ? null
        : Math.round(((measuredAll.length - lateAll.length) / measuredAll.length) * 100),
      avgStartDelay: measuredAll.length === 0
        ? null
        : Math.round((measuredAll.reduce((s, r) => s + (r.startDelayDays ?? 0), 0) / measuredAll.length) * 10) / 10,
      finishedMeasured: finishedAll.length,
      finishedLate: finishedAll.filter((r) => (r.finishDelayDays ?? 0) > 0).length,
      avgFinishDelay: finishedAll.length === 0
        ? null
        : Math.round((finishedAll.reduce((s, r) => s + (r.finishDelayDays ?? 0), 0) / finishedAll.length) * 10) / 10,
      openWithoutPlan: rows.filter((r) => r.open && !r.hasPlan).length,
    },
    projects: projectRows,
    worst,
  }
}

// ── E-09 里程碑达成 ─────────────────────────────────────────────────────────

/**
 * 按里程碑聚合（工作项清单里已带 `milestone`，无需额外调用）。
 *
 * 判定（规则化，不用模型猜）：
 *   - `achieved`  该里程碑下已无未完成项
 *   - `missed`    已过 due_date 但仍有未完成项
 *   - `at-risk`   未到 due_date，剩余天数 ≤ 阈值，且仍有未完成项
 *   - `on-track`  其余
 *
 * @param {{ issues: any[], programs: any[], now: number, thresholds: any }} input
 */
export function computeMilestones(input) {
  const { issues, programs, now, thresholds } = input
  const programName = new Map(programs.map((p) => [p.id, p.name]))
  const buckets = new Map()

  for (const it of issues) {
    const m = it.milestone
    if (m == null) continue
    const key = String(m.id ?? `${it.programId}:${m.title ?? ''}`)
    const b = buckets.get(key) ?? {
      id: Number(m.id ?? 0),
      title: String(m.title ?? '(未命名里程碑)'),
      state: String(m.state ?? ''),
      startDate: String(m.start_date ?? ''),
      dueDate: String(m.due_date ?? ''),
      programId: it.programId,
      programName: programName.get(it.programId) ?? '',
      total: 0, done: 0, open: 0, overdue: 0,
    }
    b.total++
    if (CLOSED_STATES.has(it.state)) b.done++
    else {
      b.open++
      if (it.deadline !== '' && Date.parse(it.deadline) < now) b.overdue++
    }
    buckets.set(key, b)
  }

  const rows = [...buckets.values()].map((b) => {
    const due = ms(b.dueDate)
    const daysLeft = due === null ? null : Math.round((due - now) / 86400000)
    let verdict = 'on-track'
    if (b.open === 0) verdict = 'achieved'
    else if (daysLeft !== null && daysLeft < 0) verdict = 'missed'
    else if (daysLeft !== null && daysLeft <= thresholds.milestoneRiskDays) verdict = 'at-risk'
    return {
      ...b,
      daysLeft,
      verdict,
      /** 达成率（0-100）。 */
      rate: b.total === 0 ? 0 : Math.round((b.done / b.total) * 100),
    }
  }).sort((a, b) => {
    // 先按风险排序：missed > at-risk > on-track > achieved
    const rank = { missed: 0, 'at-risk': 1, 'on-track': 2, achieved: 3 }
    const d = (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9)
    if (d !== 0) return d
    return (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999)
  })

  return {
    rows,
    totals: {
      count: rows.length,
      achieved: rows.filter((r) => r.verdict === 'achieved').length,
      missed: rows.filter((r) => r.verdict === 'missed').length,
      atRisk: rows.filter((r) => r.verdict === 'at-risk').length,
      /** 挂了里程碑的工作项数 / 全部工作项数 —— 衡量里程碑用得全不全。 */
      coveredIssues: issues.filter((it) => it.milestone != null).length,
      totalIssues: issues.length,
    },
  }
}

// ── E-08 迭代容量 ───────────────────────────────────────────────────────────

/**
 * 交付容量：把未完成项按「截止周」分桶，与本企业的每周容量比较。
 *
 * 为什么按周而不是按 Sprint：本企业（实测）没有启用 Scrum 迭代
 * （`/scrum_sprints` 返回 0 条），硬套 Sprint 只会得到一张空表。
 * 按截止周聚合等价地回答了同一个问题——**这段时间的活，排得下吗**。
 *
 * 工时口径：`estimated_duration` 全企业为空（实测 68/68 未填），
 * 所以容量以**项数**为准；有工时数据的项目会把工时一并给出，
 * 并在 `hoursTracked=false` 时明确提示「工时未登记」而不是显示 0。
 *
 * @param {{ issues: any[], programs: any[], now: number, thresholds: any }} input
 */
export function computeCapacity(input) {
  const { issues, programs, now, thresholds } = input
  const programName = new Map(programs.map((p) => [p.id, p.name]))

  const openIssues = issues.filter(isOpen)
  const estimatedMinutes = openIssues.reduce((s, it) => s + (it.estimatedMinutes ?? 0), 0)
  const registeredMinutes = openIssues.reduce((s, it) => s + (it.registeredMinutes ?? 0), 0)
  const hoursTracked = openIssues.some((it) => (it.estimatedMinutes ?? 0) > 0)

  const buckets = new Map()
  let noDeadline = 0

  for (const it of openIssues) {
    const due = ms(it.deadline)
    if (due === null) {
      noDeadline++
      continue
    }
    const start = weekStart(due)
    const b = buckets.get(start) ?? {
      weekStart: isoDay(start),
      weekEnd: isoDay(start + 6 * 86400000),
      planned: 0,
      overdue: 0,
      estimatedMinutes: 0,
      byProgram: {},
    }
    b.planned++
    if (due < now) b.overdue++
    b.estimatedMinutes += it.estimatedMinutes ?? 0
    b.byProgram[it.programId] = (b.byProgram[it.programId] ?? 0) + 1
    buckets.set(start, b)
  }

  const rows = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, b]) => {
      const weeksAgo = Math.round((weekStart(now) - start) / (7 * 86400000))
      return {
        ...b,
        weeksAgo,
        capacity: thresholds.weeklyCapacity,
        /** 超出该周容量的部分（负数=还有余量）。 */
        overflow: b.planned - thresholds.weeklyCapacity,
        overloaded: b.planned > thresholds.weeklyCapacity,
        /** 主要来自哪个项目（项数最多的那个）。 */
        topProgram: (() => {
          const top = Object.entries(b.byProgram).sort((x, y) => y[1] - x[1])[0]
          return top === undefined ? '' : `${programName.get(Number(top[0])) ?? top[0]}(${top[1]})`
        })(),
      }
    })

  const upcoming = rows.filter((r) => r.weeksAgo <= 0)
  const past = rows.filter((r) => r.weeksAgo > 0)

  return {
    weeklyCapacity: thresholds.weeklyCapacity,
    hoursTracked,
    estimatedHours: Math.round(estimatedMinutes / 60),
    registeredHours: Math.round(registeredMinutes / 60),
    noDeadline,
    rows,
    totals: {
      /** 未来（含本周）已排入的未完成项。 */
      plannedAhead: upcoming.reduce((s, r) => s + r.planned, 0),
      /** 未来周数。 */
      weeksAhead: upcoming.length,
      /** 未来每周平均排入。 */
      avgPerWeekAhead: upcoming.length === 0 ? 0 : Math.round((upcoming.reduce((s, r) => s + r.planned, 0) / upcoming.length) * 10) / 10,
      /** 超载周数（含已过去但当时就排不下的周）。 */
      overloadedWeeks: rows.filter((r) => r.overloaded).length,
      /** 已过截止但仍在这些周里的积压。 */
      carryOver: past.reduce((s, r) => s + r.overdue, 0),
    },
  }
}

// ── E-10 交付趋势 ───────────────────────────────────────────────────────────

/**
 * 逐周「新增 vs 完成」。
 *
 * 只用 `created_at` 与 `finished_at`——两个字段都在工作项清单里，
 * 所以这是一张零成本的交付节奏图。`net` 为正是净增（积压在涨）。
 *
 * @param {{ issues: any[], now: number, thresholds: any, scopePrograms?: number[] }} input
 */
export function computeDelivery(input) {
  const { issues, now, thresholds } = input
  const weeks = thresholds.trendWeeks
  const thisWeek = weekStart(now)

  const series = []
  for (let i = weeks - 1; i >= 0; i--) {
    const start = thisWeek - i * 7 * 86400000
    series.push({
      weekStart: isoDay(start),
      label: isoDay(start).slice(5),
      created: 0,
      finished: 0,
      net: 0,
      /** 该周末的累计未完成（用于看积压走向）。 */
      openEnd: 0,
    })
  }
  const indexOf = new Map(series.map((s, i) => [s.weekStart, i]))

  for (const it of issues) {
    const c = ms(it.createdAt)
    if (c !== null) {
      const idx = indexOf.get(isoDay(weekStart(c)))
      if (idx !== undefined) series[idx].created++
    }
    const f = ms(it.finishedAt)
    if (f !== null) {
      const idx = indexOf.get(isoDay(weekStart(f)))
      if (idx !== undefined) series[idx].finished++
    }
  }

  // 累计未完成：以「当周结束时已创建且未完成」为口径回算
  for (const s of series) {
    const weekEnd = Date.parse(`${s.weekStart}T23:59:59Z`) + 6 * 86400000
    s.openEnd = issues.filter((it) => {
      const c = ms(it.createdAt)
      if (c === null || c > weekEnd) return false
      const f = ms(it.finishedAt)
      return f === null || f > weekEnd
    }).length
    s.net = s.created - s.finished
  }

  const totalCreated = series.reduce((s, x) => s + x.created, 0)
  const totalFinished = series.reduce((s, x) => s + x.finished, 0)
  const half = Math.floor(series.length / 2)
  const firstHalf = series.slice(0, half).reduce((s, x) => s + x.finished, 0)
  const secondHalf = series.slice(half).reduce((s, x) => s + x.finished, 0)

  return {
    weeks,
    series,
    totals: {
      created: totalCreated,
      finished: totalFinished,
      net: totalCreated - totalFinished,
      /** 后段 vs 前段的完成量变化（百分比）：正数=在提速。 */
      velocityTrend: firstHalf === 0 ? null : Math.round(((secondHalf - firstHalf) / firstHalf) * 100),
      avgFinishedPerWeek: series.length === 0 ? 0 : Math.round((totalFinished / series.length) * 10) / 10,
    },
  }
}

// ── 描述模板解析（前置依赖）─────────────────────────────────────────────────

/**
 * 本企业工作项描述用的是固定形状的 Markdown 模板：
 *
 * ```md
 * ## 目标
 * Phoenix/JST 端子散件
 * ## 前置依赖
 * - 无
 * ## 交付物
 * - 采购订单
 * ```
 *
 * 所以「前置依赖」是**可解析的结构化字段**，不该让模型去猜。
 * 这里把 `## 标题` 切成段，并从「前置依赖」段里抽依赖引用。
 *
 * ⚠️ 引用有**两种写法**（实测都出现过，必须都认）：
 *   1. Gitee 工作项编号 —— `IK90004`
 *   2. **WBS 编码** —— `- HE-03 零件尺寸确定`、`- ME-02 结构布局确定`
 *
 * 第 2 种最容易被漏掉，而它恰恰是这家企业用得最多的写法。只认编号的实现
 * 会把「有 3 个前置项」显示成「写着没有前置依赖」——**比不显示更糟**。
 * WBS 编码要靠工作项标题里的 `【DEMO900-ME-02】…` 前缀反查（见 `codeOfTitle`）。
 *
 * @param {string} description - 工作项描述（Markdown）
 * @returns {{
 *   sections: {title:string, body:string, items:string[]}[],
 *   hasTemplate: boolean,
 *   dependencyRefs: {ref:string, kind:'ident'|'wbs', label:string}[],
 * }}
 */
export function parseTemplate(description) {
  const text = typeof description === 'string' ? description : ''
  const sections = []
  const lines = text.split(/\r?\n/)
  let current = null

  for (const line of lines) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (heading !== null) {
      current = { title: heading[1], body: '', items: [] }
      sections.push(current)
      continue
    }
    if (current === null) continue
    current.body += (current.body === '' ? '' : '\n') + line
  }

  for (const s of sections) {
    s.body = s.body.trim()
    s.items = s.body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .map((l) => l.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
      .filter((l) => l !== '')
  }

  /** 「无」的各种写法都算没有依赖。 */
  const NONE = /^(无|暂无|沒有|没有|none|n\/a|na|无。|-)$/i

  const depSection = sections.find((s) => /前置依赖|依赖项|前置条件|dependenc/i.test(s.title))
  const dependencyRefs = []

  /** 加一条引用（按 ref 去重）。 */
  const push = (ref, kind, label) => {
    const key = ref.toUpperCase()
    if (dependencyRefs.some((x) => x.ref === key)) return
    dependencyRefs.push({ ref: key, kind, label })
  }

  if (depSection !== undefined) {
    for (const item of depSection.items) {
      if (NONE.test(item)) continue
      // 逐轮在「已摘掉前面几轮命中的文本」上做匹配，避免重叠：
      // `DEMO900-ME-02` 里的 `DEMO900` 不能被当成一个 Gitee 编号再算一遍。
      let rest = item
      /** 本行新加的引用（用于把说明文字补给它们）。 */
      const addedHere = []

      /** 在一段文本上跑一个正则，命中即登记并从 rest 里摘掉。 */
      const scan = (re, kind) => {
        for (const m of rest.matchAll(re)) {
          const before = dependencyRefs.length
          push(m[0], kind, '')
          if (dependencyRefs.length > before) addedHere.push(dependencyRefs[dependencyRefs.length - 1])
        }
        rest = rest.replace(re, ' ')
      }

      // ① 链接形式 `?issue=XXXX` —— 最明确，先取（可能带小写，统一转大写）
      for (const m of rest.matchAll(/[?&]issue=([A-Za-z0-9]+)/g)) {
        const before = dependencyRefs.length
        push(m[1], 'ident', '')
        if (dependencyRefs.length > before) addedHere.push(dependencyRefs[dependencyRefs.length - 1])
      }
      rest = rest.replace(/[?&]issue=[A-Za-z0-9]+/g, ' ')

      // ② WBS 编码：`HE-03`、`DEMO900-ME-02`（至少一段连字符）
      //
      // ⚠️ 首段不能卡 `{1,5}` 这种上限：`DEMO900`（7 位）这类项目前缀匹配不上时，
      // 引擎会退到 `-` 之后从 `ME` 重新起头 —— 整条 `DEMO900-ME-02` 被拆成
      // `ME-02`（wbs）+ `DEMO900`（ident）两条重复引用，说明文字还留下残留的 `-`。
      // 首段放到 10 位；短名写法（描述写 `ME-02`、标题写全名）仍由 `codeMatches` 的后缀匹配兜住。
      scan(/\b[A-Z][A-Z0-9]{0,9}(?:-[A-Z0-9]{1,6}){1,3}\b/g, 'wbs')
      // ③ Gitee 工作项编号：大写字母开头、5-10 位字母数字（如 IK90004）
      scan(/\b[A-Z][A-Z0-9]{4,9}\b/g, 'ident')

      // 把剩下的说明文字补给本行新增的引用（反查不到时兜底显示）
      const note = rest
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[（）()【】\[\]，,。；;·:：]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
      for (const ref of addedHere) if (ref.label === '') ref.label = note
    }
  }

  return { sections, hasTemplate: sections.length > 0, dependencyRefs }
}

/**
 * 从工作项标题里取 WBS 编码。
 *
 * 本企业把编码写在标题开头：`【DEMO900-ME-02】设计结构适配`。
 * 这是把「描述里写的 HE-03」对应到「哪一个工作项」的唯一线索——
 * 描述里用短名（`ME-02`），标题里是全名（`DEMO900-ME-02`），
 * 所以匹配时按 `-` 分段做后缀匹配。
 *
 * @param {string} title
 * @returns {string} 编码（取不到返回空串）
 */
export function codeOfTitle(title) {
  const m = /^\s*[【\[（(]\s*([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){1,4})\s*[】\]）)]/.exec(String(title ?? ''))
  return m === null ? '' : m[1].toUpperCase()
}

/**
 * 一个引用是否指向某个编码（全名或短名都算）。
 * @param {string} code - 工作项标题里的编码（`DEMO900-ME-02`）
 * @param {string} ref - 描述里写的引用（`ME-02`）
 */
export function codeMatches(code, ref) {
  const a = String(code ?? '').toUpperCase()
  const b = String(ref ?? '').toUpperCase()
  if (a === '' || b === '') return false
  return a === b || a.endsWith(`-${b}`)
}

/**
 * 引用 → 工作项（编号 / WBS 编码两种写法都能反查）。
 *
 * @param {{ref:string, kind:string, label:string}[]} refs
 * @param {any[]} issues - 编号索引的全部工作项
 * @param {string} selfIdent - 本项编号（排除「指向自己」）
 */
export function resolveRefs(refs, issues, selfIdent) {
  const byIdent = new Map(issues.map((it) => [it.ident, it]))
  const byCode = new Map()
  for (const it of issues) {
    const code = codeOfTitle(it.title)
    if (code !== '' && !byCode.has(code)) byCode.set(code, it)
  }

  return refs.map(({ ref, kind, label }) => {
    let hit
    if (kind === 'ident') {
      hit = byIdent.get(ref)
    } else {
      hit = byCode.get(ref)
      if (hit === undefined) {
        // 短名反查全名：描述写 ME-02，标题是 DEMO900-ME-02
        for (const [code, issue] of byCode) {
          if (codeMatches(code, ref)) { hit = issue; break }
        }
      }
    }
    return {
      ref,
      kind,
      /** 描述里跟在引用后面的说明文字（反查不到时至少还能显示它）。 */
      label,
      ident: hit?.ident ?? '',
      title: hit?.title ?? '',
      state: hit?.state ?? '',
      owner: hit?.assignee ?? '',
      known: hit !== undefined,
      done: hit !== undefined && CLOSED_STATES.has(hit.state),
      self: hit !== undefined && hit.ident === selfIdent,
    }
  })
}

/**
 * 汇总全部固定分析。
 *
 * @param {{ programs: any[], issues: any[], now?: number, env?: Record<string,string|undefined> }} input
 */
export function computeExtendedAnalysis(input) {
  const now = input.now ?? Date.now()
  const thresholds = resolveThresholds(input.env ?? process.env)
  return {
    progress: computeProgress({ issues: input.issues, programs: input.programs, now }),
    capacity: computeCapacity({ issues: input.issues, programs: input.programs, now, thresholds }),
    milestones: computeMilestones({ issues: input.issues, programs: input.programs, now, thresholds }),
    delivery: computeDelivery({ issues: input.issues, now, thresholds }),
  }
}
