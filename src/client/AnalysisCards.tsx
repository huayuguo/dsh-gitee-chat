/**
 * 固定分析卡片（E-01 ~ E-10）。
 *
 * **这一层不做任何计算**：每一个数字都来自 gq 脚本的 `analysis` 字段。
 * 组件只负责把它排成能看懂的样子。判断口径写在每张卡片的脚注里，
 * 阈值随数据下发，所以结论永远可以复算。
 *
 * @module dsh-gitee-chat/client/AnalysisCards
 */

import { createElement as h, type ReactNode } from 'react'
import css from './board.module.css'
import { Bar, Card, CardTitle, Dot, Empty, List, Note, Pill, Row, Stat, StatGrid, Table, day, levelColor } from './ui.tsx'
import type {
  BoardAnalysis,
  CapacityAnalysis,
  DeliveryAnalysis,
  MilestoneAnalysis,
  ProgressAnalysis,
} from '../types.ts'

/** 带颜色的数字。 */
function Tone(props: { tone?: 'warn' | 'err' | 'ok' | 'dim'; children?: ReactNode }) {
  const cls = props.tone === 'warn' ? css.gqVWarn
    : props.tone === 'err' ? css.gqVErr
      : props.tone === 'ok' ? css.gqVOk
        : props.tone === 'dim' ? css.gqVDim : ''
  return h('span', { className: cls }, props.children)
}

// ── ① 项目健康度 ────────────────────────────────────────────────────────────

function HealthCard({ analysis }: { analysis: BoardAnalysis }) {
  const rows = analysis.health
  return h(Card, { grow: true },
    h(CardTitle, { title: '① 项目健康度', note: '低分在前', right: h(Pill, null, `${rows.length} 个项目`) }),
    rows.length === 0 ? h(Empty, null, '没有项目') : h(List, null, rows.map((r) =>
      h('div', { key: r.programId, className: css.gqVRow, style: { gridTemplateColumns: 'minmax(0,1fr) auto' } },
        h('div', { style: { minWidth: 0 } },
          h('div', { className: css.gqVRowName, title: r.name }, r.name),
          h(Bar, { percent: r.score, color: levelColor(r.level), title: `${r.score} 分` }),
          h('div', { className: css.gqVRowKey, style: { marginTop: 3, whiteSpace: 'normal' } },
            `未完成 ${r.open} · 逾期 ${r.overdue} · 无人认领 ${r.unassigned} · 停滞 ${r.stalled} · 完成率 ${r.completionRate}%`),
        ),
        h('div', { className: css.gqVStatValue, style: { color: levelColor(r.level) } }, String(r.score)),
      ),
    )),
    h(Note, null, `口径：100 − (55×逾期率 + 20×无人认领率 + 25×停滞率)，未完成 ${analysis.totals.open} 项。≥80 绿 / ≥60 黄 / 其余红。`),
  )
}

// ── ② 成员负载 ──────────────────────────────────────────────────────────────

function WorkloadCard({ analysis }: { analysis: BoardAnalysis }) {
  const rows = analysis.workload
  return h(Card, { grow: true },
    h(CardTitle, {
      title: '② 成员负载',
      note: '逾期多者在前',
      right: h(Pill, { tone: analysis.totals.overloadedOwners > 0 ? 'err' : undefined }, `${analysis.totals.overloadedOwners} 人过载`),
    }),
    rows.length === 0 ? h(Empty, null, '没有未完成的工作项') : h(List, null, rows.map((w) =>
      h(Row, {
        key: w.name,
        color: levelColor(w.level),
        name: w.name === '(未指派)' ? '未指派' : w.name,
        title: `${w.name}：未完成 ${w.open} · 进行中 ${w.progressing} · 逾期 ${w.overdue} · 高优 ${w.highPriority}`,
        value: h('span', null,
          `未完成 ${w.open} · 高优 ${w.highPriority} `,
          w.overdue > 0 ? h(Tone, { tone: 'err' }, `· 逾期 ${w.overdue}`) : null,
        ),
      }),
    )),
    h(Note, null, `口径：未完成 ≥${analysis.thresholds.overloadOpen} 且逾期 ≥${analysis.thresholds.overloadOverdue} → 过载；仅逾期 ≥${analysis.thresholds.overloadOverdue} → 有风险。`),
  )
}

// ── ③ 延期清单 ──────────────────────────────────────────────────────────────

