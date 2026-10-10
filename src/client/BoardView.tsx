/**
 * 看板视图（纯展示层）。
 *
 * 与 `BoardCard` 分开的理由：取数是有状态、依赖网络的，展示是纯函数。
 * 拆开后展示层可以被确定性渲染测试覆盖（见 scripts/render-check.mjs），
 * 于是「卡片长什么样」不再是只能在浏览器里肉眼确认的东西。
 *
 * @module dsh-gitee-chat/client/BoardView
 */

import { createElement as h } from 'react'
import css from './board.module.css'
import { OverdueBars, ProgressBar, StateStack } from './charts.tsx'
import type { BoardPayload } from '../types.ts'

/** KPI 一格。 */
function Kpi(props: { label: string; value: number | string; tone?: 'err' | 'warn' }) {
  const cls = props.tone === 'err'
    ? `${css.gqKpiValue} ${css.gqKpiValueErr}`
    : props.tone === 'warn'
      ? `${css.gqKpiValue} ${css.gqKpiValueWarn}`
      : css.gqKpiValue
  return h('div', { className: css.gqKpi },
    h('div', { className: cls }, String(props.value)),
    h('div', { className: css.gqKpiLabel }, props.label),
  )
}

/** 视图入参。 */
export interface BoardViewProps {
  payload: BoardPayload
  /** 本次是否命中宿主缓存。 */
  cached?: boolean
  /** 是否样例数据。 */
  degraded?: boolean
  /** 点「刷新」时回调（不传则不显示按钮的交互效果）。 */
  onRefresh?: () => void
  /** 风险最多展示几条。 */
  maxRisks?: number
}

/**
 * 渲染看板全貌：KPI → 状态分布 → 项目柱状 → 项目健康度 → 风险清单 → 页脚。
 * @param props - payload 与交互回调。
 */
export function BoardView(props: BoardViewProps) {
  const { payload } = props
  const { kpi, programs, risks, distribution, enterprise, generatedAt, scope } = payload
  const maxRisks = props.maxRisks ?? 10
  const degraded = props.degraded === true || payload.source === 'fixture'

  const head = h('div', { className: css.gqHead },
    h('div', { className: css.gqTitle },
      '📊 Gitee 项目看板',
      h('span', { className: css.gqBadge }, scope === 'mywork' ? '我的' : '企业全景'),
      degraded ? h('span', { className: `${css.gqBadge} ${css.gqBadgeWarn}` }, '样例数据') : null,
      kpi.overdue > 0 ? h('span', { className: `${css.gqBadge} ${css.gqBadgeErr}` }, `逾期 ${kpi.overdue}`) : null,
    ),
    h('div', { className: css.gqMeta },
      enterprise.name || `企业 ${enterprise.id}`,
      h('br'),
      `${generatedAt}${props.cached === true ? ' · 缓存' : ''}`,
    ),
  )

  const kpis = h('div', { className: css.gqKpis },
    h(Kpi, { label: '项目', value: kpi.programs }),
    h(Kpi, { label: '工作项', value: kpi.issues }),
    h(Kpi, { label: '进行中', value: kpi.progressing }),
    h(Kpi, { label: '已完成', value: kpi.done }),
    h(Kpi, { label: '逾期', value: kpi.overdue, tone: kpi.overdue > 0 ? 'err' : undefined }),
    h(Kpi, { label: '无人认领', value: kpi.unassigned, tone: kpi.unassigned > 0 ? 'warn' : undefined }),
  )

  const distSection = h('div', { className: css.gqSection },
    h('div', { className: css.gqSectionTitle }, '工作项状态分布'),
    h(StateStack, { rows: distribution }),
  )

  const barSection = programs.length > 0
    ? h('div', { className: css.gqSection },
        h('div', { className: css.gqSectionTitle }, '各项目工作项总量 / 逾期'),
        h(OverdueBars, { items: programs.map((p) => ({ label: p.name, total: p.total, overdue: p.overdue })) }),
      )
    : null

  const tableSection = programs.length > 0
    ? h('div', { className: css.gqSection },
        h('div', { className: css.gqSectionTitle }, '项目健康度'),
        h('div', { className: `${css.gqRow} ${css.gqRowHead}` },
          h('div', null, '项目'),
          h('div', null, '类型'),
          h('div', null, '进度'),
          h('div', null, '逾期'),
        ),
        programs.map((p) =>
          h('div', { key: p.id, className: css.gqRow },
            h('div', { className: css.gqName, title: `${p.name}（${p.assignee || '无负责人'}）` },
              p.name,
              p.assignee ? h('span', { className: css.gqMuted }, ` · ${p.assignee}`) : null,
            ),
            h('div', { className: css.gqMuted }, p.category || '—'),
            h(ProgressBar, { percent: p.progress }),
            p.overdue > 0
              ? h('div', { className: css.gqOverdue }, `⚠︎${p.overdue}`)
              : h('div', { className: css.gqZero }, '0'),
          ),
        ),
      )
    : null

  const riskSection = risks.length > 0
    ? h('div', { className: css.gqSection },
        h('div', { className: css.gqSectionTitle }, `风险清单（${risks.length}）`),
        h('div', { className: css.gqRisks },
          risks.slice(0, maxRisks).map((r, index) =>
            h('div', {
              key: `${r.ident}-${index}`,
              className: `${css.gqRisk} ${r.level === 'high' ? css.gqRiskHigh : r.level === 'mid' ? css.gqRiskMid : css.gqRiskLow}`,
            },
              h('span', { className: css.gqIdent }, r.ident || '—'),
              h('span', { className: css.gqRiskTitle, title: r.title }, r.title),
              h('span', { className: css.gqRiskDetail }, `${r.owner || '未指派'} · ${r.detail}`),
            ),
          ),
          risks.length > maxRisks
            ? h('div', { className: css.gqHint }, `另有 ${risks.length - maxRisks} 项未显示`)
            : null,
        ),
      )
    : null

  const foot = h('div', { className: css.gqFoot },
    h('span', null, `数据源 ${payload.source === 'live' ? '实时拉取' : '样例'} · 由 gq 脚本产出`),
    props.onRefresh
      ? h('button', { className: css.gqBtn, onClick: props.onRefresh }, '刷新')
      : null,
  )

  return h('div', { className: css.gqCard },
    head, kpis, distSection, barSection, tableSection, riskSection, foot,
  )
}
