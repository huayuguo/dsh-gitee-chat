/**
 * 工作项详情面板（F-09）+ 会话内写回（G-05 / F-10）。
 *
 * 三块内容，对应需求方最早提的三件事：
 *   1. **描述** —— Markdown 渲染，并且把「## 前置依赖」那一段单独抽出来
 *   2. **前置依赖** —— 已完成的画绿、未完成的标红并明确说「卡住本项」
 *   3. **评论中的讨论** —— 按时间正序，回复关系靠引用块呈现
 *
 * 写回：状态 / 评论 / 改派三个动作，全部走 `postWrite` → host 的唯一写入口。
 * 界面上**没有第二套写逻辑**，也没有「先乐观更新再补发」的时序问题——
 * 写完重新拉一次详情，看到的就是服务端的真值。
 *
 * @module dsh-gitee-chat/client/IssueDetail
 */

import { createElement as h, useCallback, useEffect, useMemo, useState } from 'react'
import css from './board.module.css'
import { BoardApiError, fetchIssue, fetchMembers, fetchStates, postWrite } from './api.ts'
import { Bar, Card, CardTitle, Empty, ErrorState, Field, Markdown, Note, Pill, Segmented, StatePill, day, levelColor, stamp, stateColor } from './ui.tsx'
import type { IssueDetailPayload, IssueStateRow, ProgramMemberRow } from '../types.ts'

/** 状态 → 中文名。 */
const STATE_TEXT: Record<string, string> = {
  open: '待办的',
  progressing: '进行中',
  closed: '已完成',
  rejected: '已取消',
}

/** 详情面板的入参。 */
export interface IssueDetailProps {
  /** 会话 id（写操作必须带上，host 用它确认这是 Gitee 会话）。 */
  sessionId: string
  /** 要展示的工作项编号。 */
  ident: string
  /** 写通道是否开启（只读部署会置 false）。 */
  writesEnabled: boolean
  /** 关闭面板。 */
  onClose?: () => void
  /** 数据变更后的回调（父级据此刷新看板）。 */
  onChanged?: () => void
  /**
   * 离线预览用的种子数据。
   *
   * **仅供 `scripts/render-check.mjs` 的 SSR 自检注入**：服务端渲染不跑 effect，
   * 没有它就无法把详情面板渲染成静态 HTML。正常槽位渲染不传，组件自己去拉。
   */
  preload?: {
    detail: IssueDetailPayload
    states?: IssueStateRow[]
    members?: ProgramMemberRow[]
  }
}

/** 一次写操作的界面状态。 */
type WritePhase =
  | { kind: 'idle' }
  | { kind: 'busy'; what: string }
  | { kind: 'ok'; what: string }
  | { kind: 'error'; what: string; message: string }

/**
 * 工作项详情面板。
 * @param props - 见 {@link IssueDetailProps}。
 */
