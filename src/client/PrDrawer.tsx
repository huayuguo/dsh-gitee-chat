/**
 * 合并请求详情抽屉（原型 820px `#drawer`）。
 *
 * 4 页：概览 / 变更文件 / 评论 / AI 审核；底部是动作区。
 * **所有写动作都先过二次确认弹窗**（`Dialog`），确认后调 `POST /pr/action`，
 * 成功就用宿主返回的新详情替换本地状态（不做乐观更新，避免和 Gitee 真状态错位）。
 *
 * @module dsh-gitee-chat/client/PrDrawer
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import css from './pr.module.css'
import {
  BQ,
  BranchPair,
  Btn,
  Dialog,
  Drawer,
  ErrBox,
  Kv,
  PCard,
  PCardBd,
  PCardHd,
  PersonLine,
  Skeleton,
  Tag,
  absTime,
  mergePill,
  relTime,
  reviewPill,
  statePill,
  testPill,
} from './prUi.tsx'
import { Markdown } from './ui.tsx'
import { explainError, fetchPrDetail, postPrAction } from './prApi.ts'
import { PrAiPane } from './PrAiPane.tsx'
import type { PrDetail, PrFile } from '../types.ts'

/** 抽屉页签。 */
export type PrPane = 'overview' | 'files' | 'notes' | 'ai'

/** 抽屉里能发起的写动作。 */
export type PrActionKind =
  | 'checkAccept'
  | 'checkReject'
  | 'checkAndTest'
  | 'testAccept'
  | 'merge'
  | 'comment'
  | 'close'
  | 'reopen'
  | 'openCheck'
  | 'openTest'

/** diff 超过这个行数就折叠（五个必备态之一）。 */
const DIFF_FOLD_LINES = 200

/** 待确认的动作。 */
interface Pending {
  kind: PrActionKind
  comment: string
  method: 'merge' | 'squash' | 'rebase'
}

/** 动作的确认文案（标题 / 说明 / 危险按钮）。 */
function actionCopy(kind: PrActionKind): { title: string; lead: string; okLabel: string; danger: boolean } {
  switch (kind) {
    case 'checkAccept':
      return { title: '审核通过这个 PR？', lead: '会把你的审查结论记为「已通过」并写回 Gitee；这一步会通知 PR 作者。', okLabel: '审核通过', danger: false }
    case 'checkReject':
      return { title: '驳回这个 PR？', lead: '会把审查结论记为「已驳回」。建议同时写清要改什么（评论会一起发出去）。', okLabel: '驳回', danger: true }
    case 'checkAndTest':
      return { title: '审核 + 测试一起通过？', lead: '按顺序做两步：先审核通过，再测试通过。任一步失败就停在那一步，不会继续。', okLabel: '两步都通过', danger: false }
    case 'testAccept':
      return { title: '测试通过这个 PR？', lead: '会把测试结论记为「已通过」并写回 Gitee。', okLabel: '测试通过', danger: false }
    case 'merge':
      return { title: '合并这个 PR？', lead: '合并会改动目标分支，通常不可逆（必要时只能靠新提交回滚）。', okLabel: '合并', danger: true }
    case 'comment':
      return { title: '发表评论？', lead: '评论会以你的身份发到这个 PR 上，作者与审查人都会收到通知。', okLabel: '发表评论', danger: false }
    case 'close':
      return { title: '关闭这个 PR？', lead: '关闭后 PR 不再接受合并；之后还可以重新打开。', okLabel: '关闭', danger: true }
    case 'reopen':
      return { title: '重新打开这个 PR？', lead: '重新打开后 PR 会回到待审查 / 待测试状态。', okLabel: '重新打开', danger: false }
    case 'openCheck':
      return { title: '开启审核流程？', lead: '只把审查状态置为「待审查」；请确认这个 PR 已经指派了审查人，否则没人会收到待办。', okLabel: '开启审核', danger: false }
    case 'openTest':
      return { title: '开启测试流程？', lead: '只把测试状态置为「待测试」；请确认已经指派了测试人。', okLabel: '开启测试', danger: false }
  }
}

