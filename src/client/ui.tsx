/**
 * 整屏视图的共享 UI 原件。
 *
 * 版式语言对齐 DSH 官方的「上下文」标签页：卡片 + 卡头 + 分段开关 + 统计格 +
 * 行列表 + 居中空态/错误态。这里只放**无状态**的原件，取数与状态机在别处。
 *
 * @module dsh-gitee-chat/client/ui
 */

import { createElement as h, type ReactNode } from 'react'
import css from './board.module.css'

/** 卡片：视图里所有内容的容器单位。 */
export function Card(props: { children?: ReactNode; style?: Record<string, unknown>; grow?: boolean }) {
  return h('div', {
    className: css.gqVCard,
    style: props.grow === true ? { ...props.style, flex: 1 } : props.style,
  }, props.children)
}

/**
 * 卡头：左侧标题（不换行）+ 可选说明 + 右侧控件（自动靠右）。
 * @param props.title - 标题文本。
 * @param props.note - 标题右侧的次要说明。
 * @param props.right - 右侧控件（通常是分段开关）。
 */
export function CardTitle(props: { title: ReactNode; note?: ReactNode; right?: ReactNode }) {
  return h('div', { className: css.gqVCardTitle },
    h('span', { className: css.gqVTitleText }, props.title),
    props.note === undefined || props.note === null ? null : h('span', { className: css.gqVTitleNote }, props.note),
    props.right ?? null,
  )
}

/** 分段开关的一项。 */
export interface SegOption {
  key: string
  label: ReactNode
  title?: string
}

/**
 * 分段开关（标题右侧的 Step/Turn 同款）。
 * @param props.options - 选项。
 * @param props.value - 当前选中项的 key。
 * @param props.onChange - 切换回调。
 * @param props.disabled - 整体禁用。
 */
export function Segmented(props: {
  options: readonly SegOption[]
  value: string
  onChange: (key: string) => void
  disabled?: boolean
}) {
  return h('div', { className: css.gqVSeg }, props.options.map((o) =>
    h('button', {
      key: o.key,
      type: 'button',
      title: o.title,
      disabled: props.disabled === true,
      className: `${css.gqVSegBtn} ${props.value === o.key ? css.gqVSegOn : ''}`,
      onClick: () => props.onChange(o.key),
    }, o.label),
  ))
}

/** 一格统计（Context Stats 的 Turns/Steps 同款）。 */
export function Stat(props: { label: ReactNode; value: ReactNode; tone?: 'warn' | 'err' | 'ok'; title?: string }) {
  const tone = props.tone === 'warn' ? css.gqVWarn : props.tone === 'err' ? css.gqVErr : props.tone === 'ok' ? css.gqVOk : ''
  return h('div', { className: css.gqVStat, title: props.title },
    h('div', { className: css.gqVStatLabel }, props.label),
    h('div', { className: `${css.gqVStatValue} ${tone}` }, props.value),
  )
}

/** 一行统计格；`auto-fit` 会自动折行。 */
export function StatGrid(props: { children?: ReactNode }) {
  return h('div', { className: css.gqVStats }, props.children)
}

/** 居中的次要提示（空态）。 */
export function Empty(props: { children?: ReactNode }) {
  return h('div', { className: css.gqVEmpty }, props.children)
}

/**
 * 居中的错误态（带等宽的原始信息 + 重试）。
 * @param props.message - 可读的说明。
 * @param props.detail - 原始错误信息（等宽显示）。
 * @param props.onRetry - 重试回调；不给就不渲染按钮。
 */
export function ErrorState(props: { message: ReactNode; detail?: string; onRetry?: () => void }) {
  return h('div', { className: css.gqVErrBox },
    h('div', null, props.message),
    props.detail === undefined || props.detail === '' ? null : h('div', { className: css.gqVErrMsg }, props.detail),
    props.onRetry === undefined ? null : h('button', { type: 'button', className: css.gqVBtn, onClick: props.onRetry }, '重试'),
  )
}

