/**
 * 「概览」页（原型屏 1）：4 张 KPI + 工作项状态分布 + 风险摘要 + 归我处理 + PR 待办。
 *
 * 数据全部来自已有看板 payload（`fetchBoard`）与 PR 计数（`GET /pr/list` 的 counts），
 * **不额外取数**、不编造时间序列：原型里的「近 7 天活动」需要按天的历史聚合，
 * 0.5.4 的 payload 没有这个数据，这里换成「项目进度」（同一份 payload 能算出来的东西）。
 *
 * @module dsh-gitee-chat/client/OverviewTab
 */

import css from './pr.module.css'
import { BQ, Btn, Kpi, PCard, PCardBd, PCardHd, Tag } from './prUi.tsx'
import { GQ } from './tokens.ts'
import type { BoardPayload, PrCounts, RiskRow } from '../types.ts'

/** 环形图的一段。 */
interface Slice {
  label: string
  count: number
  color: string
}

/** 工作项状态 → 颜色（沿用原型的语义色：未开始蓝 / 进行中橙 / 已完成绿 / 关闭灰）。 */
const STATE_COLORS: Record<string, string> = {
  open: GQ.brand,
  progressing: GQ.warn,
  closed: GQ.ok,
  rejected: GQ.muted,
}

/** 状态中文名（看板脚本给的是英文 state）。 */
const STATE_LABELS: Record<string, string> = {
  open: '未开始',
  progressing: '进行中',
  closed: '已完成',
  rejected: '已关闭 / 驳回',
}

/** 风险级别 → 颜色。 */
function levelColor(level: RiskRow['level']): string {
  return level === 'high' ? GQ.danger : level === 'mid' ? GQ.warn : GQ.muted
}