/** 抽屉主体。 */
export function PrDrawer(props: {
  sessionId: string
  repoId: number
  iid: number
  pane: PrPane
  onPaneChange: (pane: PrPane) => void
  /** 深链 `#pr&act=merge` 之类进来时自动拉起的动作（只消费一次）。 */
  initialAction?: PrActionKind | null
  onClose: () => void
  /** 详情变化后通知外层刷新列表 / 计数。 */
  onChanged: () => void
}) {
  const [detail, setDetail] = useState<PrDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<{ message: string; hint: string; code: string } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<{ message: string; hint: string; code: string } | null>(null)
  const [consumedAction, setConsumedAction] = useState<PrActionKind | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError(null)
    fetchPrDetail(props.sessionId, props.repoId, props.iid, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return
        setDetail(next)
        setLoading(false)
      })
      .catch((cause) => {
        if ((cause as Error | undefined)?.name === 'AbortError') return
        setLoadError(explainError(cause))
        setLoading(false)
      })
    return () => controller.abort()
  }, [props.sessionId, props.repoId, props.iid, reloadKey])

  const reload = () => {
    setReloadKey((key) => key + 1)
    props.onChanged()
  }

  // 深链动作：详情到位后只拉起一次确认弹窗。
  useEffect(() => {
    const want = props.initialAction
    if (want === null || want === undefined || detail === null) return
    if (consumedAction === want) return
    setConsumedAction(want)
    setPending({ kind: want, comment: '', method: 'merge' })
  }, [props.initialAction, detail, consumedAction])

  /** 执行确认后的写动作。 */
  const run = async (target: Pending) => {
    if (detail === null) return
    setBusy(true)
    setActionError(null)
    const base = { repoId: detail.repoId, iid: detail.iid }
    const comment = target.comment.trim()
    try {
      let next: PrDetail
      switch (target.kind) {
        case 'checkAccept':
          next = await postPrAction(props.sessionId, {
            action: 'check', ...base, mode: 'accept', ...(comment === '' ? {} : { comment }),
          })
          break
        case 'checkReject':
          next = await postPrAction(props.sessionId, {
            action: 'check', ...base, mode: 'reject', ...(comment === '' ? {} : { comment }),
          })
          break
        case 'checkAndTest':
          // 第一步成功才做第二步；第二步的详情已包含第一步的结果。
          await postPrAction(props.sessionId, {
            action: 'check', ...base, mode: 'accept', ...(comment === '' ? {} : { comment }),
          })
          next = await postPrAction(props.sessionId, { action: 'test', ...base })
          break
        case 'testAccept':
          next = await postPrAction(props.sessionId, { action: 'test', ...base, ...(comment === '' ? {} : { comment }) })
          break
        case 'merge':
          next = await postPrAction(props.sessionId, { action: 'merge', ...base, method: target.method })
          break
        case 'comment': {
          if (comment === '') throw new Error('评论不能为空。')
          next = await postPrAction(props.sessionId, { action: 'comment', ...base, body: comment })
          break
        }
        case 'close':
          next = await postPrAction(props.sessionId, { action: 'state', ...base, event: 'close' })
          break
        case 'reopen':
          next = await postPrAction(props.sessionId, { action: 'state', ...base, event: 'reopen' })
          break
        case 'openCheck':
          next = await postPrAction(props.sessionId, { action: 'openCheck', ...base })
          break
        case 'openTest':
          next = await postPrAction(props.sessionId, { action: 'openTest', ...base })
          break
      }
      setDetail(next)
      setPending(null)
      props.onChanged()
    } catch (cause) {
      setActionError(explainError(cause))
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    if (busy) return
    props.onClose()
  }

  if (loading) {
    return (
      <Drawer lead={`${props.repoId} · !${props.iid}`} title="正在读取 PR 详情…" onClose={close}>
        <Skeleton rows={6} rowHeight={22} />
      </Drawer>
    )
  }

  if (loadError !== null || detail === null) {
    return (
      <Drawer lead={`${props.repoId} · !${props.iid}`} title="PR 详情读取失败" onClose={close}>
        <ErrBox
          message={loadError?.message ?? '没有拿到详情。'}
          hint={loadError?.hint ?? ''}
          code={loadError?.code}
          onRetry={reload}
          retryLabel="重试"
        />
      </Drawer>
    )
  }

  const auth = detail.auth
  const opened = detail.state === 'opened'
  const canCheck = opened && auth?.canCheck === true
  const canTest = opened && auth?.canTest === true
  const canMerge = opened && auth?.canMerge === true && detail.mergeable
  const pendingClean = detail.checkState === 1 && detail.testState === 1

  const footer: ReactNode[] = []
  if (!opened) {
    footer.push(<span key="hint" className={css.gqPrDwHint}>
      {detail.state === 'merged' ? '已合并：只读。' : '已关闭：只读。'}
    </span>)
    if (auth?.canReopen === true) {
      footer.push(<Btn key="reopen" onClick={() => setPending({ kind: 'reopen', comment: '', method: 'merge' })}>重新打开…</Btn>)
    }
  } else {
    footer.push(<span key="hint" className={css.gqPrDwHint}>写动作都要过二次确认；按钮只按 token 真实权限出现</span>)
    if (detail.checkState === 0) {
      footer.push(<Btn key="openCheck" onClick={() => setPending({ kind: 'openCheck', comment: '', method: 'merge' })} disabled={auth?.update !== true}>开启审核流程…</Btn>)
    }
    if (detail.testState === 0) {
      footer.push(<Btn key="openTest" onClick={() => setPending({ kind: 'openTest', comment: '', method: 'merge' })} disabled={auth?.update !== true}>开启测试流程…</Btn>)
    }
    if (detail.checkState === 1) {
      footer.push(<Btn key="reject" tone="danger" onClick={() => setPending({ kind: 'checkReject', comment: '', method: 'merge' })} disabled={!canCheck}>驳回…</Btn>)
    }
    if (pendingClean && canCheck && canTest) {
      footer.push(<Btn key="both" tone="primary" onClick={() => setPending({ kind: 'checkAndTest', comment: '', method: 'merge' })}>审核+测试通过…</Btn>)
    } else {
      if (detail.checkState === 1) {
        footer.push(<Btn key="check" tone="primary" onClick={() => setPending({ kind: 'checkAccept', comment: '', method: 'merge' })} disabled={!canCheck}>审核通过…</Btn>)
      }
      if (detail.testState === 1) {
        footer.push(<Btn key="test" onClick={() => setPending({ kind: 'testAccept', comment: '', method: 'merge' })} disabled={!canTest}>测试通过…</Btn>)
      }
    }
    if (detail.mergeable) {
      footer.push(<Btn key="merge" tone="danger" onClick={() => setPending({ kind: 'merge', comment: '', method: 'merge' })} disabled={!canMerge} title={canMerge ? '合并这个 PR' : '当前 token 没有合并权限'}>合并…</Btn>)
    }
    if (auth?.canClose === true) {
      footer.push(<Btn key="close" onClick={() => setPending({ kind: 'close', comment: '', method: 'merge' })}>关闭</Btn>)
    }
  }

  const stateTag = statePill(detail.state)
  const review = reviewPill(detail.checkState, detail.checkPassed, detail.prAssignNum)
  const test = testPill(detail.testState, detail.testPassed, detail.prTestNum)
  const merge = mergePill(detail.mergeable)

  const meta: ReactNode = (
    <>
      <Tag tone={stateTag.tone}>{stateTag.label}</Tag>
      {detail.draft ? <Tag tone="muted">草稿</Tag> : null}
      <Tag tone={review.tone}>{review.label}</Tag>
      <Tag tone={test.tone}>{test.label}</Tag>
      <Tag tone={merge.tone}>{merge.label}</Tag>
      {auth?.forceChecked === true || auth?.forceTested === true ? <Tag tone="warn">需强制</Tag> : null}
      <span className={css.gqPrRowStat}>{detail.repoPath} · 更新于 {relTime(detail.updatedAt)}</span>
    </>
  )

  const tabs = [
    { key: 'overview', label: '概览' },
    { key: 'files', label: '变更文件', count: detail.files.length },
    { key: 'notes', label: '评论', count: detail.comments.length },
    { key: 'ai', label: 'AI 审核' },
  ] as const

  return (
    <>
      <Drawer
        lead={`${detail.repoPath} · !${detail.iid}`}
        title={detail.title}
        meta={meta}
        tabs={tabs.map((item) => ({ key: item.key, label: item.label, count: 'count' in item ? item.count : undefined }))}
        tab={props.pane}
        onTab={(key) => props.onPaneChange(key as PrPane)}
        footer={footer}
        onClose={close}
      >
        {auth === null
          ? (
            <div style={{ marginBottom: 12 }}>
              <BQ tone="warn">
                权限未知：{detail.authHint === '' ? '宿主没拿到你的审查/合并权限。' : detail.authHint}
                。写按钮会保持不可用（不做角色推断）。
              </BQ>
            </div>
          )
          : null}
        {props.pane === 'overview' ? <OverviewPane detail={detail} /> : null}
        {props.pane === 'files' ? <FilesPane files={detail.files} /> : null}
        {props.pane === 'notes' ? (
          <NotesPane
            detail={detail}
            onComment={(body) => setPending({ kind: 'comment', comment: body, method: 'merge' })}
          />
        ) : null}
        {props.pane === 'ai' ? (
          <PrAiPane
            sessionId={props.sessionId}
            detail={detail}
            onOpenCheck={() => setPending({ kind: 'openCheck', comment: '', method: 'merge' })}
            onRequestReject={(comment) => setPending({ kind: 'checkReject', comment, method: 'merge' })}
            onRequestAccept={(comment) => setPending({ kind: 'checkAccept', comment, method: 'merge' })}
            onDispatched={reload}
          />
        ) : null}
      </Drawer>
      {pending === null ? null : (
        <ActionDialog
          pending={pending}
          detail={detail}
          busy={busy}
          error={actionError}
          onChange={(next) => setPending(next)}
          onCancel={() => {
            if (busy) return
            setPending(null)
            setActionError(null)
          }}
          onConfirm={() => void run(pending)}
        />
      )}
    </>
  )
}