/** 小徽标。 */
export function Pill(props: { children?: ReactNode; tone?: 'warn' | 'err' | 'ok'; title?: string }) {
  const tone = props.tone === 'warn' ? css.gqVPillWarn : props.tone === 'err' ? css.gqVPillErr : props.tone === 'ok' ? css.gqVPillOk : ''
  return h('span', { className: `${css.gqVPill} ${tone}`, title: props.title }, props.children)
}

/** 彩色圆点（图例 / 健康度）。 */
export function Dot(props: { color: string; title?: string }) {
  return h('span', { className: css.gqVDot, style: { background: props.color }, title: props.title })
}

/** 一根细条（进度 / 得分 / 占比）。 */
export function Bar(props: { percent: number; color?: string; title?: string }) {
  const pct = Math.max(0, Math.min(100, Math.round(props.percent)))
  return h('div', { className: css.gqVBar, title: props.title },
    h('div', { className: css.gqVBarFill, style: { width: `${pct}%`, background: props.color ?? 'var(--dsw-alias-brand-primary)' } }),
  )
}

/**
 * 行列表的一行：`[key] 名称 ………… 数值`。
 * @param props.onClick - 给了就是可点的行。
 */
export function Row(props: {
  keyText?: ReactNode
  color?: string
  name: ReactNode
  value?: ReactNode
  title?: string
  active?: boolean
  onClick?: () => void
}) {
  const cls = `${css.gqVRow} ${props.onClick === undefined ? '' : css.gqVRowBtn} ${props.active === true ? css.gqVRowOn : ''}`
  return h('div', {
    className: cls,
    title: props.title,
    onClick: props.onClick,
    role: props.onClick === undefined ? undefined : 'button',
    tabIndex: props.onClick === undefined ? undefined : 0,
  },
    props.color === undefined && props.keyText === undefined
      ? null
      : h('span', { className: css.gqVRowKey }, props.color === undefined ? null : h(Dot, { color: props.color }), props.keyText),
    h('span', { className: css.gqVRowName, title: props.title }, props.name),
    h('span', { className: css.gqVRowValue }, props.value),
  )
}

/** 可滚动的行列表容器。 */
export function List(props: { children?: ReactNode; scroll?: boolean }) {
  return h('div', { className: `${css.gqVList} ${props.scroll === false ? '' : css.gqVScroll}` }, props.children)
}

/** 迷你表格。 */
export function Table(props: { head: ReactNode[]; children?: ReactNode }) {
  return h('table', { className: css.gqVTable },
    h('thead', null, h('tr', null, props.head.map((cell, i) => h('th', { key: i }, cell)))),
    h('tbody', null, props.children),
  )
}

/** 一个「标签 / 值」字段（详情面板的字段网格用）。 */
export function Field(props: { label: ReactNode; children?: ReactNode }) {
  return h('div', null,
    h('div', { className: css.gqVFieldLabel }, props.label),
    h('div', { className: css.gqVFieldValue }, props.children),
  )
}

/** 底部口径说明。 */
export function Note(props: { children?: ReactNode }) {
  return h('div', { className: css.gqVNote }, props.children)
}

/** 状态 → 主题色。 */
export function stateColor(state: string): string {
  if (state === 'closed') return 'var(--dsw-alias-state-success-primary)'
  if (state === 'progressing') return 'var(--dsw-alias-brand-primary)'
  if (state === 'rejected') return 'var(--dsw-alias-state-error-primary)'
  return 'var(--dsw-alias-border-l2)'
}

/** 健康度 / 风险等级 → 主题色。 */
export function levelColor(level: string): string {
  if (level === 'good' || level === 'ok' || level === 'achieved' || level === 'on-track') return 'var(--dsw-alias-state-success-primary)'
  if (level === 'warn' || level === 'at-risk') return 'var(--dsw-alias-state-warn-primary)'
  if (level === 'bad' || level === 'overloaded' || level === 'missed') return 'var(--dsw-alias-state-error-primary)'
  return 'var(--dsw-alias-border-l2)'
}

