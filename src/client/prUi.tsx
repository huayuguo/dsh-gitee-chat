/**
 * 0.5.4 界面原语 —— 卡片 / KPI / 页签 / 胶囊 / 抽屉 / 二次确认弹窗 / 骨架屏。
 *
 * 全部按 `docs/design/ui-style.md` 的令牌写，类名统一 `gqPr*`（样式在 board.module.css 末尾）。
 * 这里只放「无业务」的零件；PR 相关的语义映射（状态→胶囊文案等）也集中在本文件，
 * 免得列表行和抽屉各写一套口径。
 *
 * @module dsh-gitee-chat/client/prUi
 */

import { useEffect, useRef, type ReactNode } from 'react'
import css from './pr.module.css'
import { GQ, RADIUS, SP, toneColor, type Tone } from './tokens.ts'
import type { PrCheckState, PrComment, PrFile, PrPerson, PrState, PrTestState } from '../types.ts'

/** 拼类名：自动吃掉空值。 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' ')
}

/** 语义色 → 该色在 CSS 里的类后缀（`gqPrTag` + `gqPrTagOk`）。 */
function toneClass(base: string, tone: Tone): string {
  const suffix = tone.charAt(0).toUpperCase() + tone.slice(1)
  return `${base}${suffix}`
}

// ── 卡片 ─────────────────────────────────────────────────────────────────────

/** 卡片（原型 `.card`）。 */
export function PCard(props: { children?: ReactNode; style?: Record<string, unknown>; grow?: boolean; className?: string }) {
  return (
    <div className={cx(css.gqPrCard, props.grow === true && css.gqPrCardGrow, props.className)} style={props.style}>
      {props.children}
    </div>
  )
}

/** 卡片头：标题 + 副标题 + 右侧操作（原型 `.card-hd`）。 */
export function PCardHd(props: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; right?: ReactNode }) {
  return (
    <div className={css.gqPrCardHd}>
      <div className={css.gqPrHdMain}>
        <h3 className={css.gqPrCardTitle}>{props.title}</h3>
        {props.sub === undefined ? null : <div className={css.gqPrCardSub}>{props.sub}</div>}
      </div>
      {/* 左起按钮组（用户口径 m02229 ②）：新建类主操作跟标题同一行、从左往右排 */}
      {props.actions === undefined || props.actions === null
        ? null
        : <div className={css.gqPrCardActions}>{props.actions}</div>}
      {props.right === undefined ? null : <div className={css.gqPrCardRight}>{props.right}</div>}
    </div>
  )
}

/** 卡片体（原型 `.card-bd`）。 */
export function PCardBd(props: { children?: ReactNode; style?: Record<string, unknown> }) {
  return <div className={css.gqPrCardBd} style={props.style}>{props.children}</div>
}

// ── KPI 卡 ───────────────────────────────────────────────────────────────────

/**
 * 分类 KPI 卡（原型 `.kpi`）：左侧 3px 色条 + 图标方块 + 标题 + 胶囊 + 大数字 + 说明 + 细条。
 * @param props.tone - 语义色（决定左侧色条、图标块、数字、细条）。
 * @param props.onClick - 传了就可点（做视角筛选）。
 */
export function Kpi(props: {
  tone: Tone
  icon: ReactNode
  title: ReactNode
  tag?: ReactNode
  value: ReactNode
  sub?: ReactNode
  barPercent?: number
  onClick?: () => void
  active?: boolean
}) {
  const className = cx(css.gqPrKpi, props.active === true && css.gqPrKpiOn, props.tone !== undefined && toneClass(css.gqPrKpiTone, props.tone))
  const body = (
    <>
      <div className={css.gqPrKpiHd}>
        <span className={css.gqPrKpiSq} style={{ color: toneColor(props.tone), background: `color-mix(in srgb, ${toneColor(props.tone)} 12%, transparent)` }}>
          {props.icon}
        </span>
        <span className={css.gqPrKpiTitle}>{props.title}</span>
        {props.tag === undefined ? null : <span className={css.gqPrKpiTag}>{props.tag}</span>}
      </div>
      <div className={css.gqPrKpiN} style={{ color: toneColor(props.tone) }}>{props.value}</div>
      {props.sub === undefined ? null : <div className={css.gqPrKpiSub}>{props.sub}</div>}
      <div className={css.gqPrKpiBar}>
        <i
          className={css.gqPrKpiBarFill}
          style={{ width: `${Math.max(0, Math.min(100, props.barPercent ?? 0))}%`, background: toneColor(props.tone) }}
        />
      </div>
    </>
  )
  if (props.onClick === undefined) return <div className={className}>{body}</div>
  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      title={typeof props.title === 'string' ? `只看「${props.title}」` : undefined}
      onClick={props.onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onClick?.()
        }
      }}
    >
      {body}
    </div>
  )
}