/** 概览页：基本信息 + 正文。 */
function OverviewPane(props: { detail: PrDetail }) {
  const detail = props.detail
  const people = (list: readonly { id: number; name: string; username: string; state: 0 | 1 | 2 }[]): ReactNode =>
    list.length === 0
      ? <span className={css.gqPrRowStat}>未指派</span>
      : <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 8 }}>{list.map((person) => <PersonLine key={person.id} person={person} />)}</span>

  return (
    <>
      <PCard>
        <PCardHd title="基本信息" sub={`全局 id ${detail.id} · ${detail.commitsCount} 个提交`} />
        <PCardBd>
          <Kv
            rows={[
              ['仓库', <span className={css.gqPrTplName} key="repo">{detail.repoPath}</span>],
              ['分支', <BranchPair key="br" from={detail.sourceBranch} to={detail.targetBranch} />],
              ['作者', <PersonLine key="author" person={detail.author} />],
              ['审查人', people(detail.assignees)],
              ['测试人', people(detail.testers)],
              ['审查状态', <Tag key="ck" tone={reviewPill(detail.checkState, detail.checkPassed, detail.prAssignNum).tone}>{reviewPill(detail.checkState, detail.checkPassed, detail.prAssignNum).label}</Tag>],
              ['测试状态', <Tag key="ts" tone={testPill(detail.testState, detail.testPassed, detail.prTestNum).tone}>{testPill(detail.testState, detail.testPassed, detail.prTestNum).label}</Tag>],
              ['最近更新', absTime(detail.updatedAt)],
              ['地址', <a key="url" href={detail.url} target="_blank" rel="noreferrer" className={css.gqPrTplName}>在 Gitee 打开</a>],
            ]}
          />
        </PCardBd>
      </PCard>
      <PCard>
        <PCardHd title="PR 说明" sub={detail.body.trim() === '' ? '作者没写说明' : undefined} />
        <PCardBd>
          {detail.body.trim() === ''
            ? <div className={css.gqPrRowSub}>（没有说明。可以让作者补一段「改了什么、为什么」。）</div>
            : <div className={css.gqPrCmtBody}><Markdown text={detail.body} /></div>}
        </PCardBd>
      </PCard>
    </>
  )
}