export function IssueDetail(props: IssueDetailProps) {
  const { ident, sessionId, writesEnabled } = props
  const seed = props.preload
  const [data, setData] = useState<IssueDetailPayload | null>(seed?.detail ?? null)
  const [error, setError] = useState<string | null>(null)
  const [write, setWrite] = useState<WritePhase>({ kind: 'idle' })
  const [comment, setComment] = useState('')
  const [states, setStates] = useState<IssueStateRow[]>(seed?.states ?? [])
  const [members, setMembers] = useState<ProgramMemberRow[]>(seed?.members ?? [])
  const [showAssign, setShowAssign] = useState(false)
  const [tick, setTick] = useState(0)

  /** 拉详情。写完之后靠 tick 递增重拉，看到的就是服务端真值。 */
  useEffect(() => {
    // 离线预览注入了数据时跳过拉取（SSR 不跑 effect，这里只影响浏览器里的预览页）
    if (seed !== undefined && tick === 0) return
    const controller = new AbortController()
    setError(null)
    fetchIssue(ident, controller.signal)
      .then((res) => { if (!controller.signal.aborted) setData(res) })
      .catch((err) => {
        if ((err as Error)?.name === 'AbortError') return
        setError(err instanceof BoardApiError ? err.message : String(err))
      })
    return () => controller.abort()
  }, [ident, tick, seed])

  // 状态选项与成员：只在需要时拉一次（改状态要「这个类型有哪些状态」）
  useEffect(() => {
    if (data === null || !writesEnabled) return
    if (seed !== undefined && tick === 0) return
    const controller = new AbortController()
    void fetchStates(data.detail.typeId, controller.signal).then((rows) => {
      if (!controller.signal.aborted) setStates(rows)
    }).catch(() => { /* 拉不到就不给改状态的入口，不报错 */ })
    void fetchMembers(data.detail.programId, controller.signal).then((rows) => {
      if (!controller.signal.aborted) setMembers(rows)
    }).catch(() => { /* 同上 */ })
    return () => controller.abort()
  }, [data?.detail.typeId, data?.detail.programId, writesEnabled, seed, tick])

  /** 提交一次写操作，成功后重拉详情并通知父级。 */
  const submit = useCallback(async (what: string, run: () => Promise<unknown>) => {
    setWrite({ kind: 'busy', what })
    try {
      await run()
      setWrite({ kind: 'ok', what })
      setTick((n) => n + 1)
      props.onChanged?.()
    } catch (err) {
      setWrite({ kind: 'error', what, message: err instanceof Error ? err.message : String(err) })
    }
  }, [props])

  const detail = data?.detail

  /** 已渲染的描述：抽掉「前置依赖」段（它在上面的依赖区单独展示）。 */
  const description = useMemo(() => {
    if (data === null) return ''
    const depsTitles = /^前置依赖|^依赖项|^前置条件/
    const sections = data.template.sections
    if (sections.length === 0) return detail?.description ?? ''
    return sections
      .filter((s) => !depsTitles.test(s.title))
      .map((s) => `## ${s.title}\n${s.body}`)
      .join('\n\n')
  }, [data])

  if (error !== null) {
    return h(Card, null,
      h(CardTitle, { title: ident, note: '工作项详情' }),
      h(ErrorState, { message: '详情加载失败', detail: error, onRetry: () => setTick((n) => n + 1) }),
    )
  }
  if (data === null || detail === undefined) {
    return h(Card, null,
      h(CardTitle, { title: ident, note: '工作项详情' }),
      h(Empty, null, '正在加载详情…'),
    )
  }

  // ── 依赖区 ────────────────────────────────────────────────────────────
  const deps = data.dependencies
  const depBlock = h(Card, null,
    h(CardTitle, {
      title: '前置依赖',
      note: data.template.hasTemplate ? '来自描述里的「## 前置依赖」' : '描述里没有该分段',
      right: h(Pill, {
        tone: data.blockers.length > 0 ? 'err' : deps.length > 0 ? 'ok' : undefined,
      }, data.blockers.length > 0 ? `${data.blockers.length} 项未完成` : deps.length > 0 ? '前置已就绪' : '无前置'),
    }),
    deps.length === 0
      ? h(Empty, null, data.template.hasTemplate ? '描述里写着没有前置依赖' : '描述里没有「## 前置依赖」分段，无法判断')
      : h('div', null,
          h('div', { className: css.gqVList },
            deps.map((d) => h('div', {
              key: d.ref,
              className: css.gqVRow,
              style: { gridTemplateColumns: 'auto minmax(0,1fr) auto' },
            },
              h('span', { className: css.gqVRowKey, title: d.kind === 'wbs' ? 'WBS 编码（按标题前缀反查）' : 'Gitee 工作项编号' },
                d.ref,
                d.known && d.ident !== d.ref ? h('span', { className: css.gqVDim }, ` → ${d.ident}`) : null),
              h('span', { className: css.gqVRowName, title: d.title || d.label },
                d.self ? h('span', { className: css.gqVErr }, '指向自己（描述里的引用写错了）')
                  : d.known ? d.title
                    : h('span', null,
                        h('span', { className: css.gqVWarn }, '没反查到对应工作项'),
                        d.label === '' ? null : h('span', { className: css.gqVDim }, `（描述里写的是：${d.label}）`),
                      )),
              h('span', { className: css.gqVRowValue },
                h('span', { style: { color: d.done ? levelColor('good') : d.known ? levelColor('bad') : levelColor('warn') } },
                  d.known ? (d.done ? '已完成' : STATE_TEXT[d.state] ?? d.state) : '未知'),
                d.owner === '' ? null : h('span', { className: css.gqVDim }, ` · ${d.owner}`),
              ),
            )),
          ),
          // 依赖写法有两种（编号 / WBS 编码），口径必须写在界面上，
          // 否则「没反查到」会被误读成「这个依赖不存在」。
          h(Note, null,
            '引用可以是工作项编号，也可以是描述里的 WBS 编码（如 `ME-02`）；'
            + '「没反查到」只说明对不上任何工作项，不代表这个前置条件不存在。'),
        ),
    data.blockers.length > 0
      ? h(Note, null, h('span', { className: css.gqVErr },
          `⚠ 本项被 ${data.blockers.map((b) => b.ident || b.ref).join('、')} 阻塞：这些前置项还没完成。`))
      : null,
  )

  // ── 写回区 ────────────────────────────────────────────────────────────
  //
  // ⚠️ 状态 id 是**每个企业各自定义的**（同一个「已完成」在不同企业 id 不同），
  // 所以这里绝不内置兜底列表：读不到就明说读不到、不给按钮。
  // 曾经想放一份「待办的/进行中/已完成」的默认 id，那会在别人的企业里改错状态。
  const stateOptions = states.map((s) => ({ key: String(s.id), label: s.title, title: `状态 id ${s.id}` }))

  const stateCurrent = states.find((s) => s.id === detail.stateId)
  const stateKey = stateCurrent === undefined ? '' : String(stateCurrent.id)

  const writeBlock = writesEnabled
    ? h(Card, null,
        h(CardTitle, {
          title: '操作',
          note: '直接改，不用切到 Gitee 网页',
          right: write.kind === 'ok' ? h(Pill, { tone: 'ok' }, `${write.what} 已生效`)
            : write.kind === 'busy' ? h(Pill, null, `${write.what} 进行中…`)
              : write.kind === 'error' ? h(Pill, { tone: 'err' }, `${write.what} 失败`)
                : null,
        }),

        // 状态
        h('div', { style: { marginBottom: 10 } },
          h('div', { className: css.gqVFieldLabel, style: { marginBottom: 4 } },
            '状态 ',
            h(StatePill, { state: detail.state, label: STATE_TEXT[detail.state] ?? detail.stateTitle ?? detail.state })),
          stateOptions.length === 0
            ? h(Note, null, h('span', { className: css.gqVWarn },
                `读不到这个工作项类型（id ${detail.typeId}）的可选状态，因此不提供改状态按钮——`
                + '不同企业的状态 id 不一样，猜一个会改错。'))
            : h(Segmented, {
                options: stateOptions,
                value: stateKey,
                disabled: write.kind === 'busy',
                onChange: (key) => {
                  const next = Number(key)
                  if (!Number.isInteger(next) || next === detail.stateId) return
                  void submit('改状态', () => postWrite({ op: 'set-state', ident, stateId: next, sessionId }))
                },
              }),
          stateOptions.length > 0 && stateKey === ''
            ? h(Note, null, '当前状态已不在可选列表里，按最新列表选一个即可。')
            : null,
        ),

        // 改派
        h('div', { style: { marginBottom: 10 } },
          h('div', { className: css.gqVFieldLabel, style: { marginBottom: 4 } },
            `负责人：${detail.owner || '未指派'}`,
            members.length > 0
              ? h('button', {
                  type: 'button',
                  className: css.gqVSegBtn,
                  style: { marginLeft: 8, border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 5 },
                  onClick: () => setShowAssign((v) => !v),
                }, showAssign ? '收起' : '改派')
              : null,
          ),
          showAssign && members.length > 0
            ? h('div', { className: css.gqVList, style: { maxHeight: 160, overflowY: 'auto' } },
                members.map((m) => h('div', {
                  key: m.id,
                  className: `${css.gqVRow} ${css.gqVRowBtn}`,
                  role: 'button',
                  tabIndex: 0,
                  onClick: () => {
                    if (m.id === detail.ownerId) { setShowAssign(false); return }
                    setShowAssign(false)
                    void submit('改派', () => postWrite({ op: 'assign', ident, assigneeId: m.id, sessionId }))
                  },
                },
                  h('span', { className: css.gqVRowKey }, String(m.id)),
                  h('span', { className: css.gqVRowName }, m.name),
                  m.id === detail.ownerId ? h('span', { className: css.gqVRowValue }, '当前') : null,
                )),
              )
            : null,
        ),

        // 评论
        h('div', null,
          h('div', { className: css.gqVFieldLabel, style: { marginBottom: 4 } }, '写评论'),
          h('textarea', {
            className: css.gqVTextarea,
            placeholder: '支持 Markdown。回复同事可以用 > 引用他的原话。',
            value: comment,
            disabled: write.kind === 'busy',
            onChange: (e: { target: { value: string } }) => setComment(e.target.value),
          }),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' } },
            h('button', {
              type: 'button',
              className: `${css.gqVBtn} ${css.gqVBtnPrimary}`,
              disabled: write.kind === 'busy' || comment.trim() === '',
              onClick: () => {
                const body = comment
                void submit('发评论', () => postWrite({ op: 'comment', ident, body, sessionId }))
                  .then(() => setComment(''))
              },
            }, '发布评论'),
            h('span', { className: css.gqVDim }, `${comment.trim().length} 字`),
          ),
        ),

        write.kind === 'error'
          ? h('div', { style: { marginTop: 8 } }, h(ErrorState, { message: `${write.what}失败`, detail: write.message }))
          : null,
      )
    : h(Card, null,
        h(CardTitle, { title: '操作' }),
        h(Empty, null, '本部署关闭了写通道（allowWrites=false）。请到 Gitee 网页操作。'),
      )

  // ── 讨论区 ────────────────────────────────────────────────────────────
  const commentBlock = h(Card, null,
    h(CardTitle, {
      title: '评论中的讨论',
      note: '按时间正序',
      right: h(Pill, null, `${data.commentsTotal} 条`),
    }),
    data.comments.length === 0
      ? h(Empty, null, '还没有评论')
      : h('div', null, data.comments.map((c) =>
          h('div', { key: c.id, className: css.gqVComment },
            h('div', { className: css.gqVCommentHead },
              h('span', { className: css.gqVCommentAuthor }, c.author || '(未知)'),
              h('span', { className: css.gqVCommentTime }, stamp(c.createdAt)),
              c.updatedAt !== '' && c.updatedAt.slice(0, 16) !== c.createdAt.slice(0, 16)
                ? h('span', { className: css.gqVPill }, '已编辑')
                : null,
            ),
            h('div', { className: css.gqVCommentBody }, h(Markdown, { text: c.content, plain: true })),
            c.truncated ? h(Note, null, '（内容过长已截断，完整内容请到 Gitee 查看）') : null,
          ),
        )),
    data.commentsTotal > data.comments.length
      ? h(Note, null, `仅显示最早 ${data.comments.length} 条，共 ${data.commentsTotal} 条。`)
      : null,
  )

  // ── 主体 ──────────────────────────────────────────────────────────────
  return h('div', null,
    h(Card, null,
      h(CardTitle, {
        title: detail.ident,
        note: detail.title,
        right: h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' } },
          detail.priorityHuman === '' ? null : h(Pill, {
            tone: detail.priority >= 3 ? 'err' : undefined,
          }, detail.priorityHuman),
          h(StatePill, { state: detail.state, label: STATE_TEXT[detail.state] ?? detail.stateTitle ?? detail.state }),
          props.onClose === undefined ? null : h('button', { type: 'button', className: css.gqVSegBtn, onClick: props.onClose }, '关闭'),
        ),
      }),
      h('div', { className: css.gqVFields },
        h(Field, { label: '项目' }, detail.programName || String(detail.programId)),
        h(Field, { label: '负责人' }, detail.owner || '未指派'),
        h(Field, { label: '类型' }, detail.typeTitle || '—'),
        h(Field, { label: '作者' }, detail.author || '—'),
        h(Field, { label: '创建' }, day(detail.createdAt)),
        h(Field, { label: '更新' }, day(detail.updatedAt)),
        h(Field, { label: '计划开始' }, day(detail.planStartedAt)),
        h(Field, { label: '实际开始' }, day(detail.startedAt)),
        h(Field, { label: '截止' }, day(detail.deadline)),
        h(Field, { label: '实际完成' }, day(detail.finishedAt)),
        h(Field, { label: '预估 / 已登记工时' },
          detail.estimatedMinutes === 0 && detail.registeredMinutes === 0
            ? h('span', { className: css.gqVWarn }, '未登记')
            : `${(detail.estimatedMinutes / 60).toFixed(1)}h / ${(detail.registeredMinutes / 60).toFixed(1)}h`),
        detail.milestone === null
          ? h(Field, { label: '里程碑' }, h('span', { className: css.gqVDim }, '未关联'))
          : h(Field, { label: '里程碑' }, `${detail.milestone.title}（${day(detail.milestone.dueDate)}）`),
      ),
      detail.labels.length > 0
        ? h('div', { style: { marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' } },
            detail.labels.map((l) => h(Pill, { key: l.name }, l.name)))
        : h(Note, null, '没有任何标签。'),
      detail.parentIdent !== ''
        ? h(Note, null, `父工作项：${detail.parentIdent} ${detail.parentTitle}`)
        : null,
      detail.collaborators.length > 0
        ? h(Note, null, `协作者：${detail.collaborators.join('、')}`)
        : null,
      detail.url === ''
        ? null
        : h(Note, null, h('a', { href: detail.url, target: '_blank', rel: 'noreferrer noopener' }, '在 Gitee 中打开 →')),
    ),

    h('div', { className: css.gqVCols },
      h('div', { className: css.gqVCol },
        h(Card, null,
          h(CardTitle, { title: '描述', note: detail.descriptionType === 'md' ? 'Markdown' : detail.descriptionType }),
          detail.description.trim() === ''
            ? h(Empty, null, '描述为空')
            : h(Markdown, { text: description }),
        ),
        depBlock,
      ),
      h('div', { className: css.gqVCol },
        writeBlock,
        commentBlock,
      ),
    ),
  )
}