// ── 胶囊 / 圆点 / 分支 / 引用块 ─────────────────────────────────────────────

/** 语义胶囊（原型 `.pill`）。 */
export function Tag(props: { tone?: Tone; children?: ReactNode; title?: string; mono?: boolean }) {
  return (
    <span
      className={cx(css.gqPrTag, props.tone !== undefined && toneClass(css.gqPrTagTone, props.tone), props.mono === true && css.gqPrTagMono)}
      title={props.title}
    >
      {props.children}
    </span>
  )
}

/** 小圆点（图例用）。 */
export function Dot(props: { color: string; children?: ReactNode }) {
  return (
    <span className={css.gqPrDotWrap}>
      <i className={css.gqPrDot} style={{ background: props.color }} />
      {props.children}
    </span>
  )
}

/** 分支对（`feat/x → main`，等宽字体）。 */
export function BranchPair(props: { from: string; to: string }) {
  return (
    <span className={css.gqPrBranch}>
      <code className={css.gqPrBranchCode}>{props.from}</code>
      <span className={css.gqPrBranchArrow}>→</span>
      <code className={css.gqPrBranchCode}>{props.to}</code>
    </span>
  )
}

/** 引用块（原型 `.blockquote`）：放口径说明 / 提示。 */
export function BQ(props: { children?: ReactNode; tone?: Tone }) {
  return (
    <div className={cx(css.gqPrBq, props.tone !== undefined && toneClass(css.gqPrBqTone, props.tone))} style={props.tone === undefined ? undefined : { borderLeftColor: toneColor(props.tone) }}>
      {props.children}
    </div>
  )
}

/** 头像（首字）。 */
export function Avatar(props: { name: string; size?: number }) {
  const palette: Tone[] = ['info', 'violet', 'ok', 'warn', 'slate', 'muted']
  const name = props.name.trim()
  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 997
  const color = name === '' ? GQ.muted : toneColor(palette[hash % palette.length] ?? 'muted')
  const size = props.size ?? 20
  return (
    <span
      className={css.gqPrAv}
      title={name}
      style={{ width: size, height: size, lineHeight: `${size}px`, background: `color-mix(in srgb, ${color} 16%, transparent)`, color }}
    >
      {name === '' ? '?' : name.slice(0, 1)}
    </span>
  )
}

/** 人（头像 + 名字 + 可选状态胶囊）。 */
export function PersonLine(props: { person: PrPerson }) {
  const state = personState(props.person.state)
  return (
    <span className={css.gqPrPerson}>
      <Avatar name={props.person.name} />
      <span className={css.gqPrPersonName}>{props.person.name}</span>
      {state === null ? null : <Tag tone={state.tone}>{state.label}</Tag>}
    </span>
  )
}

// ── 键值表 ───────────────────────────────────────────────────────────────────

/** 键值表（原型 `dl.kv`）：`rows` 是 `[标签, 值]`。 */
export function Kv(props: { rows: Array<[ReactNode, ReactNode]>; dense?: boolean }) {
  return (
    <dl className={cx(css.gqPrKv, props.dense === true && css.gqPrKvDense)}>
      {props.rows.map((row, index) => (
        <div className={css.gqPrKvRow} key={index}>
          <dt className={css.gqPrKvK}>{row[0]}</dt>
          <dd className={css.gqPrKvV}>{row[1]}</dd>
        </div>
      ))}
    </dl>
  )
}

// ── 页签 ─────────────────────────────────────────────────────────────────────

/** 页签项。 */
export interface TabItem<T extends string> {
  key: T
  label: ReactNode
  count?: number
}

