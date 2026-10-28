/**
 * 「＋ 新建 PR」对话框 —— **UI 手动建 PR 这条路**的表单。
 *
 * 与 agent 直接调 MCP `create_enterprise_repo_pull` 是同一件事的两个入口：
 * 都落到 `POST /pr/create` → `prService.create` → MCP，校验口径完全一致。
 *
 * 两条限制写死在界面里（不是 UI 偷懒，是能力边界）：
 *   1. **分支下拉来自宿主自己的取数通道**：MCP 的 55 个工具里没有「列分支」，
 *      所以走 `GET /repo/branches` → `gq branches` → 企业版 `/projects/{id}/branches`。
 *      只有默认分支的仓库**直接告知无法 PR**（源=目标时 Gitee 必拒，不必让人白填一遍）；
 *      取不到分支列表（老 token / 无权限）时回退成手填输入框，不阻断建 PR。
 *   2. **建完不能立刻开启审查/测试**：`check_state`/`test_state` 不在建 PR 的参数里，
 *      要建完再 PUT（M0 实测结论），所以这里不提供这两个开关。
 *
 * @module dsh-gitee-chat/client/PrCreateDialog
 */

import { useEffect, useState, type ReactNode } from 'react'
import css from './pr.module.css'
import { BQ, Btn, Dialog, PillCheck } from './prUi.tsx'
import {
  createPull,
  explainError,
  fetchDraftTarget,
  fetchPrAiRun,
  fetchPrTemplates,
  fetchSessions,
  saveDraftTarget,
  sessionLabel,
  startPrDraft,
  type SessionChoice,
} from './prApi.ts'
import { fetchRepoBranches, fetchRepos } from './api.ts'
import type { PrCreateResult, RepoBranch, RepoRow } from '../types.ts'

/** 表单提交成功后的回调（外层用它刷新列表并打开详情）。 */
export interface PrCreatedInfo extends PrCreateResult {
  repoId: number
}

