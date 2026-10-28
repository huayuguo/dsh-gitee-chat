/**
 * 抽屉第 4 页：AI 审核。
 *
 * 契约（`docs/design/0.5.4-api.md`）：`POST /pr/ai-review` **只渲染 prompt**，
 * 投递走宿主的子智能体跑批：勾选 = 纯后台，取消勾选 = 结论同时落进主会话
 * （DSH 的 `delivery: 'parent'` 会往那个会话追加一条结算消息），两条都回面板。
 * 结论不是一个接口，而是智能体在会话里干完活后**写回 PR 评论**；
 * 所以这里从评论里找最近一条 AI 结论并渲染（找不到就说明为什么还没有）。
 *
 * @module dsh-gitee-chat/client/PrAiPane
 */

import { useEffect, useState, type ReactNode } from 'react'
import css from './pr.module.css'
import { BQ, Btn, Dialog, ErrBox, PCard, PCardBd, PCardHd, PillCheck, Skeleton, Tag, absTime, relTime } from './prUi.tsx'
import { Markdown } from './ui.tsx'
import { explainError, fetchPrTemplates, savePrTemplate } from './prApi.ts'
import { cancelPrAiRun, fetchPrAiRun, startPrAiRun, type PrAiRun } from './prApi.ts'
import { fetchDraftTarget, fetchSessions, saveDraftTarget, sessionLabel, type SessionChoice } from './prApi.ts'
import type { PrComment, PrDetail, PrTemplatesResponse } from '../types.ts'

/** 审核模板（宿主内置 review / test 两份）。 */
type TemplateKind = 'review' | 'test'

/** 审核范围。 */
type ScopeKind = 'full' | 'code-only' | 'files'

/** 从评论里抽出来的 AI 结论。 */
interface Conclusion {
  comment: PrComment
  counts: { blocker: number; major: number; minor: number; nit: number } | null
}

const CONCLUSION_PATTERN = /(ai\s*审核结论|##\s*结论|结论\s*[:：])/i

/** 在评论里找最近一条 AI 结论（智能体的活干完后写回评论）。 */
function findConclusion(comments: readonly PrComment[]): Conclusion | null {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i]
    if (comment === undefined || !CONCLUSION_PATTERN.test(comment.body)) continue
    const count = (word: string): number => {
      const match = new RegExp(`${word}\\s*[:：]?\\s*(\\d+)`, 'i').exec(comment.body)
      return match === null ? 0 : Number(match[1])
    }
    const any = /blocker|major|minor|nit/i.test(comment.body)
    return {
      comment,
      counts: any ? { blocker: count('blocker'), major: count('major'), minor: count('minor'), nit: count('nit') } : null,
    }
  }
  return null
}