/** 下划线式页签（整页导航 + 抽屉内页签共用）。 */
export function Tabs<T extends string>(props: { items: ReadonlyArray<TabItem<T>>; value: T; onChange: (key: T) => void; className?: string }) {
  return (
    <div className={cx(css.gqPrTabs, props.className)} role="tablist">
      {props.items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={item.key === props.value}
          className={cx(css.gqPrTab, item.key === props.value && css.gqPrTabOn)}
          onClick={() => props.onChange(item.key)}
        >
          {item.label}
          {item.count === undefined ? null : <span className={css.gqPrTabN}>{item.count}</span>}
        </button>
      ))}
    </div>
  )
}

// ── 按钮 / 输入 ─────────────────────────────────────────────────────────────

/** 按钮：默认（描边）/ primary / danger / ghost / blue / purple / green / sm。 */
export function Btn(props: {
  children?: ReactNode
  onClick?: () => void
  tone?: 'default' | 'primary' | 'danger' | 'ghost' | 'blue' | 'purple' | 'green'
  size?: 'md' | 'sm'
  disabled?: boolean
  title?: string
  type?: 'button' | 'submit'
}) {
  const tone = props.tone ?? 'default'
  return (
    <button
      type={props.type ?? 'button'}
      className={cx(
        css.gqPrBtn,
        tone === 'primary' && css.gqPrBtnPrimary,
        tone === 'danger' && css.gqPrBtnDanger,
        tone === 'ghost' && css.gqPrBtnGhost,
        tone === 'blue' && css.gqPrBtnBlue,
        tone === 'purple' && css.gqPrBtnPurple,
        tone === 'green' && css.gqPrBtnGreen,
        props.size === 'sm' && css.gqPrBtnSm,
      )}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </button>
  )
}

/**
 * 胶囊色调。默认态是「同色系浅底 + 深字」，选中态才是实心白字 ——
 * 两种状态都保证字与底有足够对比度（用户口径 m01906：别让色块把字盖住）。
 */
export type ChipTone = 'slate' | 'blue' | 'green' | 'amber' | 'red' | 'purple' | 'cyan'

const CHIP_TONE: Record<ChipTone, string> = {
  slate: css.gqPrChipSlate,
  blue: css.gqPrChipBlue,
  green: css.gqPrChipGreen,
  amber: css.gqPrChipAmber,
  red: css.gqPrChipRed,
  purple: css.gqPrChipPurple,
  cyan: css.gqPrChipCyan,
}

/**
 * 胶囊勾选框：长得像 chip，行为是 checkbox。
 *
 * 用在「投递到」那一行（用户口径 2026-10-27）：勾上 = 在目标会话下起子智能体，
 * 取消 = 直接以用户消息投到该会话。做成胶囊而不是原生 checkbox，是为了和同行
 * 的下拉/标签保持同一套视觉语言。
 */
export function PillCheck(props: {
  checked: boolean
  label: ReactNode
  title?: string
  disabled?: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.checked}
      className={cx(css.gqPrCheck, props.checked && css.gqPrCheckOn)}
      title={props.title}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className={css.gqPrCheckBox} aria-hidden>{props.checked ? '✓' : ''}</span>
      {props.label}
    </button>
  )
}