function SlipCard({ analysis }: { analysis: BoardAnalysis }) {
  const rows = analysis.slips
  return h(Card, { grow: true },
    h(CardTitle, { title: '③ 延期清单', note: '按逾期天数倒序', right: h(Pill, { tone: rows.length > 0 ? 'err' : 'ok' }, `${rows.length} 项`) }),
    rows.length === 0 ? h(Empty, null, '没有逾期的工作项') : h(List, null, rows.slice(0, 30).map((x) =>
      h(Row, {
        key: x.ident,
        color: 'var(--dsw-alias-state-error-primary)',
        keyText: x.ident,
        name: x.title,
        title: `${x.ident} ${x.title} · ${x.programName} · ${x.owner || '未指派'}`,
        value: h(Tone, { tone: 'err' }, `+${x.overdueDays}d`),
      }),
    )),
    h(Note, null, '口径：未完成且截止日期早于现在。'),
  )
}

// ── ④ 停滞 ──────────────────────────────────────────────────────────────────

function StalledCard({ analysis }: { analysis: BoardAnalysis }) {
  const rows = analysis.stalled
  return h(Card, { grow: true },
    h(CardTitle, {
      title: `④ 停滞 >${analysis.thresholds.stallDays} 天`,
      note: '进行中但长时间未更新',
      right: h(Pill, { tone: rows.length > 0 ? 'warn' : 'ok' }, `${rows.length} 项`),
    }),
    rows.length === 0 ? h(Empty, null, '没有停滞的工作项') : h(List, null, rows.map((x) =>
      h(Row, {
        key: x.ident,
        color: 'var(--dsw-alias-state-warn-primary)',
        keyText: x.ident,
        name: x.title,
        title: `${x.ident} ${x.title} · ${x.owner || '未指派'}`,
        value: `${x.idleDays}d 未动`,
      }),
    )),
    h(Note, null, `口径：状态是「进行中」（不算待办的久未动）且 ${analysis.thresholds.stallDays} 天没有更新。`),
  )
}

// ── ⑤ 规范体检 ──────────────────────────────────────────────────────────────

function ComplianceCard({ analysis }: { analysis: BoardAnalysis }) {
  const rows = analysis.compliance
  const L = analysis.thresholds.requiredLabels
  const head = ['编号', '标题', '负责人', '问题']
  return h(Card, { grow: true },
    h(CardTitle, {
      title: '⑤ 规范体检',
      note: '负责人 / 截止 / 计划开始 / 标签 / 类型',
      right: h(Pill, { tone: rows.length > 0 ? 'warn' : 'ok' }, `${analysis.totals.nonCompliant} 项不合规`),
    }),
    rows.length === 0 ? h(Empty, null, '未完成项全部合规') : h('div', { style: { maxHeight: 320, overflowY: 'auto' } },
      h(Table, { head },
        rows.map((x) => h('tr', { key: x.ident },
          h('td', { className: `${css.gqVNum} ${css.gqVDim}` }, x.ident),
          h('td', { title: `${x.title} · ${x.programName}` }, x.title),
          h('td', { className: css.gqVDim }, x.owner || '未指派'),
          h('td', null, ...x.problems.map((p, i) => h('span', { key: p + i, style: { marginRight: 4 } }, h(Pill, { tone: 'warn' }, p)))),
        )),
      ),
    ),
    h(Note, null, L > 0
      ? `口径：未完成项缺负责人/截止/计划开始/类型，或标签数 ≠ ${L}（本团队的「职能域 × 优先级 × 阶段」约定）。`
      : '口径：未完成项缺负责人/截止/计划开始/类型。标签数检查已被阈值设为 0 关闭。'),
  )
}

// ── ⑥ 进度偏差（E-07）────────────────────────────────────────────────────────