export function PrCreateDialog(props: {
  sessionId: string
  /** 当前项目（用来列它下面的仓库）。 */
  programId: number | null
  programName: string
  /** 从仓库详情页进入时，预选这个仓库。 */
  defaultRepoId?: number | null
  onClose: () => void
  onCreated: (info: PrCreatedInfo) => void
}) {
  const [repos, setRepos] = useState<RepoRow[] | null>(null)
  const [repoId, setRepoId] = useState<number>(props.defaultRepoId ?? 0)
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [assignNum, setAssignNum] = useState(1)
  const [testNum, setTestNum] = useState(1)
  const [draft, setDraft] = useState(false)
  const [prTemplate, setPrTemplate] = useState('')
  const [prGuide, setPrGuide] = useState('')
  const [showGuide, setShowGuide] = useState(false)
  /**
   * AI 起草状态：
   *   `idle` → 没点；`running` → 子智能体在跑（轮询中）；`done` → 已填进表单；
   *   `failed` → 失败（错误信息留在 draftError，正文不被覆盖）
   */
  const [draftState, setDraftState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle')
  const [draftRunId, setDraftRunId] = useState('')
  const [draftError, setDraftError] = useState('')
  /** 投到主会话时的提示（结论会出现在会话里，同时回填本表单）。 */
  const [sentHint, setSentHint] = useState('')
  /** 这次比对到的量（提交数 / 文件数），用来证明「前置取 diff」真的发生了。 */
  const [draftMeta, setDraftMeta] = useState<{ commits: number; files: number; source: 'local' | 'remote' } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; hint: string; code: string } | null>(null)
  /**
   * 起草投递目标（工作区 + 会话）。
   *
   * 为什么让用户选：同一个 Gitee 项目下的仓库可能分属不同工作区，而工作区之间有
   * 权限边界（有的只给「本区可改」）。起草要在这个仓库对应的会话里起子智能体，
   * 否则它拿不到该仓库的本地上下文。选一次后按仓库记住，下次自动带出。
   */
  const [targets, setTargets] = useState<SessionChoice[]>([])
  const [draftTargetId, setDraftTargetId] = useState('')
  /** 勾选「子智能体」：与工作区/会话一起按仓库记住（用户口径 2026-10-27）。 */
  const [useSubagent, setUseSubagent] = useState(true)
  const [pickedWorkspace, setPickedWorkspace] = useState('')

  // 仓库清单（项目口径；取不到就只留当前预选的仓库）
  useEffect(() => {
    const controller = new AbortController()
    fetchRepos(props.sessionId, props.programId, props.programName, controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return
        const rows = Array.isArray(list.repos) ? list.repos : []
        setRepos(rows)
        setRepoId((current) => {
          if (current > 0 && rows.some((row) => row.repoId === current)) return current
          return rows[0]?.repoId ?? 0
        })
      })
      .catch(() => {
        if (!controller.signal.aborted) setRepos([])
      })
    return () => controller.abort()
  }, [props.sessionId, props.programId, props.programName])

  // PR 正文模板（随包 `templates/pr.md`，用户改过就用用户副本）
  useEffect(() => {
    const controller = new AbortController()
    fetchPrTemplates(undefined, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return
        setPrTemplate(res.active.pr ?? '')
        setPrGuide(res.active.prGuide ?? '')
      })
      .catch(() => {
        /* 模板取不到不影响建 PR */
      })
    return () => controller.abort()
  }, [])

  // 分支列表：换仓库就重拉。`null` = 还在读；`[]` = 读到了但没有（几乎不可能）。
  const [branches, setBranches] = useState<RepoBranch[] | null>(null)
  const [branchDefault, setBranchDefault] = useState('')
  const [branchError, setBranchError] = useState('')
  useEffect(() => {
    if (repoId <= 0) {
      setBranches(null)
      setBranchDefault('')
      return
    }
    const controller = new AbortController()
    setBranches(null)
    setBranchError('')
    fetchRepoBranches(props.sessionId, repoId, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return
        setBranches(res.items)
        setBranchDefault(res.defaultBranch)
        // 目标默认 = 仓库默认分支；源默认 = 第一个「不是默认分支」的分支（通常是刚推的功能分支）
        const dflt = res.defaultBranch
        const firstOther = res.items.find((b) => b.name !== dflt)?.name ?? ''
        setTarget(dflt)
        setSource(firstOther)
      })
      .catch((cause) => {
        if (controller.signal.aborted) return
        setBranches([])
        setBranchError(String(cause instanceof Error ? cause.message : cause))
      })
    return () => controller.abort()
  }, [props.sessionId, repoId])

  /** 实际投递到的会话：记住的目标优先，否则当前会话。 */
  const effectiveTarget = draftTargetId !== '' ? draftTargetId : props.sessionId
  /** 下拉候选（当前会话不在清单里时补一行「当前会话」，免得显示空白）。 */
  const targetOptions: SessionChoice[] = targets.some((item) => item.id === effectiveTarget)
    ? targets
    : [{ id: effectiveTarget, title: '当前会话', cwd: '', preset: null, workspaceId: null, workspaceTitle: '' }, ...targets]
  const workspaceMap = new Map<string, string>()
  for (const item of targetOptions) {
    const key = (item.workspaceId ?? '') === '' ? '__none__' : String(item.workspaceId)
    if (!workspaceMap.has(key)) {
      workspaceMap.set(key, item.workspaceTitle === undefined || item.workspaceTitle === '' ? '未归入工作区' : item.workspaceTitle)
    }
  }
  const currentTarget = targetOptions.find((item) => item.id === effectiveTarget)
  const currentWorkspaceKey = (currentTarget?.workspaceId ?? '') === '' ? '__none__' : String(currentTarget?.workspaceId)
  const workspaceKey = [...workspaceMap.keys()].includes(pickedWorkspace) ? pickedWorkspace : currentWorkspaceKey
  const visibleSessions = targetOptions.filter(
    (item) => ((item.workspaceId ?? '') === '' ? '__none__' : String(item.workspaceId)) === workspaceKey,
  )
  const targetLabel = currentTarget === undefined ? '当前会话' : sessionLabel(currentTarget)

  // AI 起草：轮询子智能体结果，拿到 JSON 就填进标题与描述
  useEffect(() => {
    if (draftRunId === '') return
    let stopped = false
    const timer = setInterval(() => {
      fetchPrAiRun(draftRunId)
        .then((run) => {
          if (stopped) return
          if (run.status === 'done') {
            const parsed = parseDraft(run.text)
            if (parsed === null) {
              setDraftState('failed')
              setDraftError('AI 的回复里没找到 JSON（可能只写了过程）。点「重新起草」再试一次。')
            } else {
              setTitle(parsed.title)
              setBody(parsed.body)
              setDraftState('done')
              setDraftError('')
            }
            setDraftRunId('')
          } else if (run.status === 'failed' || run.status === 'cancelled') {
            setDraftState('failed')
            setDraftError(run.error ?? '子智能体没跑完（可能被取消或超时）。')
            setDraftRunId('')
          }
        })
        .catch(() => {
          /* 单次轮询失败不致命，下一拍再试 */
        })
    }, 2500)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [draftRunId])

  const rows = repos ?? []
  const repo = rows.find((row) => row.repoId === repoId) ?? null
  // 可投递的会话清单（工作区 → 会话，两级；与 AI 审核用同一份）
  useEffect(() => {
    const controller = new AbortController()
    fetchSessions(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return
        setTargets(list)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setTargets([])
      })
    return () => controller.abort()
  }, [])

  // 当前仓库的 key（优先 path_with_namespace，取不到用仓库 id）
  const repoKey = repo?.pathWithNamespace !== undefined && repo.pathWithNamespace !== ''
    ? repo.pathWithNamespace
    : repoId > 0 ? String(repoId) : ''

  // 换仓库时带出这个仓库记住的投递目标（没记过就回落到当前会话）
  useEffect(() => {
    if (repoKey === '') return
    const controller = new AbortController()
    fetchDraftTarget(repoKey, controller.signal)
      .then((target) => {
        if (controller.signal.aborted) return
        setDraftTargetId(target === null ? '' : target.sessionId)
        setUseSubagent(target === null ? true : target.deliverSubagent)
        setPickedWorkspace('')
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setDraftTargetId('')
      })
    return () => controller.abort()
  }, [repoKey])

  /** 目标分支的默认值：仓库默认分支（MCP 没有列分支工具，只能给默认值）。 */
  const targetDefault = repo?.defaultBranch ?? ''
  const resolvedTarget = target.trim() === '' ? targetDefault : target.trim()
  /** 分支下拉可用（读到了 ≥1 条）且**不止**默认分支 —— 否则没有可 PR 的源分支。 */
  const branchList = branches ?? []
  const branchSelectable = branches !== null && branchList.length > 1
  const onlyDefaultBranch = branches !== null && branchList.length <= 1
  const canSubmit = repoId > 0 && source.trim() !== '' && title.trim() !== '' && resolvedTarget !== ''
    && !onlyDefaultBranch && branches !== null

  const submit = async () => {
    if (busy || !canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const result = await createPull(props.sessionId, {
        repoId,
        ...(repo === null ? {} : { repoPath: repo.pathWithNamespace }),
        sourceBranch: source.trim(),
        targetBranch: resolvedTarget,
        title: title.trim(),
        ...(body.trim() === '' ? {} : { body }),
        prAssignNum: assignNum,
        prTestNum: testNum,
        draft,
      })
      props.onCreated({ ...result, repoId })
    } catch (cause) {
      setError(explainError(cause))
      setBusy(false)
    }
  }

  const field = (label: string, control: ReactNode, hint?: string) => (
    <label style={{ display: 'grid', gap: 4 }}>
      <span className={css.gqPrAiLabel}>{label}</span>
      {control}
      {hint === undefined ? null : <span style={{ fontSize: 11, color: 'var(--gq-text-3, #8a8f98)' }}>{hint}</span>}
    </label>
  )

  return (
    <Dialog
      open
      title="新建合并请求"
      lead={repo === null
        ? '选一个仓库，填源分支（你推上去的开发分支）和目标分支。'
        : `${repo.pathWithNamespace} · 从 ${source.trim() === '' ? '源分支' : source.trim()} 合到 ${resolvedTarget === '' ? '目标分支' : resolvedTarget}`}
      okLabel="创建"
      busy={busy}
      error={error}
      onCancel={props.onClose}
      onConfirm={() => void submit()}
    >
      <div style={{ display: 'grid', gap: 10 }}>
        {field('投递到',
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8, flex: '1 1 320px', minWidth: 0 }}>
            <select
              className={css.gqPrInput}
              value={workspaceKey}
              disabled={busy || workspaceMap.size <= 1}
              title="会话所属工作区（仓库分属不同工作区时用来限定范围）"
              onChange={(event) => {
                setPickedWorkspace(event.target.value)
                const next = targetOptions.find(
                  (item) => ((item.workspaceId ?? '') === '' ? '__none__' : String(item.workspaceId)) === event.target.value && item.id === effectiveTarget,
                ) ?? targetOptions.find(
                  (item) => ((item.workspaceId ?? '') === '' ? '__none__' : String(item.workspaceId)) === event.target.value,
                )
                if (next !== undefined) setDraftTargetId(next.id)
              }}
            >
              {[...workspaceMap.entries()].map(([key, title]) => (
                <option key={key} value={key}>{title}</option>
              ))}
            </select>
            <select
              className={css.gqPrInput}
              value={effectiveTarget}
              disabled={busy}
              title="AI 起草会在这个会话下起一个子智能体"
              onChange={(event) => setDraftTargetId(event.target.value)}
            >
              {(visibleSessions.length === 0 ? targetOptions : visibleSessions).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id === props.sessionId ? '当前会话 · ' : ''}
                  {sessionLabel(item)}
                </option>
              ))}
            </select>
            </div>
            <PillCheck
              checked={useSubagent}
              disabled={busy}
              label="子智能体"
              title={
                useSubagent
                  ? '勾选：在所选会话下起子智能体写（不往会话里插消息）。取消勾选就投到主会话，能看见过程、也能接着聊。'
                  : '当前是「投到主会话」：会成为该会话的一条用户消息。勾上改回子智能体。'
              }
              onChange={(next) => {
                setUseSubagent(next)
                // 与工作区/会话一起记住：同一个仓库的偏好通常不会变
                if (repoKey !== '') {
                  void saveDraftTarget(repoKey, {
                    sessionId: effectiveTarget,
                    sessionTitle: currentTarget?.title ?? '',
                    workspaceTitle: currentTarget?.workspaceTitle ?? (workspaceMap.get(workspaceKey) ?? ''),
                    deliverSubagent: next,
                  }).catch(() => undefined)
                }
              }}
            />
          </div>,
          `选一次就按仓库记住（含「子智能体」勾选）：${repoKey === '' ? '选好仓库后生效' : `${repoKey} 以后默认投到这里`}`,
        )}

        {field('仓库',
          <select
            className={css.gqPrInput}
            value={repoId}
            disabled={busy || rows.length <= 1}
            onChange={(event) => setRepoId(Number(event.target.value))}
          >
            {rows.length === 0
              ? <option value={0}>{repos === null ? '正在读取仓库…' : '这个项目下没有可用仓库'}</option>
              : rows.map((row) => <option key={row.repoId} value={row.repoId}>{row.pathWithNamespace}</option>)}
          </select>)}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {field('源分支',
            branchError === ''
              ? <select
                  className={css.gqPrInput}
                  value={source}
                  disabled={busy || branches === null || !branchSelectable}
                  onChange={(event) => setSource(event.target.value)}
                >
                  {branches === null
                    ? <option value="">正在读取分支…</option>
                    : branchList.length === 0
                      ? <option value="">这个仓库还没有任何分支</option>
                      : branchList.map((b) => (
                        <option key={b.name} value={b.name} disabled={b.name === resolvedTarget}>
                          {b.name}{b.isDefault ? '（默认）' : ''}
                        </option>
                      ))}
                </select>
              : <input
                  className={css.gqPrInput}
                  placeholder="feature/xxx"
                  value={source}
                  disabled={busy}
                  onChange={(event) => setSource(event.target.value)}
                />,
            branchError === ''
              ? (onlyDefaultBranch ? '这个仓库只有默认分支，没有可 PR 的源分支' : '你推上去的那个功能分支')
              : '读不到分支列表，手输分支名')}
          {field('目标分支',
            branchError === ''
              ? <select
                  className={css.gqPrInput}
                  value={resolvedTarget}
                  disabled={busy || branches === null || !branchSelectable}
                  onChange={(event) => setTarget(event.target.value)}
                >
                  {branchList.length === 0
                    ? <option value="">—</option>
                    : branchList.map((b) => (
                      <option key={b.name} value={b.name} disabled={b.name === source.trim()}>
                        {b.name}{b.isDefault ? '（默认）' : ''}
                      </option>
                    ))}
                </select>
              : <input
                  className={css.gqPrInput}
                  placeholder={targetDefault === '' ? 'master' : targetDefault}
                  value={target}
                  disabled={busy}
                  onChange={(event) => setTarget(event.target.value)}
                />,
            branchError === '' ? '合到哪个分支（默认走仓库默认分支）' : (targetDefault === '' ? '留空则按 master' : `留空则用 ${targetDefault}`))}
        </div>

        {onlyDefaultBranch ? (
          <BQ tone="warn">
            仓库 <code>{repo?.pathWithNamespace ?? repoId}</code> 只有 <code>{branchList[0]?.name ?? branchDefault}</code>{' '}
            一个分支，源分支与目标分支没法不同 —— 先把开发分支推到 Gitee，再回来建 PR。
          </BQ>
        ) : null}

        {field('标题', <input
          className={css.gqPrInput}
          placeholder="feat: 一句话说清这次改动"
          value={title}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
        />)}

        {field('描述',
          <div style={{ display: 'grid', gap: 6 }}>
            <textarea
              className={css.gqPrTextarea}
              style={{ minHeight: 120, resize: 'vertical' }}
              placeholder="做了什么 / 怎么验证 / 有什么风险"
              value={body}
              disabled={busy}
              onChange={(event) => setBody(event.target.value)}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Btn
                size="sm"
                disabled={busy || prTemplate.trim() === ''}
                title={prTemplate.trim() === '' ? '没有读到 PR 模板' : '把随包模板填进描述（会覆盖当前内容）'}
                onClick={() => setBody(prTemplate)}
              >
                套用模板
              </Btn>
              <Btn
                size="sm"
                tone="purple"
                disabled={busy || draftState === 'running' || source.trim() === '' || resolvedTarget === ''}
                title={
                  source.trim() === '' || resolvedTarget === ''
                    ? '先选好源分支与目标分支'
                    : useSubagent
                      ? `让 AI 读这次的真实改动，按模板起草标题与描述（在「${targetLabel}」下起子智能体，会覆盖标题和描述）`
                      : `让 AI 读这次的真实改动（结论同时投到「${targetLabel}」主会话并回填本表单，会覆盖标题和描述）`
                }
                onClick={() => {
                  if (repoId <= 0 || source.trim() === '' || resolvedTarget === '') return
                  setDraftState('running')
                  setDraftError('')
                  setSentHint('')
                  // 记住这个仓库的投递目标 + 勾选状态：下次打开对话框自动带出（记忆失败不影响起草）
                  if (repoKey !== '') {
                    void saveDraftTarget(repoKey, {
                      sessionId: effectiveTarget,
                      sessionTitle: currentTarget?.title ?? '',
                      workspaceTitle: currentTarget?.workspaceTitle ?? (workspaceMap.get(workspaceKey) ?? ''),
                      deliverSubagent: useSubagent,
                    }).catch(() => undefined)
                  }
                  const input = {
                    repoId,
                    ...(repo?.pathWithNamespace === undefined ? {} : { repoPath: repo.pathWithNamespace }),
                    sourceBranch: source.trim(),
                    targetBranch: resolvedTarget,
                  }
                  // 两条投递路径现在是同一个跑批：勾选 = delivery 'caller'（纯后台），
                  // 取消勾选 = delivery 'parent'（结论同时落进主会话，也回填本表单）。
                  startPrDraft(effectiveTarget, { ...input, deliver: useSubagent ? 'subagent' : 'session' })
                    .then((res) => {
                      setDraftMeta({ commits: res.commits, files: res.files, source: res.source })
                      setDraftRunId(res.runId)
                      setSentHint(
                        useSubagent
                          ? ''
                          : `已投到「${targetLabel}」主会话：结论会出现在那边，同时自动回填本表单。`,
                      )
                    })
                    .catch((cause) => {
                      setDraftState('failed')
                      setDraftError(explainError(cause).message)
                    })
                }}
              >
                {draftState === 'running' ? 'AI 起草中…' : draftState === 'done' ? '重新起草' : '✨ AI 起草'}
              </Btn>
              <Btn size="sm" disabled={busy} onClick={() => setShowGuide((v) => !v)}>
                {showGuide ? '收起说明' : '写什么？'}
              </Btn>
              <span style={{ fontSize: 11, color: 'var(--gq-text-3, #8a8f98)' }}>
                {draftState === 'running'
                  ? draftMeta === null
                    ? '正在比对分支差异…'
                    : `已比对到 ${draftMeta.commits} 个提交 / ${draftMeta.files} 个文件${draftMeta.source === 'local' ? '（本地仓库，毫秒级）' : '（远端 compare）'}，${useSubagent ? '子智能体' : '主会话'}正在写…`
                  : draftState === 'done'
                    ? '已按改动生成，可继续手改'
                    : '套用模板 = 干净骨架；AI 起草 = 按同一套分节填好内容'}
              </span>
            </div>
            {draftError !== '' ? <BQ tone="warn">{draftError}</BQ> : null}
            {sentHint !== '' ? <BQ tone="info">{sentHint}</BQ> : null}
            {showGuide && prGuide.trim() !== '' ? (
              <pre
                style={{
                  maxHeight: 220,
                  overflow: 'auto',
                  margin: 0,
                  padding: 10,
                  fontSize: 11,
                  lineHeight: 1.55,
                  whiteSpace: 'pre-wrap',
                  background: 'var(--gq-surface-2, #f7f8fa)',
                  border: '1px solid var(--gq-border, #e2e5ea)',
                  borderRadius: 6,
                }}
              >
                {prGuide}
              </pre>
            ) : null}
          </div>)}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          {field('审查人数', <input
            className={css.gqPrInput}
            type="number"
            min={0}
            max={10}
            value={assignNum}
            disabled={busy}
            onChange={(event) => setAssignNum(Number(event.target.value))}
          />, '0 = 不要求审查')}
          {field('测试人数', <input
            className={css.gqPrInput}
            type="number"
            min={0}
            max={10}
            value={testNum}
            disabled={busy}
            onChange={(event) => setTestNum(Number(event.target.value))}
          />, '0 = 不要求测试')}
          {field('草稿', <label style={{ display: 'flex', gap: 6, alignItems: 'center', height: 30 }}>
            <input
              type="checkbox"
              checked={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.checked)}
            />
            <span style={{ fontSize: 12 }}>先建草稿</span>
          </label>)}
        </div>

        <BQ>
          建完之后要「开启审查 / 开启测试」：那是另一个写动作（建 PR 的参数里没有），
          在 PR 详情页点一下即可。
        </BQ>
      </div>
    </Dialog>
  )
}

/**
 * 从子智能体回复里抠出 `{title, body}`。
 *
 * 模型偶尔会包 ```json 围栏、或在 JSON 前后多说两句，所以不是直接 `JSON.parse`：
 * 先剥围栏，再取第一个 `{` 到最后一个 `}` 之间试解析；失败返回 `null`（调用方提示重试）。
 */
export function parseDraft(text: string): { title: string; body: string } | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const raw = JSON.parse(cleaned.slice(start, end + 1)) as { title?: unknown; body?: unknown }
    const title = typeof raw.title === 'string' ? raw.title.trim() : ''
    const body = typeof raw.body === 'string' ? raw.body.trim() : ''
    if (title === '') return null
    return { title, body }
  } catch {
    return null
  }
}