/** 概览页。 */
export function OverviewTab(props: {
  payload: BoardPayload
  counts: PrCounts | null
  onGoProject: () => void
  onGoPr: () => void
  onGoAnalysis: () => void
}) {
  const payload = props.payload
  const kpi = payload.kpi
  const counts = props.counts
  const programCount = kpi.programs
  const issueCount = kpi.issues

  const slices: Slice[] = payload.distribution
    .filter((row) => row.count > 0)
    .map((row) => ({
      label: STATE_LABELS[row.state] ?? row.state,
      count: row.count,
      color: STATE_COLORS[row.state] ?? GQ.muted,
    }))

  // 「我」的风险项：按 payload.me 的名字过滤（没有 me 就整块降级成提示）。
  const myName = payload.me?.name ?? ''
  const myRisks = myName === ''
    ? []
    : payload.risks.filter((risk) => risk.owner.trim() !== '' && (risk.owner === myName || risk.owner.includes(myName)))

  const totals = payload.analysis?.totals
  const prPending = counts === null ? null : counts.review + counts.test

  return (
    <>
      {/* 4 张 KPI：原型里第 4 张是「知识库节点」，0.5.4 payload 没有节点计数，
          这里换成「逾期工作项」（同一份 payload 的真实字段），不编数。 */}
      <div className={css.gqPrGrid4}>
        <Kpi tone="info" icon="▤" title="项目" tag="组合" value={programCount}
          sub={`${payload.programs.filter((row) => row.overdue === 0).length} 个正常 · ${payload.programs.filter((row) => row.overdue > 0).length} 个有逾期`}
          barPercent={programCount === 0 ? 0 : 100} onClick={props.onGoProject} />
        <Kpi tone="warn" icon="☑" title="工作项" tag={kpi.overdue > 0 ? '需关注' : '正常'} value={issueCount}
          sub={`进行中 ${kpi.progressing} · 已完成 ${kpi.done} · 未认领 ${kpi.unassigned}`}
          barPercent={issueCount === 0 ? 0 : Math.round((kpi.done / issueCount) * 100)} onClick={props.onGoProject} />
        <Kpi tone="violet" icon="⑃" title="待我处理 PR" tag="我" value={prPending === null ? '—' : prPending}
          sub={counts === null ? '正在读取 PR 计数…' : `待审核 ${counts.review} · 待测试 ${counts.test} · 可合并 ${counts.mergeable}`}
          barPercent={prPending === null || prPending === 0 ? 0 : 100} onClick={props.onGoPr} />
        <Kpi tone="danger" icon="⏱" title="逾期工作项" tag={kpi.overdue > 0 ? '高风险' : '无逾期'} value={kpi.overdue}
          sub={totals === undefined ? '无人认领 ' + kpi.unassigned + ' 项' : `风险项 ${totals.overdue} · 停滞 ${totals.stalled} · 超载 ${totals.overloadedOwners}`}
          barPercent={issueCount === 0 ? 0 : Math.min(100, Math.round((kpi.overdue / issueCount) * 100))} onClick={props.onGoAnalysis} />
      </div>

      <div className={css.gqPrGrid2}>
        <PCard>
          <PCardHd title="工作项状态分布" sub={`共 ${issueCount} 项`} right="当前快照" />
          <PCardBd>
            {slices.length === 0
              ? <div className={css.gqPrRowSub}>这段时间没有工作项。</div>
              : (
                <div className={css.gqPrDonutRow}>
                  <Donut svgClass={css.gqPrDonutSvg} total={slices.reduce((sum, slice) => sum + slice.count, 0)} slices={slices} centerLabel="工作项" />
                  <div className={css.gqPrLegend}>
                    {slices.map((slice) => (
                      <div key={slice.label} className={css.gqPrLegendRow}>
                        <span className={css.gqPrDot} style={{ background: slice.color }} />
                        {slice.label}
                        <b>{slice.count}</b>
                        <span className={css.gqPrRowStat}>{Math.round((slice.count / Math.max(1, issueCount)) * 100)}%</span>
                      </div>
                    ))}
                    <div className={css.gqPrRowSub} style={{ marginTop: 6 }}>
                      逾期 {kpi.overdue} 项 · 无人认领 {kpi.unassigned} 项。
                    </div>
                  </div>
                </div>
              )}
          </PCardBd>
        </PCard>

        <PCard>
          <PCardHd title="项目进度" sub="按完成率排序（payload 里的实时聚合）" right={<Btn size="sm" onClick={props.onGoProject}>看全部项目</Btn>} />
          <PCardBd>
            {payload.programs.length === 0
              ? <div className={css.gqPrRowSub}>没有可见项目。</div>
              : [...payload.programs]
                .sort((left, right) => right.progress - left.progress)
                .slice(0, 5)
                .map((program) => (
                  <div key={program.id} className={css.gqPrProgRow}>
                    <div className={css.gqPrProgTop}>
                      {program.name}
                      <span>完成 {program.done}/{program.total} · 逾期 {program.overdue}</span>
                    </div>
                    <div className={css.gqPrProgBar}>
                      <i className={css.gqPrProgBarFill} style={{ width: `${Math.max(0, Math.min(100, program.progress))}%`, background: program.overdue > 0 ? GQ.warn : GQ.ok }} />
                    </div>
                  </div>
                ))}
          </PCardBd>
        </PCard>
      </div>

      <div className={css.gqPrGrid2}>
        <PCard>
          <PCardHd
            title="归我处理的风险"
            sub={myName === '' ? '宿主没给「我」是谁' : `owner 含「${myName}」的风险项`}
            right={<Tag tone={myRisks.length === 0 ? 'ok' : 'warn'}>{myRisks.length} 项</Tag>}
          />
          <PCardBd>
            {myName === ''
              ? <BQ tone="muted">payload 里没有 `me` 字段，无法判断「我」是谁。可以在会话里让模型用 gq 工具确认当前 token 的身份。</BQ>
              : myRisks.length === 0
                ? <div className={css.gqPrRowSub}>没有归你处理的风险项（逾期 / 高优先级未完成 / 无人认领都会出现在这里）。</div>
                : myRisks.slice(0, 6).map((risk) => (
                  <div key={`${risk.kind}-${risk.ident}`} className={css.gqPrProgRow}>
                    <div className={css.gqPrProgTop}>
                      <span className={css.gqPrTplName}>{risk.ident}</span>
                      <span style={{ color: levelColor(risk.level) }}>{risk.kind === 'overdue' ? '逾期' : risk.kind === 'urgent' ? '高优未完成' : '无人认领'}</span>
                      {risk.title}
                    </div>
                    <div className={css.gqPrRowSub}>{risk.detail}</div>
                  </div>
                ))}
            {myRisks.length > 6 ? <div className={css.gqPrRowSub}>还有 {myRisks.length - 6} 项，去「分析」页看完整的风险清单。</div> : null}
          </PCardBd>
        </PCard>

        <PCard>
          <PCardHd title="PR 待办" sub="口径与「合并请求」页一致（宿主 counts）" right={<Btn size="sm" onClick={props.onGoPr}>去合并请求</Btn>} />
          <PCardBd>
            {counts === null
              ? <div className={css.gqPrRowSub}>正在读取 PR 计数…</div>
              : (
                <>
                  <KvRow label="待我审核" value={counts.review} hint="打开 + 待审查 + 我是审查人" color={GQ.warn} />
                  <KvRow label="待我测试" value={counts.test} hint="打开 + 待测试 + 我是测试人" color={GQ.violet} />
                  <KvRow label="我提出的" value={counts.mine} hint="我创建且仍在打开" color={GQ.brand} />
                  <KvRow label="可合并" value={counts.mergeable} hint="有合并权限 + 审查与测试均通过" color={GQ.ok} />
                  <div className={css.gqPrRowSub} style={{ marginTop: 8 }}>
                    PR 数据实时走 Gitee，点卡片或页签进入可筛选与直接处理。
                  </div>
                </>
              )}
          </PCardBd>
        </PCard>
      </div>

      <PCard>
        <PCardHd title="数据新鲜度" sub={`生成于 ${payload.generatedAt} · 来源 ${payload.source === 'live' ? '实时' : '样例数据'}`} />
        <PCardBd>
          <div className={css.gqPrRowSub}>
            {payload.truncated === true ? '注意：工作项超过翻页上限被截断，所有统计只覆盖已取到的部分。' : '本次统计覆盖全部已取到的工作项。'}
            {' '}企业：{payload.enterprise.name}（{payload.enterprise.id}）；我：{payload.me?.name ?? '未知'}。
          </div>
        </PCardBd>
      </PCard>
    </>
  )
}