function ProgressCard({ progress }: { progress: ProgressAnalysis }) {
  const t = progress.totals
  return h(Card, { grow: true },
    h(CardTitle, {
      title: '⑥ 进度偏差',
      note: '计划 vs 实际',
      right: h(Pill, { tone: t.onTimeStartRate !== null && t.onTimeStartRate < 60 ? 'warn' : 'ok' },
        t.onTimeStartRate === null ? '无样本' : `按期开工 ${t.onTimeStartRate}%`),
    }),
    h(StatGrid, null,
      h(Stat, { label: '有开工记录', value: t.measured }),
      h(Stat, { label: '晚开工', value: t.lateStarts, tone: t.lateStarts > 0 ? 'warn' : undefined }),
      h(Stat, { label: '平均开工偏差', value: t.avgStartDelay === null ? '—' : `${t.avgStartDelay}d` }),
      h(Stat, { label: '已完成项', value: t.finishedMeasured }),
      h(Stat, { label: '平均交付偏差', value: t.avgFinishDelay === null ? '—' : `${t.avgFinishDelay}d`, tone: (t.avgFinishDelay ?? 0) > 0 ? 'err' : 'ok' }),
      h(Stat, { label: '未完成且无截止', value: t.openWithoutPlan, tone: t.openWithoutPlan > 0 ? 'warn' : undefined }),
    ),
    h('div', { style: { height: 10 } }),
    progress.projects.length === 0 ? h(Empty, null, '没有可比较的项目') : h('div', { style: { maxHeight: 240, overflowY: 'auto' } },
      h(Table, { head: ['项目', '按期开工率', '平均开工偏差', '平均交付偏差', '无截止'] },
        progress.projects.map((p) => h('tr', { key: p.programId },
          h('td', { title: p.name }, p.name),
          h('td', { className: css.gqVNum },
            p.onTimeStartRate === null ? h(Tone, { tone: 'dim' }, '—')
              : h(Tone, { tone: p.onTimeStartRate < 60 ? 'warn' : 'ok' }, `${p.onTimeStartRate}%`)),
          h('td', { className: css.gqVNum }, p.avgStartDelay === null ? '—' : `${p.avgStartDelay}d`),
          h('td', { className: css.gqVNum }, p.avgFinishDelay === null ? '—' : `${p.avgFinishDelay}d`),
          h('td', { className: css.gqVNum }, p.openWithoutPlan > 0 ? h(Tone, { tone: 'warn' }, String(p.openWithoutPlan)) : '0'),
        )),
      ),
    ),
    progress.worst.length > 0 ? h('div', { style: { marginTop: 8 } },
      h('div', { className: css.gqVFieldLabel, style: { marginBottom: 4 } }, '晚开工最多且仍未完成'),
      h(List, { scroll: false }, progress.worst.slice(0, 8).map((r) =>
        h(Row, {
          key: r.ident,
          color: 'var(--dsw-alias-state-warn-primary)',
          keyText: r.ident,
          name: r.title,
          title: `${r.ident} ${r.title} · ${r.programName} · ${r.owner || '未指派'}`,
          value: `晚 ${r.startDelayDays}d · 剩余 ${r.remainingDays}d`,
        }),
      )),
    ) : null,
    h(Note, null, '口径：开工偏差 = 实际开始 − 计划开始（正数=晚开工）；交付偏差 = 实际完成 − 截止日期（正数=晚交付）。缺计划时间的项不计入比率，单独统计为「无截止」。'),
  )
}

// ── ⑦ 迭代容量（E-08）───────────────────────────────────────────────────────

function CapacityCard({ capacity }: { capacity: CapacityAnalysis }) {
  const t = capacity.totals
  return h(Card, { grow: true },
    h(CardTitle, {
      title: '⑦ 交付容量',
      note: `按截止周 · 每周容量 ${capacity.weeklyCapacity} 项`,
      right: h(Pill, { tone: t.overloadedWeeks > 0 ? 'err' : 'ok' }, `超载 ${t.overloadedWeeks} 周`),
    }),
    h(StatGrid, null,
      h(Stat, { label: '未来周数', value: t.weeksAhead }),
      h(Stat, { label: '已排入', value: t.plannedAhead }),
      h(Stat, { label: '周均', value: t.avgPerWeekAhead, tone: t.avgPerWeekAhead > capacity.weeklyCapacity ? 'err' : undefined }),
      h(Stat, { label: '逾期积压', value: t.carryOver, tone: t.carryOver > 0 ? 'err' : undefined }),
      h(Stat, { label: '无截止', value: capacity.noDeadline, tone: capacity.noDeadline > 0 ? 'warn' : undefined }),
      h(Stat, { label: '工时口径', value: capacity.hoursTracked ? '可用' : '未登记', tone: capacity.hoursTracked ? 'ok' : 'warn' }),
    ),
    capacity.rows.length === 0 ? h(Empty, null, '没有带截止日期的未完成项') : h('div', { style: { marginTop: 8, maxHeight: 260, overflowY: 'auto' } },
      h(Table, { head: ['周', '计划', '逾期', '超载', '主要项目'] },
        capacity.rows.map((r) => h('tr', { key: r.weekStart },
          h('td', { className: css.gqVNum }, `${r.weekStart.slice(5)} ~ ${r.weekEnd.slice(5)}`,
            r.weeksAgo === 0 ? h('span', { className: css.gqVDim }, ' (本周)') : null,
            r.weeksAgo < 0 ? h('span', { className: css.gqVDim }, ` (${-r.weeksAgo}周前)`) : null),
          h('td', { className: css.gqVNum }, String(r.planned)),
          h('td', { className: css.gqVNum }, r.overdue > 0 ? h(Tone, { tone: 'err' }, String(r.overdue)) : '0'),
          h('td', { className: css.gqVNum }, r.overloaded
            ? h(Tone, { tone: 'err' }, `+${r.overflow}`)
            : h(Tone, { tone: 'dim' }, String(r.overflow))),
          h('td', { className: css.gqVDim, title: r.topProgram }, r.topProgram || '—'),
        )),
      ),
    ),
    h(Note, null,
      '口径：未完成项按**截止日期所在周**分桶，与该周容量比较。'
      + (capacity.hoursTracked
        ? `工时：预估 ${capacity.estimatedHours}h / 已登记 ${capacity.registeredHours}h。`
        : '本企业工作项未登记预估工时，因此容量只能按项数衡量——这本身是一条规范问题。')),
  )
}