/** AI 审核页。 */
export function PrAiPane(props: {
  sessionId: string
  detail: PrDetail
  /** 「仅开启审核流程」（走父组件的确认弹窗）。 */
  onOpenCheck: () => void
  /** 「提交评论并驳回」/「忽略结论直接审核通过」交给父组件（同样要过确认弹窗）。 */
  onRequestReject: (comment: string) => void
  onRequestAccept: (comment: string) => void
  /** 投递成功后刷新详情（评论要过一会儿才到）。 */
  onDispatched: () => void
}) {
  const detail = props.detail
  const [templates, setTemplates] = useState<PrTemplatesResponse | null>(null)
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [template, setTemplate] = useState<TemplateKind>(detail.checkState === 0 && detail.testState !== 0 ? 'test' : 'review')
  const [scope, setScope] = useState<ScopeKind>('full')
  const [files, setFiles] = useState<string[]>([])
  const [autoApprove, setAutoApprove] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; hint: string; code: string } | null>(null)
  const [prompt, setPrompt] = useState<string | null>(null)
  /** 子智能体跑批（0.5.4：审核在所选主会话的**子智能体**里跑，不往主会话插消息）。 */
  const [run, setRun] = useState<PrAiRun | null>(null)
  const [runId, setRunId] = useState('')
  const [sendHint, setSendHint] = useState<string | null>(null)
  /**
   * 投递目标会话（默认当前会话）。
   *
   * 用户 2026-10-26 口径：PR 可能属于不同仓库、不同工作区，
   * 「用当前会话还是别的会话」要在弹窗里能选，不能写死。
   */
  const [targets, setTargets] = useState<SessionChoice[]>([])
  const [target, setTarget] = useState<string>(props.sessionId)
  /** 勾选「子智能体」：与工作区/会话一起按仓库记住（用户口径 2026-10-27）。 */
  const [useSubagent, setUseSubagent] = useState(true)
  const [draft, setDraft] = useState('')
  // 模板编辑（用户要求「UI 可看可改」）：改完存成用户副本，可只绑当前仓库的那一种模板
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editText, setEditText] = useState('')
  const [editBind, setEditBind] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveHint, setSaveHint] = useState<string | null>(null)

  const loadTemplates = (signal?: AbortSignal) => {
    setTemplateError(null)
    fetchPrTemplates(detail.repoPath, signal)
      .then((body) => { if (signal?.aborted !== true) setTemplates(body) })
      .catch((cause) => {
        if ((cause as Error | undefined)?.name === 'AbortError') return
        setTemplateError(explainError(cause).message)
      })
  }

  useEffect(() => {
    const controller = new AbortController()
    setTemplates(null)
    loadTemplates(controller.signal)
    return () => controller.abort()
  }, [detail.repoPath])

  /** 打开编辑器：预填当前生效的那份模板正文与名字。 */
  const openEditor = () => {
    setSaveHint(null)
    setEditName(templates?.activeName[template] ?? template)
    setEditText(templates?.active[template] ?? '')
    setEditBind(detail.repoPath !== '')
    setEditing(true)
  }

  /** 保存：存成用户副本；勾了「绑定到本仓库」就只绑当前这一种模板。 */
  const saveEditor = async () => {
    setSaving(true)
    setSaveHint(null)
    try {
      await savePrTemplate({
        name: editName.trim(),
        content: editText,
        ...(editBind && detail.repoPath !== '' ? { repoPath: detail.repoPath, kind: template } : {}),
      })
      setSaveHint('已保存。')
      setEditing(false)
      loadTemplates()
    } catch (cause) {
      setSaveHint(explainError(cause).message)
    } finally {
      setSaving(false)
    }
  }

  const conclusion = findConclusion(detail.comments)
  const templateName = template === 'review' ? templates?.activeName.review : templates?.activeName.test
  const canDispatch = detail.state === 'opened' && (scope !== 'files' || files.length > 0)

  /** 弹窗打开时拉一次活着的会话清单（失败就只留「当前会话」）+ 该仓库记住的投递目标。 */
  useEffect(() => {
    if (!confirming) return
    const controller = new AbortController()
    fetchSessions(controller.signal)
      .then((items) => { if (!controller.signal.aborted) setTargets(items) })
      .catch(() => { if (!controller.signal.aborted) setTargets([]) })
    const repoKey = detail.repoPath
    if (repoKey !== '') {
      fetchDraftTarget(repoKey, controller.signal)
        .then((saved) => {
          if (controller.signal.aborted || saved === null) return
          setTarget(saved.sessionId)
          setUseSubagent(saved.deliverSubagent)
        })
        .catch(() => undefined)
    }
    return () => controller.abort()
  }, [confirming, detail.repoPath])

  /** 渲染 prompt 并投递给会话。 */
  const dispatch = async () => {
    setBusy(true)
    setError(null)
    setSendHint(null)
    try {
      // 目标会话：弹窗选择 → 当前会话 → 会话清单第一个。空串会让宿主直接拒绝
      // （子智能体必须挂在活着的会话下），所以先把兜底算好。
      const effective = target === '' ? (props.sessionId !== '' ? props.sessionId : (targets[0]?.id ?? '')) : target
      const chosen = targets.find((item) => item.id === effective)
      // 记住这次的选择（工作区 + 会话 + 勾选状态）：下次打开同一个仓库的审核弹窗自动带出
      if (detail.repoPath !== '' && effective !== '') {
        void saveDraftTarget(detail.repoPath, {
          sessionId: effective,
          sessionTitle: chosen?.title ?? '',
          workspaceTitle: chosen?.workspaceTitle ?? '',
          deliverSubagent: useSubagent,
        }).catch(() => undefined)
      }
      // 两条投递路径同一个跑批：勾选 = 纯后台（caller），
      // 取消勾选 = 结论同时落进主会话（parent），也照旧回面板供人确认。
      const started = await startPrAiRun(
        effective,
        {
          repoId: detail.repoId,
          iid: detail.iid,
          template,
          scope,
          ...(scope === 'files' ? { files } : {}),
          autoApprove,
        },
        undefined,
        useSubagent ? undefined : 'session',
      )
      setPrompt(started.prompt)
      setRun({
        runId: started.runId,
        childId: started.childId,
        status: 'running',
        text: '',
        stopReason: '',
        error: '',
        createdAt: Date.now(),
        finishedAt: null,
      })
      setRunId(started.runId)
      setConfirming(false)
      props.onDispatched()
    } catch (cause) {
      setError(explainError(cause))
    } finally {
      setBusy(false)
    }
  }

  /** 轮询跑批状态：跑完把结论摆到右侧，人再决定通过/驳回。 */
  useEffect(() => {
    if (runId === '') return
    const controller = new AbortController()
    let stopped = false
    const tick = async (): Promise<void> => {
      try {
        const next = await fetchPrAiRun(runId, controller.signal)
        if (stopped || next === null) return
        setRun(next)
        if (next.status !== 'running') {
          setRunId('')
          if (next.status === 'done') props.onDispatched()
        }
      } catch (cause) {
        if ((cause as Error | undefined)?.name === 'AbortError') return
        setSendHint(`查询子智能体状态失败：${explainError(cause).message}`)
      }
    }
    void tick()
    const timer = setInterval(() => { void tick() }, 2500)
    return () => { stopped = true; controller.abort(); clearInterval(timer) }
  }, [runId])

  /** 复制 prompt（浏览器不支持剪贴板时提示手选）。 */
  const copyPrompt = () => {
    if (prompt === null) return
    void (async () => {
      try {
        await navigator.clipboard.writeText(prompt)
        setSendHint('已复制到剪贴板。')
      } catch {
        setSendHint('浏览器不允许写剪贴板：请在上面的 prompt 框里全选复制。')
      }
    })()
  }

  const left = (
    <PCard>
      <PCardHd title="发起 AI 审核" sub="宿主只渲染 prompt；投递由本页发到当前会话，结论由智能体写回 PR 评论。" />
      <PCardBd>
        <div className={css.gqPrAiBlock}>
          <div>
            <div className={css.gqPrAiLabel}>
              审核模板
              <button type="button" className={css.gqPrLinkBtn} onClick={openEditor}>{editing ? '编辑中…' : '编辑模板'}</button>
            </div>
            {templateError !== null
              ? <ErrBox message={templateError} hint="模板读不到不影响发起：宿主会用内置模板渲染。" />
              : templates === null
                ? <Skeleton rows={2} rowHeight={30} />
                : (
                  <div className={css.gqPrAiTpl}>
                    <TemplateChip
                      active={template === 'review'}
                      name={templates.activeName.review}
                      note={`${templates.active.review.split('\n')[0]?.slice(0, 48) ?? '审核模板'}`}
                      onPick={() => setTemplate('review')}
                    />
                    <TemplateChip
                      active={template === 'test'}
                      name={templates.activeName.test}
                      note={`${templates.active.test.split('\n')[0]?.slice(0, 48) ?? '测试模板'}`}
                      onPick={() => setTemplate('test')}
                    />
                    <div className={css.gqPrRowSub}>
                      {templates.items.length} 个模板可用：
                      {templates.items.map((item) => (
                        <Tag key={`${item.source}-${item.path}`} mono title={item.path}>{item.name}</Tag>
                      ))}
                    </div>
                  </div>
                )}
          </div>

          {editing
            ? (
              <div>
                <div className={css.gqPrAiLabel}>编辑「{template === 'review' ? '审核' : '测试'}」模板</div>
                <div className={css.gqPrTplEdit}>
                  <div className={css.gqPrRowSub}>保存后成为用户副本（`$DSH_HOME/.gitee-chat/templates/`），内置模板永不被覆盖。</div>
                  <label className={css.gqPrEditRow}>
                    <span>模板名</span>
                    <input
                      className={css.gqPrInput}
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                      placeholder="例如 team-review"
                    />
                  </label>
                  <textarea
                    className={css.gqPrTplArea}
                    value={editText}
                    onChange={(event) => setEditText(event.target.value)}
                    rows={14}
                    spellCheck={false}
                  />
                  <label className={css.gqPrRadioRow}>
                    <input
                      type="checkbox"
                      checked={editBind}
                      disabled={detail.repoPath === ''}
                      onChange={(event) => setEditBind(event.target.checked)}
                    />
                    <span>
                      绑定到本仓库（{detail.repoPath === '' ? '仓库未知' : detail.repoPath}）的
                      {template === 'review' ? '审核' : '测试'}模板
                    </span>
                  </label>
                  {saveHint === null ? null : <div className={css.gqPrRowSub}>{saveHint}</div>}
                  <div className={css.gqPrRow}>
                    <Btn kind="primary" onClick={() => void saveEditor()} disabled={saving || editName.trim() === '' || editText.trim() === ''}>
                      {saving ? '保存中…' : '保存模板'}
                    </Btn>
                    <Btn onClick={() => setEditing(false)}>取消</Btn>
                  </div>
                </div>
              </div>
            )
            : null}

          <div>
            <div className={css.gqPrAiLabel}>审核范围</div>
            <label className={css.gqPrRadioRow}>
              <input type="radio" name="gq-pr-ai-scope" checked={scope === 'full'} onChange={() => setScope('full')} />
              <span>全量（说明 + 全部文件）</span>
            </label>
            <label className={css.gqPrRadioRow}>
              <input type="radio" name="gq-pr-ai-scope" checked={scope === 'code-only'} onChange={() => setScope('code-only')} />
              <span>仅业务代码（跳过文档 / 配置 / 锁文件）</span>
            </label>
            <label className={css.gqPrRadioRow}>
              <input type="radio" name="gq-pr-ai-scope" checked={scope === 'files'} onChange={() => setScope('files')} />
              <span>指定文件</span>
            </label>
            {scope !== 'files' ? null : detail.files.length === 0
              ? <BQ>这个 PR 没有可选的变更文件。</BQ>
              : (
                <div className={css.gqPrAiTpl} style={{ marginTop: 6 }}>
                  {detail.files.map((file) => (
                    <label key={file.filename} className={css.gqPrRadioRow}>
                      <input
                        type="checkbox"
                        checked={files.includes(file.filename)}
                        onChange={(event) => {
                          setFiles((prev) => event.target.checked
                            ? [...prev, file.filename]
                            : prev.filter((name) => name !== file.filename))
                        }}
                      />
                      <span className={css.gqPrTplName}>{file.filename}</span>
                    </label>
                  ))}
                </div>
              )}
          </div>

          <div>
            <div className={css.gqPrAiLabel}>模型与结论</div>
            <div className={css.gqPrRowSub}>模型跟随当前会话，不在本页另选。</div>
            <div className={css.gqPrSwitchRow}>
              <span>允许 AI 在结论为「通过」时自动审核通过</span>
              <label className={css.gqPrSwitch}>
                <input type="checkbox" checked={autoApprove} onChange={(event) => setAutoApprove(event.target.checked)} />
                <span className={css.gqPrSwitchTrack} />
              </label>
            </div>
            <BQ tone={autoApprove ? 'warn' : undefined}>
              {autoApprove
                ? '已打开自动通过：AI 结论为「通过」时会**直接**调用审核通过，不再经过二次确认。请确认你信任这个模板的判定。'
                : '默认关闭：AI 只产出结论与评论，通过/驳回仍要你自己点（所有写动作都要过确认弹窗）。'}
            </BQ>
          </div>

          {error === null ? null : <ErrBox message={error.message} hint={error.hint} code={error.code} />}
          {sendHint === null ? null : <BQ tone="warn">{sendHint}</BQ>}
          {run === null ? null : run.status === 'running'
            ? (
              <BQ>
                已在所选会话下起子智能体（run {run.runId.slice(-6)} · 子会话 {run.childId.slice(-6)}）跑模板，不往主会话插消息。
                跑完结论出现在右侧，你确认后再写回 PR。
                <button
                  type="button"
                  className={css.gqPrLinkBtn}
                  onClick={() => {
                    void cancelPrAiRun(run.runId).catch(() => undefined)
                    setRunId('')
                    setRun({ ...run, status: 'failed', error: '被使用者取消。' })
                  }}
                >
                  取消
                </button>
              </BQ>
            )
            : run.status === 'failed'
              ? <BQ tone="warn">子智能体没有跑完：{run.error === '' ? '未知原因' : run.error}</BQ>
              : <BQ tone="ok">子智能体已给出结论（{run.stopReason === '' ? '完成' : run.stopReason}），在右侧确认后再写回 PR 评论。</BQ>}

          <div className={css.gqPrAiActions}>
            <Btn tone="primary" onClick={() => setConfirming(true)} disabled={!canDispatch || busy}>
              发起 AI 审核…
            </Btn>
            <Btn onClick={props.onOpenCheck} disabled={detail.state !== 'opened' || busy}>仅开启审核流程…</Btn>
            <Btn onClick={props.onDispatched} disabled={busy}>刷新详情</Btn>
          </div>
          {canDispatch ? null : <div className={css.gqPrErrHint}>指定文件范围时至少勾一个文件。</div>}
        </div>
      </PCardBd>
    </PCard>
  )

  const right = (
    <PCard>
      <PCardHd
        title="AI 审核结论"
        sub={conclusion === null ? '还没有结论' : `来自评论 · ${relTime(conclusion.comment.createdAt)}`}
        right={conclusion === null ? <Tag tone="muted">未开始</Tag> : <Tag tone="ok">已产出</Tag>}
      />
      <PCardBd>
        {run?.status !== 'done' || run.text.trim() === ''
          ? null
          : (
            <div className={css.gqPrAiBlock}>
              <div className={css.gqPrConclHd}>
                <Tag tone="ok">AI 结论 · 子智能体</Tag>
                <span className={css.gqPrRowStat}>
                  run {run.runId.slice(-6)} · {run.stopReason === '' ? '完成' : run.stopReason}
                </span>
              </div>
              <div className={css.gqPrCmtBody}><Markdown text={run.text} /></div>
              <div className={css.gqPrCmtActions}>
                <Btn
                  onClick={() => props.onRequestAccept(run.text)}
                  disabled={detail.state !== 'opened'}
                  title="忽略 AI 结论，直接进入审核通过确认"
                >
                  忽略结论直接审核通过…
                </Btn>
                <Btn
                  tone="danger"
                  onClick={() => props.onRequestReject(run.text)}
                  disabled={detail.state !== 'opened'}
                >
                  提交评论并驳回…
                </Btn>
              </div>
            </div>
          )}
        {conclusion === null
          ? (
            <div className={css.gqPrAiBlock}>
              <div className={css.gqPrRowSub}>
                结论不是接口返回的：发起后，会话里的智能体按模板逐项检查，最后把结论**写成评论**。
                评论到了这里就会显示。
              </div>
              <BQ>
                判定口径：blocker / major / minor / nit 四类问题；只有 blocker 为 0 才建议通过。
                通过/驳回仍由你点（除非你打开了自动通过）。
              </BQ>
            </div>
          )
          : (
            <div className={css.gqPrAiBlock}>
              <div className={css.gqPrConclHd}>
                <Tag tone="ok">AI 结论</Tag>
                <span className={css.gqPrRowStat}>{conclusion.comment.author?.name ?? '（未知）'} · {absTime(conclusion.comment.createdAt)}</span>
              </div>
              {conclusion.counts === null ? null : (
                <div className={css.gqPrCountGrid}>
                  <Count label="blocker" value={conclusion.counts.blocker} toneVar="var(--gq-danger)" />
                  <Count label="major" value={conclusion.counts.major} toneVar="var(--gq-warn)" />
                  <Count label="minor" value={conclusion.counts.minor} toneVar="var(--gq-info)" />
                  <Count label="nit" value={conclusion.counts.nit} toneVar="var(--gq-muted)" />
                </div>
              )}
              <div className={css.gqPrCmtBody}><Markdown text={conclusion.comment.body} /></div>
              <div className={css.gqPrCmtForm}>
                <textarea
                  className={`${css.gqPrInput} ${css.gqPrTextarea}`}
                  placeholder="给 AI 结论补充意见（会随驳回一起发表）"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <div className={css.gqPrCmtActions}>
                  <Btn onClick={() => props.onRequestAccept(draft)} disabled={detail.state !== 'opened'} title="忽略 AI 结论，直接进入审核通过确认">
                    忽略结论直接审核通过…
                  </Btn>
                  <Btn tone="danger" onClick={() => props.onRequestReject(draft)} disabled={detail.state !== 'opened'}>
                    提交评论并驳回…
                  </Btn>
                </div>
              </div>
            </div>
          )}
      </PCardBd>
    </PCard>
  )

  return (
    <>
      <div className={css.gqPrAiGrid}>
        {left}
        {right}
      </div>
      {prompt === null ? null : (
        <PCard>
          <PCardHd
            title="Prompt（原文）"
            sub="投递失败时可复制这段文本手工发送；成功投递时也留档在这里"
            right={<Btn size="sm" onClick={copyPrompt}>复制</Btn>}
          />
          <PCardBd><pre className={css.gqPrPrompt}>{prompt}</pre></PCardBd>
        </PCard>
      )}
      {confirming ? (
        <SendDialog
          templateName={templateName ?? (template === 'review' ? 'review.md' : 'test.md')}
          scope={scope}
          files={files}
          autoApprove={autoApprove}
          busy={busy}
          error={error}
          target={target === '' ? props.sessionId : target}
          targets={targets}
          onPickTarget={setTarget}
          useSubagent={useSubagent}
          onToggleSubagent={setUseSubagent}
          onCancel={() => { if (!busy) setConfirming(false) }}
          onConfirm={() => void dispatch()}
        />
      ) : null}
    </>
  )
}