/** 变更文件页：每文件一块，超过 200 行折叠。 */
function FilesPane(props: { files: readonly PrFile[] }) {
  if (props.files.length === 0) {
    return <div className={css.gqPrRowSub}>宿主没有返回变更文件（可能是权限不足，或这个 PR 只有提交信息）。</div>
  }
  return (
    <>
      <div className={css.gqPrRowSub} style={{ marginBottom: 8 }}>
        共 {props.files.length} 个文件；单个文件超过 {DIFF_FOLD_LINES} 行自动折叠。
      </div>
      {props.files.map((file) => <FileBlock key={file.filename} file={file} />)}
    </>
  )
}

/** 单个文件的 diff。 */
function FileBlock(props: { file: PrFile }) {
  const file = props.file
  const lines = useMemo(() => (file.diff === '' ? [] : file.diff.split('\n')), [file.diff])
  const [expanded, setExpanded] = useState(false)
  const folded = lines.length > DIFF_FOLD_LINES && !expanded
  const shown = folded ? lines.slice(0, DIFF_FOLD_LINES) : lines
  const pill = fileStatusPillSafe(file.status)

  return (
    <section className={css.gqPrFile}>
      <header className={css.gqPrFileHd}>
        <Tag tone={pill.tone}>{pill.label}</Tag>
        <span className={css.gqPrFileName} title={file.filename}>{file.filename}</span>
        <span className={css.gqPrFileStat}>
          <span style={{ color: 'var(--gq-ok)' }}>+{file.additions}</span>{' '}
          <span style={{ color: 'var(--gq-danger)' }}>−{file.deletions}</span>
        </span>
      </header>
      {lines.length === 0
        ? <div className={css.gqPrDiffLine}>（宿主没返回这个文件的 diff 文本）</div>
        : (
          <pre className={css.gqPrDiff}>
            {shown.map((line, index) => (
              <span key={index} className={`${css.gqPrDiffLine} ${diffLineClass(line)}`}>{line === '' ? ' ' : line}</span>
            ))}
          </pre>
        )}
      {lines.length > DIFF_FOLD_LINES && !expanded
        ? (
          <div className={css.gqPrDiffFoot}>
            <Btn size="sm" onClick={() => setExpanded(true)}>
              展开全部（共 {lines.length} 行，已显示前 {DIFF_FOLD_LINES} 行）
            </Btn>
          </div>
        )
        : null}
      {expanded && lines.length > DIFF_FOLD_LINES
        ? <div className={css.gqPrDiffFoot}><Btn size="sm" onClick={() => setExpanded(false)}>收起</Btn></div>
        : null}
    </section>
  )
}