// ── ⑧ 里程碑达成（E-09）─────────────────────────────────────────────────────

const VERDICT: Record<string, { label: string; tone: 'ok' | 'warn' | 'err' | undefined }> = {
  achieved: { label: '已达成', tone: 'ok' },
  'on-track': { label: '正常', tone: undefined },
  'at-risk': { label: '有风险', tone: 'warn' },
  missed: { label: '已逾期未达', tone: 'err' },
}

function MilestoneCard({ milestones }: { milestones: MilestoneAnalysis }) {
  const t = milestones.totals
  return h(Card, { grow: true },
    h(CardTitle, {
      title: '⑧ 里程碑达成',
      note: `覆盖 ${t.coveredIssues}/${t.totalIssues} 个工作项`,
      right: h(Pill, { tone: t.missed > 0 ? 'err' : t.atRisk > 0 ? 'warn' : 'ok' }, `${t.count} 个里程碑`),
    }),
    h(StatGrid, null,
      h(Stat, { label: '已达成', value: t.achieved, tone: 'ok' }),
      h(Stat, { label: '逾期未达', value: t.missed, tone: t.missed > 0 ? 'err' : undefined }),
      h(Stat, { label: '有风险', value: t.atRisk, tone: t.atRisk > 0 ? 'warn' : undefined }),
    ),
    milestones.rows.length === 0 ? h(Empty, null, '没有工作项挂在里程碑上') : h('div', { style: { marginTop: 8, maxHeight: 280, overflowY: 'auto' } },
      h(Table, { head: ['里程碑', '项目', '截止', '剩余', '进度', '判定'] },
        milestones.rows.map((r) => h('tr', { key: `${r.programId}-${r.id}` },
          h('td', { title: r.title }, r.title),
          h('td', { className: css.gqVDim, title: r.programName }, r.programName),
          h('td', { className: css.gqVNum }, day(r.dueDate)),
          h('td', { className: css.gqVNum }, r.daysLeft === null ? '—'
            : h(Tone, { tone: r.daysLeft < 0 ? 'err' : r.daysLeft <= 7 ? 'warn' : undefined }, `${r.daysLeft}d`)),
          h('td', { className: css.gqVNum }, `${r.done}/${r.total} (${r.rate}%)`),
          h('td', null, h(Pill, { tone: VERDICT[r.verdict]?.tone }, VERDICT[r.verdict]?.label ?? r.verdict)),
        )),
      ),
    ),
    h(Note, null, '口径：该里程碑下已无未完成项 → 已达成；过了截止仍有未完成 → 逾期未达；剩余天数 ≤ 阈值且仍有未完成 → 有风险。'),
  )
}

// ── ⑨ 交付趋势（E-10）───────────────────────────────────────────────────────