/** 模板选择行。 */
function TemplateChip(props: { active: boolean; name: string; note: string; onPick: () => void }) {
  return (
    <button
      type="button"
      className={`${css.gqPrTplChip} ${props.active ? css.gqPrTplChipOn : ''}`}
      onClick={props.onPick}
    >
      <span className={css.gqPrTplName}>{props.name}</span>
      <span className={css.gqPrCardSub}>{props.note}</span>
      {props.active ? <Tag tone="ok">当前</Tag> : null}
    </button>
  )
}

/** 结论计数小卡。 */
function Count(props: { label: string; value: number; toneVar: string }) {
  return (
    <div className={css.gqPrCount}>
      <b style={{ color: props.toneVar }}>{props.value}</b>
      <span>{props.label}</span>
    </div>
  )
}

/** 发起前的二次确认（写动作必须过弹窗）。 */
function SendDialog(props: {
  templateName: string
  scope: ScopeKind
  files: string[]
  autoApprove: boolean
  busy: boolean
  error: { message: string; hint: string; code: string } | null
  /** 选中的投递会话（默认当前会话）。 */
  target: string
  /** 可选会话清单（可能为空：那时只能投当前会话）。 */
  targets: SessionChoice[]
  onPickTarget: (id: string) => void
  /** 勾选「子智能体」：取消就投到主会话（用户口径 2026-10-27）。 */
  useSubagent: boolean
  onToggleSubagent: (next: boolean) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const scopeText = props.scope === 'full' ? '全量' : props.scope === 'code-only' ? '仅业务代码' : `指定 ${props.files.length} 个文件`

  // 「先选工作区、再选会话」（用户口径 2026-10-26）：PR 可能属于不同仓库/不同工作区，
  // 下拉里不要出现目录路径，工作区显示 DSH 记录的名字，会话显示名字前 12 个字。
  const options: SessionChoice[] = props.targets.some((item) => item.id === props.target)
    ? props.targets
    : [{ id: props.target, title: '当前会话', cwd: '', preset: null, workspaceId: null, workspaceTitle: '' }, ...props.targets]
  const [selectedWorkspace, setSelectedWorkspace] = useState<string>('')
  const current = options.find((item) => item.id === props.target)
  const currentWorkspace = (current?.workspaceId ?? '') === '' ? '__none__' : String(current?.workspaceId)

  // 工作区清单（同一 id 只留一条；没有归属的会话归到「未归入工作区」）
  const workspaces = new Map<string, string>()
  for (const item of options) {
    const key = (item.workspaceId ?? '') === '' ? '__none__' : String(item.workspaceId)
    if (!workspaces.has(key)) workspaces.set(key, item.workspaceTitle === undefined || item.workspaceTitle === '' ? '未归入工作区' : item.workspaceTitle)
  }
  const workspaceKey = [...workspaces.keys()].includes(selectedWorkspace) ? selectedWorkspace : currentWorkspace
  const visible = options.filter((item) => ((item.workspaceId ?? '') === '' ? '__none__' : String(item.workspaceId)) === workspaceKey)

  const rows: Array<[ReactNode, ReactNode]> = [
    ['模板', <span className={css.gqPrTplName} key="t">{props.templateName}</span>],
    ['范围', scopeText],
    [
      '工作区',
      <select
        key="w"
        className={css.gqPrInput}
        value={workspaceKey}
        onChange={(event) => {
          setSelectedWorkspace(event.target.value)
          // 切工作区时把目标会话跟过去：优先沿用已选会话（若属于该工作区），否则取该区第一个
          const next = options.find(
            (item) => ((item.workspaceId ?? '') === '' ? '__none__' : String(item.workspaceId)) === event.target.value && item.id === props.target,
          ) ?? options.find((item) => ((item.workspaceId ?? '') === '' ? '__none__' : String(item.workspaceId)) === event.target.value)
          if (next !== undefined) props.onPickTarget(next.id)
        }}
      >
        {[...workspaces.entries()].map(([key, title]) => (
          <option key={key} value={key}>
            {title}（{options.filter((item) => ((item.workspaceId ?? '') === '' ? '__none__' : String(item.workspaceId)) === key).length}）
          </option>
        ))}
      </select>,
    ],
    [
      '会话',
      <select
        key="s"
        className={css.gqPrInput}
        value={props.target}
        onChange={(event) => props.onPickTarget(event.target.value)}
      >
        {(visible.length === 0 ? options : visible).map((item) => (
          <option key={item.id} value={item.id}>
            {item.id === props.target ? '当前会话 · ' : ''}
            {sessionLabel(item)}
          </option>
        ))}
      </select>,
    ],
    [
      '投递方式',
      <div key="d" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <PillCheck
          checked={props.useSubagent}
          label="子智能体"
          title={
            props.useSubagent
              ? '勾选：在所选会话下起子智能体跑，不往会话里插消息。取消勾选就投到主会话。'
              : '当前是「投到主会话」：会在该会话里多一条用户消息，AI 直接在对话里跑。'
          }
          onChange={props.onToggleSubagent}
        />
        <span style={{ fontSize: 11.5, color: 'var(--gq-text-3, #8a8f98)' }}>
          {props.useSubagent ? '后台跑，结论回面板，你确认后再写评论' : '结论同时投到主会话（会话里看得见），也回面板'}
        </span>
      </div>,
    ],
    ['自动通过', props.autoApprove ? '开（结论通过即直接审核通过）' : '关（由你决定）'],
  ]
  return (
    <Dialog
      open
      title="发起 AI 审核？"
      lead={
        props.useSubagent
          ? '会在所选会话下起一个子智能体按模板检查这个 PR：不往会话里插消息，跑完把结论交回面板，你确认后再写回 PR 评论。'
          : '会把这次检查投到所选会话的主对话里（一条用户消息），AI 在对话里跑完并写回 PR 评论；结论不会自动回到本面板。'
      }
      rows={rows}
      note={props.autoApprove ? '注意：已打开自动通过，AI 判定通过时会直接改 PR 状态。' : undefined}
      okLabel="投递"
      busy={props.busy}
      error={props.error}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
  )
}