/** diff 行 → 样式类（+/-/hunk）。 */
function diffLineClass(line: string): string {
  if (line.startsWith('@@')) return css.gqPrDiffHunk
  if (line.startsWith('+')) return css.gqPrDiffAdd
  if (line.startsWith('-')) return css.gqPrDiffDel
  return ''
}

/** 文件状态的胶囊（本地兜底，避免循环依赖时拿不到）。 */
function fileStatusPillSafe(status: PrFile['status']): { tone: 'ok' | 'danger' | 'info' | 'warn' | 'muted'; label: string } {
  switch (status) {
    case 'added': return { tone: 'ok', label: '新增' }
    case 'deleted': return { tone: 'danger', label: '删除' }
    case 'renamed': return { tone: 'info', label: '改名' }
    default: return { tone: 'muted', label: '修改' }
  }
}

/** 评论页。 */
function NotesPane(props: { detail: PrDetail; onComment: (body: string) => void }) {
  const [draft, setDraft] = useState('')
  return (
    <>
      <PCard>
        <PCardHd title="评论" sub={`${props.detail.comments.length} 条`} />
        <PCardBd>
          {props.detail.comments.length === 0
            ? <div className={css.gqPrRowSub}>还没有评论。建议首条评论写清「改了什么、怎么看、要验证什么」。</div>
            : props.detail.comments.map((comment) => (
              <article key={comment.id} className={css.gqPrCmt}>
                <header className={css.gqPrCmtHd}>
                  <span className={css.gqPrCmtWho}>{comment.author?.name ?? '（未知）'}</span>
                  <span>@{comment.author?.username ?? 'unknown'}</span>
                  <span>{relTime(comment.createdAt)}</span>
                </header>
                <div className={css.gqPrCmtBody}><Markdown text={comment.body} /></div>
              </article>
            ))}
          <div className={css.gqPrCmtForm}>
            <textarea
              className={`${css.gqPrInput} ${css.gqPrTextarea}`}
              placeholder="写一条评论（会以你的身份发出）"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
            />
            <div className={css.gqPrCmtActions}>
              <Btn
                tone="primary"
                disabled={draft.trim() === ''}
                onClick={() => { props.onComment(draft.trim()); setDraft('') }}
              >
                发表评论…
              </Btn>
            </div>
          </div>
        </PCardBd>
      </PCard>
    </>
  )
}