// ── 极简 Markdown 渲染 ──────────────────────────────────────────────────────
//
// 工作项描述和评论都是 Markdown（Gitee 的 description_type = md）。
// 这里只渲染**确实会出现在工作项里**的子集：标题、列表、引用、代码、链接、
// 粗体/行内代码、分隔线、段落。
//
// 安全：全部走 React 的文本子节点，**不用 dangerouslySetInnerHTML**，
// 因此描述里的任何 HTML 都会被当纯文本转义 —— 没有注入面。

/** 行内解析：`code`、**bold**、[text](url)、裸链接。 */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>"')\]]+)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const key = `${keyPrefix}-${i++}`
    if (m[1] !== undefined) {
      out.push(h('code', { key }, m[1].slice(1, -1)))
    } else if (m[2] !== undefined) {
      out.push(h('strong', { key }, m[2].slice(2, -2)))
    } else if (m[3] !== undefined) {
      const label = m[3].slice(1, m[3].indexOf(']'))
      out.push(h('a', { key, href: m[4], target: '_blank', rel: 'noreferrer noopener' }, label))
    } else {
      out.push(h('a', { key, href: m[4], target: '_blank', rel: 'noreferrer noopener' }, m[4]))
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * 把 Markdown 渲染成一组元素。
 * @param props.text - Markdown 原文。
 * @param props.plain - true 时只做行内解析（评论用，不产生块级标题）。
 */
export function Markdown(props: { text: string; plain?: boolean }) {
  const lines = String(props.text ?? '').split(/\r?\n/)
  const blocks: ReactNode[] = []
  let para: string[] = []
  let list: string[] = []
  let quote: string[] = []
  let code: string[] | null = null
  let key = 0

  const flushPara = () => {
    if (para.length === 0) return
    blocks.push(h('p', { key: `p${key++}` }, inline(para.join(' '), `p${key}`)))
    para = []
  }
  const flushList = () => {
    if (list.length === 0) return
    blocks.push(h('ul', { key: `u${key++}` }, list.map((item, i) => h('li', { key: i }, inline(item, `li${key}-${i}`)))))
    list = []
  }
  const flushQuote = () => {
    if (quote.length === 0) return
    blocks.push(h('blockquote', { key: `q${key++}` }, inline(quote.join(' '), `q${key}`)))
    quote = []
  }
  const flushAll = () => { flushPara(); flushList(); flushQuote() }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')

    if (/^```/.test(line)) {
      if (code === null) { flushAll(); code = [] } else {
        blocks.push(h('pre', { key: `c${key++}` }, h('code', null, code.join('\n'))))
        code = null
      }
      continue
    }
    if (code !== null) { code.push(raw); continue }

    if (line.trim() === '') { flushAll(); continue }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushAll()
      blocks.push(h('hr', { key: `h${key++}` }))
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading !== null && props.plain !== true) {
      flushAll()
      const tag = `h${Math.min(4, heading[1].length)}`
      blocks.push(h(tag, { key: `h${key++}` }, inline(heading[2], `h${key}`)))
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet !== null) {
      flushPara(); flushQuote()
      list.push(bullet[1])
      continue
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ordered !== null) {
      flushPara(); flushQuote()
      list.push(ordered[1])
      continue
    }

    const quoted = /^\s*>\s?(.*)$/.exec(line)
    if (quoted !== null) {
      flushPara(); flushList()
      quote.push(quoted[1])
      continue
    }

    flushList(); flushQuote()
    para.push(line)
  }
  flushAll()
  if (code !== null && code.length > 0) {
    blocks.push(h('pre', { key: `c${key++}` }, h('code', null, code.join('\n'))))
  }

  return h('div', { className: css.gqVMd }, blocks)
}

/** 时间戳裁剪到分钟（`2026-09-14T10:35:19+08:00` → `2026-09-14 10:35`）。 */
export function stamp(iso: string): string {
  if (typeof iso !== 'string' || iso === '') return '—'
  return iso.slice(0, 16).replace('T', ' ')
}

/** 日期裁剪到天。 */
export function day(iso: string): string {
  if (typeof iso !== 'string' || iso === '') return '—'
  return iso.slice(0, 10)
}