/** 单选胶囊组（筛选条 / 模板选择 / 范围选择）。`tone` 决定这一颗的色卡。 */
export function Chips<T extends string>(props: {
  items: ReadonlyArray<{ key: T; label: ReactNode; title?: string; disabled?: boolean; tone?: ChipTone }>
  value: T | null
  onChange: (key: T) => void
}) {
  return (
    <div className={css.gqPrChips}>
      {props.items.map((item) => (
        <button
          key={item.key}
          type="button"
          title={item.title}
          disabled={item.disabled}
          className={cx(
            css.gqPrChip,
            item.tone !== undefined && CHIP_TONE[item.tone],
            item.key === props.value && css.gqPrChipOn,
          )}
          onClick={() => props.onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

// ── 骨架 / 空态 / 错误 ──────────────────────────────────────────────────────

/** 骨架屏：`rows` 行宽窄交替的灰条。 */
export function Skeleton(props: { rows?: number; rowHeight?: number }) {
  const rows = props.rows ?? 4
  return (
    <div className={css.gqPrSk} aria-busy="true" aria-label="正在加载">
      {Array.from({ length: rows }, (_, index) => (
        <i
          key={index}
          className={css.gqPrSkLine}
          style={{ height: props.rowHeight ?? 14, width: `${[92, 74, 84, 62, 88][index % 5]}%` }}
        />
      ))}
    </div>
  )
}

/** 空态（带可选动作）。 */
export function EmptyBox(props: { title: ReactNode; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className={css.gqPrEmptyBox}>
      <div className={css.gqPrEmptyTitle}>{props.title}</div>
      {props.hint === undefined ? null : <div className={css.gqPrEmptyHint}>{props.hint}</div>}
      {props.action === undefined ? null : <div className={css.gqPrEmptyAction}>{props.action}</div>}
    </div>
  )
}

/** 错误态：主文案 + 下一步 hint + 重试。 */
export function ErrBox(props: { message: string; hint?: string; code?: string; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div className={css.gqPrErrBox} role="alert">
      <div className={css.gqPrErrTitle}>{props.message}</div>
      {props.hint === undefined || props.hint === '' ? null : <div className={css.gqPrErrHint}>{props.hint}</div>}
      <div className={css.gqPrErrFoot}>
        {props.code === undefined ? null : <Tag mono>{props.code}</Tag>}
        {props.onRetry === undefined ? null : <Btn size="sm" onClick={props.onRetry}>{props.retryLabel ?? '重试'}</Btn>}
      </div>
    </div>
  )
}

// ── 抽屉 ─────────────────────────────────────────────────────────────────────

/**
 * 右侧抽屉（原型 `#drawer`，820px）。
 *
 * 只在 `open` 为真时由调用方挂载；Esc / 点遮罩关闭。
 */
export function Drawer(props: {
  lead: ReactNode
  title: ReactNode
  meta?: ReactNode
  tabs?: ReadonlyArray<TabItem<string>>
  tab?: string
  onTab?: (key: string) => void
  footer?: ReactNode
  onClose: () => void
  children?: ReactNode
}) {
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        props.onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [props])

  return (
    <div className={css.gqPrOverlay} onClick={() => props.onClose()}>
      <aside
        className={css.gqPrDrawer}
        role="dialog"
        aria-modal="true"
        aria-label="合并请求详情"
        onClick={(event) => event.stopPropagation()}
      >
        <header className={css.gqPrDwHd}>
          <div className={css.gqPrDwHdMain}>
            <span className={css.gqPrDwLead}>{props.lead}</span>
            <h2 className={css.gqPrDwTitle}>{props.title}</h2>
          </div>
          <button type="button" className={css.gqPrDwClose} aria-label="关闭" onClick={() => props.onClose()}>✕</button>
        </header>
        {props.meta === undefined ? null : <div className={css.gqPrDwMeta}>{props.meta}</div>}
        {props.tabs === undefined || props.tab === undefined || props.onTab === undefined
          ? null
          : <Tabs items={props.tabs} value={props.tab} onChange={props.onTab} className={css.gqPrDwTabs} />}
        <div className={css.gqPrDwBd} ref={bodyRef}>{props.children}</div>
        {props.footer === undefined ? null : <footer className={css.gqPrDwFt}>{props.footer}</footer>}
      </aside>
    </div>
  )
}

// ── 二次确认弹窗 ─────────────────────────────────────────────────────────────

/**
 * 二次确认弹窗（原型 `#modal`，560px）。
 *
 * **所有写动作都必须先过这里**：`rows` 列清「会对什么做什么、后果是什么」，
 * `children` 放额外输入（合并方式 / 评论正文 / 审核意见）。
 * 有 `error` 时留在弹窗里显示（不关窗），使用者能改了再点一次。
 */
export function Dialog(props: {
  open: boolean
  title: string
  lead?: ReactNode
  rows?: Array<[ReactNode, ReactNode]>
  note?: ReactNode
  children?: ReactNode
  okLabel: string
  okTone?: 'primary' | 'danger'
  busy?: boolean
  error?: { message: string; hint?: string } | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!props.open) return undefined
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && props.busy !== true) {
        event.stopPropagation()
        props.onCancel()
      }
    }
    document.addEventListener('keydown', onKey)
    panelRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [props.open, props.busy, props.onCancel])

  if (!props.open) return null
  return (
    <div className={css.gqPrOverlayTop} onClick={() => { if (props.busy !== true) props.onCancel() }}>
      <div
        className={css.gqPrModal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gq-pr-dialog-title"
        tabIndex={-1}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={css.gqPrModalHd}>
          <h3 id="gq-pr-dialog-title" className={css.gqPrModalTitle}>{props.title}</h3>
          {props.lead === undefined ? null : <div className={css.gqPrModalLead}>{props.lead}</div>}
        </header>
        <div className={css.gqPrModalBd}>
          {props.rows === undefined ? null : <Kv rows={props.rows} />}
          {props.children}
          {props.note === undefined ? null : <BQ>{props.note}</BQ>}
          {props.error === undefined || props.error === null ? null : (
            <div className={css.gqPrModalErr} role="alert">
              <div>{props.error.message}</div>
              {props.error.hint === undefined || props.error.hint === '' ? null : <div className={css.gqPrErrHint}>{props.error.hint}</div>}
            </div>
          )}
        </div>
        <footer className={css.gqPrModalFt}>
          <Btn onClick={() => props.onCancel()} disabled={props.busy === true}>取消</Btn>
          <Btn
            tone={props.okTone === 'danger' ? 'danger' : 'primary'}
            onClick={() => props.onConfirm()}
            disabled={props.busy === true}
          >
            {props.busy === true ? '执行中…' : props.okLabel}
          </Btn>
        </footer>
      </div>
    </div>
  )
}

// ── 语义映射（唯一口径）──────────────────────────────────────────────────────

/** PR 生命周期 → 胶囊。 */
export function statePill(state: PrState): { tone: Tone; label: string } {
  if (state === 'merged') return { tone: 'violet', label: '已合并' }
  if (state === 'closed') return { tone: 'muted', label: '已关闭' }
  return { tone: 'info', label: '打开中' }
}

/** 审查状态 → 胶囊（`待审查 1/2` 这类信息由调用方补人数）。 */
export function reviewPill(checkState: PrCheckState, passed: number, total: number): { tone: Tone; label: string } {
  if (checkState === 2) return { tone: 'ok', label: '审查通过' }
  if (checkState === 0) return { tone: 'muted', label: '无需审查' }
  return { tone: 'warn', label: total > 0 ? `待审查 ${passed}/${total}` : '待审查' }
}

/** 测试状态 → 胶囊。 */
export function testPill(testState: PrTestState, passed: number, total: number): { tone: Tone; label: string } {
  if (testState === 2) return { tone: 'ok', label: '测试通过' }
  if (testState === 0) return { tone: 'muted', label: '无需测试' }
  return { tone: 'info', label: total > 0 ? `待测试 ${passed}/${total}` : '待测试' }
}

/** 可合并胶囊。 */
export function mergePill(mergeable: boolean): { tone: Tone; label: string } {
  return mergeable ? { tone: 'ok', label: '可合并' } : { tone: 'muted', label: '不可合并' }
}

/** 文件状态 → 胶囊。 */
export function fileStatusPill(status: PrFile['status']): { tone: Tone; label: string } {
  if (status === 'added') return { tone: 'ok', label: '新增' }
  if (status === 'deleted') return { tone: 'danger', label: '删除' }
  if (status === 'renamed') return { tone: 'violet', label: '改名' }
  return { tone: 'info', label: '修改' }
}

/** 审查/测试人的个人状态：0 待处理 · 1 已通过 · 2 已驳回。 */
export function personState(state: PrPerson['state']): { tone: Tone; label: string } | null {
  if (state === 1) return { tone: 'ok', label: '已通过' }
  if (state === 2) return { tone: 'danger', label: '已驳回' }
  return { tone: 'muted', label: '待处理' }
}

/** 相对时间（`3 分钟前` / `2026-10-26 13:38`）。 */
export function relTime(iso: string): string {
  if (typeof iso !== 'string' || iso === '') return '—'
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  const diff = Date.now() - time
  if (diff < 0) return absTime(iso)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  return absTime(iso)
}

/** 绝对时间（`YYYY-MM-DD HH:MM`）。 */
export function absTime(iso: string): string {
  if (typeof iso !== 'string' || iso === '') return '—'
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return iso
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 评论作者名（空作者兜底）。 */
export function commentAuthor(comment: PrComment): string {
  const name = comment.author?.name ?? ''
  return name === '' ? '（未知）' : name
}

/** 语义色值（SVG `stroke`/`fill` 用；内联样式支持 `var()`）。 */
export const TONE_TOKENS = { ok: GQ.ok, warn: GQ.warn, danger: GQ.danger, info: GQ.info, violet: GQ.violet, muted: GQ.muted } as const

/** 圆角/间距常量再导出，方便组件写内联样式时统一取。 */
export { RADIUS, SP }