function DeliveryCard({ delivery }: { delivery: DeliveryAnalysis }) {
  const t = delivery.totals
  const max = Math.max(1, ...delivery.series.map((s) => Math.max(s.created, s.finished)))
  return h(Card, { grow: true },
    h(CardTitle, {
      title: '⑨ 交付趋势',
      note: `近 ${delivery.weeks} 周`,
      right: h(Pill, { tone: t.net > 0 ? 'warn' : 'ok' }, `净增 ${t.net >= 0 ? '+' : ''}${t.net}`),
    }),
    h(StatGrid, null,
      h(Stat, { label: '新增', value: t.created }),
      h(Stat, { label: '完成', value: t.finished, tone: 'ok' }),
      h(Stat, { label: '周均完成', value: t.avgFinishedPerWeek }),
      h(Stat, {
        label: '后段 vs 前段',
        value: t.velocityTrend === null ? '—' : `${t.velocityTrend >= 0 ? '+' : ''}${t.velocityTrend}%`,
        tone: t.velocityTrend === null ? undefined : t.velocityTrend >= 0 ? 'ok' : 'warn',
      }),
    ),
    h('div', { style: { marginTop: 10 } },
      h('div', { className: css.gqVSpark },
        delivery.series.map((s) => h('div', {
          key: s.weekStart,
          className: css.gqVSparkCol,
          title: `${s.label}：新增 ${s.created} · 完成 ${s.finished} · 周末积压 ${s.openEnd}`,
        },
          h('div', { className: css.gqVSparkBars },
            h('div', {
              className: css.gqVSparkBar,
              style: { height: `${Math.max(2, Math.round((s.created / max) * 44))}px`, background: 'var(--dsw-alias-state-warn-primary)' },
            }),
            h('div', {
              className: css.gqVSparkBar,
              style: { height: `${Math.max(2, Math.round((s.finished / max) * 44))}px`, background: 'var(--dsw-alias-state-success-primary)' },
            }),
          ),
          h('div', { className: css.gqVSparkLabel }, s.label),
        )),
      ),
      h('div', { className: css.gqVLegend, style: { marginTop: 6 } },
        h('span', { className: css.gqVLegendItem }, h(Dot, { color: 'var(--dsw-alias-state-warn-primary)' }), '每周新增'),
        h('span', { className: css.gqVLegendItem }, h(Dot, { color: 'var(--dsw-alias-state-success-primary)' }), '每周完成'),
      ),
    ),
    h(Note, null, '口径：按工作项的创建时间与完成时间分别落到所在周。净增为正 = 积压在涨；「后段 vs 前段」比较后一半周与前一半周的完成量。'),
  )
}

/**
 * 固定分析全部分组。
 * @param props.analysis - 脚本算好的分析结果。
 * @param props.managementEnabled - 项目管理与分析是否开启（执行档只看本人视角）。
 */
export function AnalysisCards(props: { analysis: BoardAnalysis; managementEnabled: boolean }) {
  const a = props.analysis
  const left = [
    h(HealthCard, { key: 'health', analysis: a }),
    h(SlipCard, { key: 'slip', analysis: a }),
    h(ComplianceCard, { key: 'compliance', analysis: a }),
    a.progress === undefined ? null : h(ProgressCard, { key: 'progress', progress: a.progress }),
    a.milestones === undefined ? null : h(MilestoneCard, { key: 'milestone', milestones: a.milestones }),
  ].filter((x) => x !== null)
  const right = [
    h(WorkloadCard, { key: 'workload', analysis: a }),
    h(StalledCard, { key: 'stalled', analysis: a }),
    a.capacity === undefined ? null : h(CapacityCard, { key: 'capacity', capacity: a.capacity }),
    a.delivery === undefined ? null : h(DeliveryCard, { key: 'delivery', delivery: a.delivery }),
  ].filter((x) => x !== null)

  return h('div', null,
    h('div', { className: css.gqVCols },
      h('div', { className: css.gqVCol }, left),
      h('div', { className: css.gqVCol }, right),
    ),
    h(Note, null,
      '以上全部由 gq 脚本计算（同一输入永远得到同一输出），未经模型推断。'
      + '阈值：停滞 ' + a.thresholds.stallDays + ' 天 · 过载 ≥' + a.thresholds.overloadOpen + ' 未完成且 ≥'
      + a.thresholds.overloadOverdue + ' 逾期 · 每周容量 ' + a.thresholds.weeklyCapacity + ' 项'
      + (a.thresholds.requiredLabels > 0 ? ` · 标签 ${a.thresholds.requiredLabels} 个` : '')
      + '。需要判断力的部分（WBS 合理性、风险根因、复盘）才交给模型，且必须基于这些事实。'
      + (props.managementEnabled ? '' : '（当前人格未开启项目管理与分析，本页仅供查看。）'),
    ),
  )
}