/** 动作的二次确认弹窗。 */
function ActionDialog(props: {
  pending: Pending
  detail: PrDetail
  busy: boolean
  error: { message: string; hint: string; code: string } | null
  onChange: (next: Pending) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const copy = actionCopy(props.pending.kind)
  const detail = props.detail
  const needsComment = props.pending.kind === 'checkReject' || props.pending.kind === 'comment'
  const rows: Array<[ReactNode, ReactNode]> = [
    ['PR', <span key="pr" className={css.gqPrTplName}>{detail.repoPath} !{detail.iid}</span>],
    ['标题', detail.title],
    ['当前状态', `${statePill(detail.state).label} · ${reviewPill(detail.checkState, detail.checkPassed, detail.prAssignNum).label} · ${testPill(detail.testState, detail.testPassed, detail.prTestNum).label}`],
  ]
  if (props.pending.kind === 'merge') rows.push(['合并方式', mergeMethodSelect(props.pending, props.onChange)])
  const note = props.pending.kind === 'merge' && detail.mergeable === false
    ? '这个 PR 目前不满足合并条件（审查或测试未通过）。'
    : undefined

  return (
    <Dialog
      open
      title={copy.title}
      lead={copy.lead}
      rows={rows}
      note={note}
      okLabel={copy.okLabel}
      okTone={copy.danger ? 'danger' : 'primary'}
      busy={props.busy}
      error={props.error}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    >
      {needsComment
        ? (
          <textarea
            className={`${css.gqPrInput} ${css.gqPrTextarea}`}
            placeholder={props.pending.kind === 'comment' ? '评论正文（必填）' : '驳回理由（可选，建议写清要改什么）'}
            value={props.pending.comment}
            onChange={(event) => props.onChange({ ...props.pending, comment: event.target.value })}
          />
        )
        : null}
    </Dialog>
  )
}

/** 合并方式选择。 */
function mergeMethodSelect(pending: Pending, onChange: (next: Pending) => void): ReactNode {
  return (
    <select
      className={css.gqPrInput}
      value={pending.method}
      onChange={(event) => onChange({ ...pending, method: event.target.value === 'squash' || event.target.value === 'rebase' ? event.target.value : 'merge' })}
    >
      <option value="merge">merge · 保留提交历史，生成合并提交</option>
      <option value="squash">squash · 压成一个提交</option>
      <option value="rebase">rebase · 变基后快进（历史线性）</option>
    </select>
  )
}