/** 一条「标签 — 数字」行。 */
function KvRow(props: { label: string; value: number; hint: string; color: string }) {
  return (
    <div className={css.gqPrProgRow}>
      <div className={css.gqPrProgTop}>
        {props.label}
        <span style={{ color: props.color, fontSize: 15, fontWeight: 650 }}>{props.value}</span>
      </div>
      <div className={css.gqPrRowSub}>{props.hint}</div>
    </div>
  )
}

/** 环形图（内联 SVG，零依赖；几何照原型 150×150 / r58 / stroke 18）。 */
function Donut(props: { svgClass: string; total: number; slices: readonly Slice[]; centerLabel: string }) {
  const radius = 58
  const stroke = 18
  const circumference = 2 * Math.PI * radius
  const total = Math.max(1, props.total)
  let offset = 0
  const rings = props.slices.map((slice) => {
    const length = (slice.count / total) * circumference
    const ring = (
      <circle
        key={slice.label}
        r={radius}
        fill="none"
        stroke={slice.color}
        strokeWidth={stroke}
        strokeDasharray={`${length} ${Math.max(0, circumference - length)}`}
        strokeDashoffset={-offset}
      />
    )
    offset += length
    return ring
  })
  return (
    <svg className={props.svgClass} width={150} height={150} viewBox="0 0 150 150" role="img" aria-label="工作项状态分布">
      <g transform="translate(75,75) rotate(-90)">
        <circle r={radius} fill="none" stroke={GQ.surface2} strokeWidth={stroke} />
        {rings}
      </g>
      <text x={75} y={77} textAnchor="middle" fontSize={26} fontWeight={700} fill={GQ.text}>{props.total}</text>
      <text x={75} y={97} textAnchor="middle" fontSize={11} fill={GQ.text3}>{props.centerLabel}</text>
    </svg>
  )
}
