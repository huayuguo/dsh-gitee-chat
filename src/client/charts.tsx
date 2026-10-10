/**
 * 纯 SVG / CSS 可视化组件（零图表库依赖）。
 *
 * 客户端**没有**内置 mermaid、echarts、d3，模型也无法接收图片，
 * 所以会话内的一切图形都必须由这里自己画——这正是「图表由插件渲染」的含义。
 *
 * @module dsh-gitee-chat/client/charts
 */

import { createElement as h } from 'react'
import css from './board.module.css'
import type { DistributionRow } from '../types.ts'

/** 状态 → 主题色的映射（颜色全部走令牌，随主题切换）。 */
const STATE_COLORS: Record<string, string> = {
  closed: 'var(--dsw-alias-state-success-primary)',
  progressing: 'var(--dsw-alias-brand-primary)',
  open: 'var(--dsw-alias-border-l2)',
  rejected: 'var(--dsw-alias-state-error-primary)',
}

/** 状态中文名。 */
const STATE_LABELS: Record<string, string> = {
  open: '待办的',
  progressing: '进行中',
  closed: '已完成',
  rejected: '已取消',
}

/** 取状态色（未知状态回落到中性色）。 */
export function stateColor(state: string): string {
  return STATE_COLORS[state] ?? 'var(--dsw-alias-border-l2)'
}

/** 取状态中文名。 */
export function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state
}

/**
 * 状态分布堆叠条 + 图例。宽度按占比分配，全为 0 时不渲染。
 * @param props.rows - 分布数据。
 */
export function StateStack(props: { rows: readonly DistributionRow[] }) {
  const total = props.rows.reduce((sum, r) => sum + r.count, 0)
  if (total <= 0) {
    return h('div', { className: css.gqMuted }, '暂无工作项数据')
  }
  const segments = props.rows.map((row) =>
    h('div', {
      key: row.state,
      className: css.gqStackSeg,
      style: { width: `${(row.count / total) * 100}%`, background: stateColor(row.state) },
      title: `${stateLabel(row.state)} ${row.count}`,
    }),
  )
  const legend = props.rows.map((row) =>
    h('span', { key: row.state, className: css.gqLegendItem },
      h('span', { className: css.gqDot, style: { background: stateColor(row.state) } }),
      `${stateLabel(row.state)} ${row.count}`,
    ),
  )
  return h('div', null,
    h('div', { className: css.gqStack }, segments),
    h('div', { className: css.gqLegend }, legend),
  )
}

/**
 * 进度条。`percent` 已裁剪到 0-100。
 * @param props.percent - 完成率。
 * @param props.showText - 是否在右侧显示百分比。
 */
export function ProgressBar(props: { percent: number; showText?: boolean }) {
  const pct = Math.max(0, Math.min(100, Math.round(props.percent)))
  return h('div', { className: css.gqBarWrap },
    h('div', { className: css.gqBar },
      h('div', { className: css.gqBarFill, style: { width: `${pct}%` } }),
    ),
    props.showText === false ? null : h('span', { className: css.gqBarText }, `${pct}%`),
  )
}

/**
 * 分组柱状图：每个项目一根「总量」柱，其中已逾期部分用错误色叠加。
 * 用纯 SVG 画，宽度自适应容器（viewBox + preserveAspectRatio）。
 * @param props.items - 每项的标签、总量、逾期量。
 */
export function OverdueBars(props: {
  items: readonly { label: string; total: number; overdue: number }[]
}) {
  const items = props.items.slice(0, 12)
  if (items.length === 0) return null
  const max = Math.max(1, ...items.map((i) => i.total))
  const W = 520
  const H = 96
  const padX = 4
  const gap = 10
  const barW = Math.max(8, (W - padX * 2 - gap * (items.length - 1)) / items.length)
  const H_BAR = 62

  const bars = items.map((item, index) => {
    const x = padX + index * (barW + gap)
    const hTotal = (item.total / max) * H_BAR
    const hOver = (item.overdue / max) * H_BAR
    const y = 8 + (H_BAR - hTotal)
    const children = [
      h('rect', {
        key: 'total',
        x, y, width: barW, height: Math.max(1, hTotal), rx: 3,
        fill: 'var(--dsw-alias-bg-layer-2)',
      }),
    ]
    if (hOver > 0) {
      children.push(h('rect', {
        key: 'over',
        x, y: y + (hTotal - hOver), width: barW, height: Math.max(1, hOver), rx: 3,
        fill: 'var(--dsw-alias-state-error-primary)',
      }))
    }
    children.push(h('text', {
      key: 'label',
      x: x + barW / 2,
      y: H - 4,
      textAnchor: 'middle',
      fontSize: 9,
      fill: 'var(--dsw-alias-label-secondary)',
    }, item.label.length > 7 ? `${item.label.slice(0, 6)}…` : item.label))
    children.push(h('text', {
      key: 'count',
      x: x + barW / 2,
      y: y - 3,
      textAnchor: 'middle',
      fontSize: 9.5,
      fill: 'var(--dsw-alias-label-secondary)',
    }, String(item.total)))
    return h('g', { key: item.label + index }, children)
  })

  return h('svg', {
    viewBox: `0 0 ${W} ${H}`,
    width: '100%',
    height: H,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': '各项目工作项总量与逾期量',
  }, bars)
}
