/**
 * 整屏「Gitee 项目」工作台（原型 `.tmp/design/pr-panel/project.html`）。
 *
 * 6 个页签：概览 / 项目 / 仓库 / 合并请求 / 知识库 / 固定分析。
 * 同一组件同时用于两个槽位（0.5.4 起）：
 *   - `conversation.view`：与 对话/轨迹/上下文 并列的第 4 个标签页；
 *   - `main` + `sidebar.panellist`：左侧「Gitee 项目」列表项 ↔ 右侧整页（同一个 id `gitee`）。
 *
 * ⚠️ 架构事实：客户端插件在 **profile 层**，它注册的 `conversation.view` 对**所有 preset**
 * 可见（包括 PTC），而客户端拿不到会话的 preset。所以本视图先问 host「这个会话是不是
 * Gitee 模式」，不是就只显示一句提示 —— 绝不把 Gitee 看板塞进无关会话。
 *
 * ⚠️ 渲染确定性：`scripts/render-check.mjs` 用 `react-dom/server` 渲染本组件（注入 `preload`
 * 种子数据），所以**渲染期不能访问 window / document / localStorage**，一切副作用放 effect。
 *
 * @module dsh-gitee-chat/client/GiteeProjectView
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import cssBoard from './board.module.css'
import css from './pr.module.css'
import { fetchBoard, fetchIssues, fetchRepos, fetchSession, prefetchIssue, type ProgramIssues } from './api.ts'
import { MyIssuesPanel } from './MyIssuesPanel.tsx'
import { fetchPrList } from './prApi.ts'
import { OverviewTab } from './OverviewTab.tsx'
import { PrTab } from './PrTab.tsx'
import { AnalysisCards } from './AnalysisCards.tsx'
import { DocPanel } from './DocPanel.tsx'
import { RepoPanel } from './RepoPanel.tsx'
import { IssueCreateDialog } from './IssueCreate.tsx'
import { PrCreateDialog } from './PrCreateDialog.tsx'
import { ViewBoundary } from './ViewBoundary.tsx'
import { ColResizer, useColWidth } from './resize.tsx'
import { IssueDetail } from './IssueDetail.tsx'
import { Btn, Chips, Dialog, Tag } from './prUi.tsx'
import { Bar, Card, CardTitle, Empty, ErrorState, Note, Pill, Stat, StatGrid, StatePill, Table, day } from './ui.tsx'
import { StateStack, stateLabel } from './charts.tsx'
import type { BoardAnalysis, BoardPayload, Freshness, PrCounts, RepoRow } from '../types.ts'

/** 视图入参（slot 注入的标准 props + owner props）。 */
export interface GiteeProjectViewProps {
  /** 当前会话 id —— 用于向 host 确认是否 Gitee 模式，也用于写操作鉴权。 */
  sessionId?: string
  /**
   * 离线预览用的种子数据。
   *
   * **仅供 `scripts/render-check.mjs` 的 SSR 自检注入**：服务端渲染不跑 effect，
   * 没有它就无法把「已就绪」状态的界面渲染成静态 HTML。正常槽位渲染不传。
   */
  preload?: { board: BoardPayload; issues?: ProgramIssues }
  /**
   * 是否作为「侧边栏整页」渲染（`main` 槽位）。
   *
   * 只影响顶栏：整页模式下多一个「← 回到会话」，因为整页替换了中央栏，
   * 用户需要一个明确的出口（`layout.selectPanel(null)`）。
   */
  standalone?: boolean
  /** 整页模式下点「回到会话」的回调（由 index.tsx 注入的 layout 服务提供）。 */
  onLeavePanel?: () => void
  [key: string]: unknown
}

type Phase =
  | { kind: 'probing' }
  | { kind: 'disabled'; preset: string | null }
  | { kind: 'loading' }
  | { kind: 'ready'; board: BoardPayload; cached: boolean; truncated: boolean; freshness?: Freshness }
  | { kind: 'error'; message: string }

/** 6 个页签（原型屏 1-4 + 仓库 + 知识库 + 固定分析）。 */
type Tab = 'overview' | 'project' | 'mine' | 'pr' | 'docs' | 'analysis'

/** 项目详情工作项筛选（每类一颗色卡）。 */
type IssueFilter = 'open' | 'done' | 'overdue' | 'all'

const ISSUE_FILTERS: ReadonlyArray<{ key: IssueFilter; label: string; tone: 'slate' | 'blue' | 'green' | 'red' | 'cyan' }> = [
  { key: 'open', label: '未完成', tone: 'blue' },
  { key: 'done', label: '已完成', tone: 'green' },
  { key: 'overdue', label: '逾期', tone: 'red' },
  { key: 'all', label: '全部', tone: 'slate' },
]

/** class 拼装。 */
function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ')
}

/**
 * 「本会话未使用 Gitee 模式」提示。
 *
 * 单独导出有两个理由：它是**唯一**会在无关会话里出现的界面（必须能被单独
 * 审阅），以及离线预览 / SSR 自检需要直接渲染它（服务端不跑 effect，
 * 走不到 ready 之外的分支）。
 *
 * @param props.preset - 该会话实际使用的 preset id（未知为 null）。
 */
export function GiteeModeNotice(props: { preset?: string | null }) {
  return (
    <Card>
      <CardTitle title="本会话未使用 Gitee 模式" />
      <div className={cssBoard.gqVDim} style={{ lineHeight: 1.8 }}>
        这个标签页只在挂了「Gitee 项目管理」预设的会话里显示项目数据。
        <br />
        当前预设：{props.preset ?? '未知'}。新建会话时在预设里选 Gitee 模式即可。
      </div>
    </Card>
  )
}

/** 整屏项目工作台。 */
export function GiteeProjectView(props: GiteeProjectViewProps) {
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  const seed = props.preload
  const [phase, setPhase] = useState<Phase>(() => seed === undefined
    ? { kind: 'probing' }
    : { kind: 'ready', board: seed.board, cached: false, truncated: seed.board.truncated === true })
  // SSR 自检（有 seed）从「项目」页开始，正常渲染从「概览」开始（原型默认屏）。
  const [tab, setTab] = useState<Tab>(seed === undefined ? 'overview' : 'project')
  /**
   * 想在「仓库」分段里直接打开的仓库 id。
   *
   * 来源是项目详情的仓库卡片（用户口径「点击项目卡片到仓库详情下」）：
   * 点卡片 → 切到「仓库」分段 + 把这个 id 交给 RepoPanel 自动选中。
   */
  const [repoFocus, setRepoFocus] = useState<number | null>(null)
  /**
   * 是否处在「仓库下钻」页（项目列表 | 仓库列表 | 仓库资源 三栏）。
   *
   * 与 `repoFocus` 分开的原因（用户 2026-10-27：「在切换项目时不用回卡片页，仓库列表
   * 直接更新」）：换项目时要把 repoFocus 清空（旧仓库不属于新项目），但**不能**因此
   * 退回项目卡片页 —— 之前用 `repoFocus !== null` 当分支条件，换项目就掉回卡片页了。
   */
  const [drillDown, setDrillDown] = useState(false)
  /** 两列宽度可拖拽（用户口径：「用户可以自行改变其长度」）。 */
  const [projectColWidth, setProjectColWidth] = useColWidth('project', 190)
  const [selected, setSelected] = useState<number | null>(seed?.board.programs[0]?.id ?? null)
  const [issues, setIssues] = useState<ProgramIssues | null>(seed?.issues ?? null)
  const [issueError, setIssueError] = useState<string | null>(null)
  const [openIdent, setOpenIdent] = useState<string | null>(null)
  const [issueFilter, setIssueFilter] = useState<IssueFilter>('open')
  const [prCounts, setPrCounts] = useState<PrCounts | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * 要打开的「新建 PR」对话框：`null` = 关着，数字 = 预选这个仓库。
   *
   * 深链 `#newpr` / `#newpr=<repoId>` 是唯一入口（合并请求页的按钮、仓库详情页的按钮
   * 都只改 hash），这样两边不各写一套开关状态（同 `#pr=` 的做法）。
   */
  const [createPrFor, setCreatePrFor] = useState<number | null>(null)

  /**
   * 上一次的看板快照（sessionStorage，5 分钟有效）。
   *
   * 为什么要有：打开项目面板要先起 `node gq.mjs` 子进程、再打企业 API，
   * 冷启动实测 0.5~1s；而「切走再切回」「刷新页面」看到的几乎总是同一份数据。
   * 先渲染快照、后台再刷新（stale-while-revalidate），观感上就是秒开。
   * 快照只存精简后的 payload（不含 seed/函数），失败一律当没有。
   */
  const snapshotKey = `gq:board:${sessionId}`
  const readSnapshot = useCallback((): { board: BoardPayload; at: number } | null => {
    try {
      const raw = window.sessionStorage.getItem(snapshotKey)
      if (raw === null) return null
      const parsed = JSON.parse(raw) as { board?: BoardPayload; at?: number }
      if (parsed.board === undefined || typeof parsed.at !== 'number') return null
      if (Date.now() - parsed.at > 5 * 60_000) return null
      return { board: parsed.board, at: parsed.at }
    } catch {
      return null
    }
  }, [snapshotKey])

  /** 先确认会话是否 Gitee 模式，再取看板数据。 */
  const load = useCallback(async (refresh: boolean, signal?: AbortSignal) => {
    // 有快照就先上屏（不闪 loading），后台继续拉最新
    if (!refresh) {
      const snap = readSnapshot()
      if (snap !== null) {
        setPhase({ kind: 'ready', board: snap.board, cached: true, truncated: snap.board.truncated === true })
        setSelected((prev) => prev ?? snap.board.programs[0]?.id ?? null)
      }
    }
    // 已经有数据就**原地刷新**：刷新时不再退回 loading，否则整页闪一下（用户称「类似卡顿」）
    setPhase((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }))
    try {
      // 0.5.4 起**不再按「会话是不是 Gitee 模式」拦**：面板在任何模式都可用
      // （用户 2026-10-26 口径：「任何模式都可以，而不是必须 agent 预设选 gitee 项目会话模式」）。
      // 能不能读到/写到由云端 token 的角色决定，界面拿到 auths 再显示按钮状态。
      const res = await fetchBoard({ scope: 'portfolio', refresh }, signal)
      if (signal?.aborted === true) return
      setPhase({
        kind: 'ready',
        board: res.payload,
        cached: res.cached,
        truncated: res.payload.truncated === true,
        freshness: res.freshness,
      })
      try {
        window.sessionStorage.setItem(snapshotKey, JSON.stringify({ board: res.payload, at: Date.now() }))
      } catch {
        // 存不下（配额/隐私模式）就算了，纯优化
      }
      setSelected((prev) => prev ?? res.payload.programs[0]?.id ?? null)
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return
      setPhase({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [sessionId])

  useEffect(() => {
    // 离线预览注入种子数据时跳过拉取
    if (seed !== undefined) return
    const controller = new AbortController()
    void load(false, controller.signal)
    return () => controller.abort()
  }, [load, seed])

  /** 选中项目时取它的工作项。 */
  useEffect(() => {
    if (selected === null || phase.kind !== 'ready') return
    if (seed !== undefined) return
    const controller = new AbortController()
    setIssues(null)
    setIssueError(null)
    // 走 api.ts 的统一封装（错误信封、可判定 code），不要在这里裸 fetch
    fetchIssues(selected, undefined, controller.signal)
      .then((body) => { if (!controller.signal.aborted) setIssues(body) })
      .catch((error) => {
        if ((error as Error)?.name === 'AbortError') return
        setIssueError(error instanceof Error ? error.message : String(error))
      })
    return () => controller.abort()
  }, [selected, phase.kind, seed])

  /** PR 计数（页签数字 / 概览卡）：失败就静默保持 `null`，不影响整页。 */
  useEffect(() => {
    // PR 列表接口自 0.5.4 起不依赖会话（走宿主进程级 MCP 直连），空 sessionId 也能取。
    // 也不依赖 payload：别等看板拉完再排队，两条请求一起发。
    if (seed !== undefined) return
    const controller = new AbortController()
    fetchPrList(sessionId, { scope: 'all', state: 'opened', page: 1 }, controller.signal)
      .then((body) => { if (!controller.signal.aborted) setPrCounts(body.counts) })
      .catch(() => undefined)
    return () => controller.abort()
  }, [sessionId, seed])

  /**
   * 深链：`#pr=<repoId>:<iid>&dwpane=…&act=…` 切到合并请求页；
   * `#newpr[=<repoId>]` 打开「新建 PR」对话框（仓库页与合并请求页共用这一个入口）。
   *
   * 具体开哪个抽屉、开哪一页由 `PrTab` 自己解析 hash（它本来就监听 hashchange），
   * 这里只负责「把用户带到合并请求页」这一层，避免两处解析规则漂移。
   */
  useEffect(() => {
    if (typeof window === 'undefined') return
    const apply = () => {
      const hash = window.location.hash
      if (hash.startsWith('#pr')) setTab('pr')
      // `0` = 打开对话框但不预选仓库（写死 0 而不是 null，是因为 null 表示"关着"）
      const created = /^#newpr(?:=(\d+))?$/.exec(hash)
      setCreatePrFor(created === null ? null : created[1] === undefined ? 0 : Number(created[1]))
    }
    apply()
    window.addEventListener('hashchange', apply)
    return () => window.removeEventListener('hashchange', apply)
  }, [])

  // ── 非 Gitee 会话：只给一句提示，不渲染任何 Gitee 内容 ────────────────────
  if (phase.kind === 'disabled') {
    return <div className={cx(cssBoard.gqRoot, css.gqPrRoot)} data-gq-root=""><GiteeModeNotice preset={phase.preset} /></div>
  }

  if (phase.kind === 'probing' || phase.kind === 'loading') {
    return (
      <div className={cx(cssBoard.gqRoot, css.gqPrRoot)} data-gq-root="">
        <Card><Empty>正在拉取 Gitee 项目数据…</Empty></Card>
      </div>
    )
  }

  if (phase.kind === 'error') {
    return (
      <div className={cx(cssBoard.gqRoot, css.gqPrRoot)} data-gq-root="">
        <Card>
          <CardTitle title="Gitee 项目" />
          <ErrorState message="取数失败" detail={phase.message} onRetry={() => void load(true)} />
          {/* token / 企业这类配置**不在这里配**：配置入口只有应用「设置 → Gitee 企业项目」。 */}
          <Note>token、企业这类配置在应用「设置 → Gitee 企业项目」里改；保存后回来点「重试」即可。</Note>
        </Card>
      </div>
    )
  }

  const board = phase.board
  const analysis: BoardAnalysis | undefined = board.analysis
  const current = board.programs.find((program) => program.id === selected) ?? null
  const prPending = prCounts === null ? null : prCounts.review + prCounts.test

  /** 页签项（数字只在有数据时给）。 */
  const tabs: Array<{ key: Tab; label: ReactNode; count?: number }> = [
    { key: 'overview', label: '概览' },
    { key: 'project', label: '项目', count: board.programs.length },
    // 「仓库」改成「我的工作项」（用户口径 m01634 ② / m01861）：仓库详情不再独占一个页签，
    // 改成从「项目」页签的仓库卡片点进去下钻（见下面的 repoFocus 分支）。
    { key: 'mine', label: '我的工作项', count: board.myIssues === undefined ? undefined : board.myIssues.length },
    { key: 'pr', label: '合并请求', count: prPending === null ? undefined : prPending },
    { key: 'docs', label: '知识库' },
    { key: 'analysis', label: '固定分析', count: analysis === undefined ? undefined : analysis.totals.nonCompliant + analysis.totals.overdue },
  ]

  const topbar = (
    <header className={css.gqPrTopbar}>
      <div className={css.gqPrTopbarMain}>
        <h1 className={css.gqPrPageTitle}>Gitee 项目</h1>
        <div className={css.gqPrCrumb}>
          <span>{board.enterprise.name || `企业 ${board.enterprise.id}`} · {board.enterprise.id}</span>
          <span>·</span>
          <span>{board.source === 'fixture' ? '样例数据' : '实时拉取'}</span>
          <span>·</span>
          <span>生成于 {board.generatedAt}</span>
          <FreshnessTag freshness={phase.freshness} />
          <span>·</span>
          <span>我：{board.me === null ? '未知' : board.me.name}</span>
          {phase.cached ? <Tag tone="muted">缓存</Tag> : null}
          {phase.truncated ? <Tag tone="warn">已截断</Tag> : null}
          {board.source === 'fixture' ? <Tag tone="warn">样例数据</Tag> : null}
        </div>
      </div>
      <div className={css.gqPrTopbarActions}>
        {props.standalone === true && typeof props.onLeavePanel === 'function'
          ? <Btn size="sm" tone="green" onClick={() => props.onLeavePanel?.()}>← 回到会话</Btn>
          : null}
        <span className={css.gqPrRowStat} title="数据经由宿主脚本拉取，token 不出本机"><span className={css.gqPrDot} style={{ background: 'var(--gq-ok)' }} />已连接 · 云端权限</span>
        <Btn size="sm" onClick={() => void load(true)}>⟳ 刷新</Btn>
        <Btn size="sm" onClick={() => setSettingsOpen(true)} title="配置入口在应用「设置 → Gitee 企业项目」">⚙ 设置</Btn>
      </div>
    </header>
  )

  const tabBar = (
    <nav className={css.gqPrTabs} role="tablist">
      {tabs.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={tab === item.key}
          className={cx(css.gqPrTab, tab === item.key && css.gqPrTabOn)}
          onClick={() => { setTab(item.key); if (item.key !== 'project') setRepoFocus(null) }}
        >
          {item.label}
          {item.count === undefined ? null : <span className={css.gqPrTabN}>{item.count}</span>}
        </button>
      ))}
    </nav>
  )

  let content: ReactNode = null
  if (tab === 'overview') {
    content = (
      <OverviewTab
        payload={board}
        counts={prCounts}
        onGoProject={() => setTab('project')}
        onGoPr={() => setTab('pr')}
        onGoAnalysis={() => setTab('analysis')}
      />
    )
  } else if (tab === 'pr') {
    content = (
      <PrTab sessionId={sessionId} onCounts={(counts) => setPrCounts(counts)} />
    )
  } else if (tab === 'mine') {
    content = (
      <MyIssuesPanel
        rows={board.myIssues ?? []}
        onOpen={(row) => {
          // 跳到「项目」页签 + 选中它所属项目 + 直接打开这张工作项的详情
          setSelected(row.programId)
          setIssueFilter('all')
          setOpenIdent(row.ident)
          setTab('project')
        }}
      />
    )
  } else if (tab === 'docs') {
    // 用户 2026-10-27：「点击知识库 左侧项目列表 右侧展示项目下 知识库，切换卡本项目和公共知识库」
    // → 与仓库下钻同一套骨架：左项目列表 | 右知识库；「本项目 / 公共知识库」胶囊由 DocPanel 自己管。
    content = (
      <div className={cssBoard.gqVSplit}>
        <div style={{ flex: '0 0 auto', width: projectColWidth, minWidth: 0 }}>
          <Card>
            <CardTitle title="项目" note={`${board.programs.length} 个`} />
            <ProgramNav
              programs={board.programs}
              selected={selected}
              onSelect={(id) => { setSelected(id) }}
            />
          </Card>
        </div>
        <ColResizer width={projectColWidth} onResize={setProjectColWidth} />
        <div className={cssBoard.gqVSplitMain}>
          <DocPanel sessionId={sessionId} programId={selected} programName={current?.name ?? ''} />
        </div>
      </div>
    )
  } else if (tab === 'analysis') {
    content = analysis === undefined
      ? <Card><Empty>本次数据未包含固定分析（脚本版本较旧？）</Empty></Card>
      : <AnalysisCards analysis={analysis} managementEnabled={true} />
  } else if (drillDown) {
    // 仓库卡片下钻。用户 2026-10-27 定稿的交互（m03483 原话）：
    // 「点击项目，点击任意仓库卡片，项目列表还在，在当前页面渲染当前项目的仓库列表，
    //   展示这个仓库的资源，这个项目和仓库列表都可以切换。仓库信息 [切换仓库 ▾]
    //   不是下拉方式二是左侧列表方式。」
    // 于是三栏并存：项目列表 | 仓库列表（本项目下） | 仓库资源。
    // 窄面板下把两栏都收窄（项目 190 / 仓库 220），详情仍然优先占位。
    content = (
      <div className={cssBoard.gqVSplit}>
        <div style={{ flex: '0 0 auto', width: projectColWidth, minWidth: 0 }}>
          <Card>
            <CardTitle title="项目" note={`${board.programs.length} 个`} />
            <ProgramNav
              programs={board.programs}
              selected={selected}
              onSelect={(id) => {
                // 换项目留在下钻页（用户 2026-10-27：「在切换项目时不用回卡片页，仓库列表直接更新」）：
                // 只换项目 + 清掉旧仓库焦点，RepoPanel 会按新 programId 重新拉列表。
                setSelected(id)
                setRepoFocus(null)
              }}
            />
          </Card>
        </div>
        <ColResizer width={projectColWidth} onResize={setProjectColWidth} />
        <div className={cssBoard.gqVSplitMain}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <Btn
              size="sm"
              tone="green"
              onClick={() => { setDrillDown(false); setRepoFocus(null) }}
              title="回到项目详情"
            >
              ← 返回项目
            </Btn>
            <span className={cssBoard.gqVDim}>
              当前项目：{current === null ? '未选择' : current.name} · 点左侧仓库切换
            </span>
          </div>
          <RepoPanel
            sessionId={sessionId}
            programId={selected}
            programName={current?.name ?? ''}
            focusRepoId={repoFocus}
          />
        </div>
      </div>
    )
  } else {
    content = (
      <ProjectTab
        board={board}
        current={current}
        issues={issues}
        issueError={issueError}
        issueFilter={issueFilter}
        openIdent={openIdent}
        selected={selected}
        sessionId={sessionId}
        onSelect={(id) => { setSelected(id); setOpenIdent(null) }}
        onFilter={setIssueFilter}
        onOpenRepo={(repoId) => { setRepoFocus(repoId); setDrillDown(true); setTab('project') }}
        onOpenIdent={setOpenIdent}
        onBack={() => setOpenIdent(null)}
        // 写操作后不清屏重拉：宿主已把读缓存清掉，这里走缓存路径即可（命中即秒回，未命中才取）
        onChanged={() => void load(false)}
      />
    )
  }

  return (
    <div className={cx(cssBoard.gqRoot, css.gqPrRoot)} data-gq-root="">
      {topbar}
      {tabBar}
      <div className={css.gqPrBody}><ViewBoundary>{content}</ViewBoundary></div>
      {settingsOpen
        ? (
          <Dialog
            open
            title="配置在应用设置里"
            lead="「Gitee 项目」页只读展示；token 与企业的配置入口只有一处：应用「设置 → Gitee 企业项目」。"
            rows={[
              ['入口', '应用设置 → Gitee 企业项目'],
              ['配完回来', '点本页右上角「⟳ 刷新」即可'],
              ['为什么要这样', '设置页在还没进 Gitee 模式的会话里也够得着，避免"先有 token 才能找到配 token 的地方"'],
            ]}
            okLabel="知道了"
            onCancel={() => setSettingsOpen(false)}
            onConfirm={() => setSettingsOpen(false)}
          />
        )
        : null}
      {/* 「新建 PR」对话框：由 `#newpr[=<repoId>]` 深链控制开关，仓库页/合并请求页共用 */}
      {createPrFor === null
        ? null
        : (
          <PrCreateDialog
            sessionId={sessionId}
            programId={selected}
            programName={current?.name ?? ''}
            defaultRepoId={createPrFor > 0 ? createPrFor : null}
            onClose={() => {
              if (typeof window !== 'undefined') window.location.hash = ''
            }}
            onCreated={(info) => {
              void load(false)
              // 建完直接停在 PR 详情（`#pr=` 由 PrTab 解析，这里同时把对话框关掉）
              if (typeof window !== 'undefined') window.location.hash = `#pr=${info.repoId}:${info.iid}`
            }}
          />
        )}
    </div>
  )
}


/**
 * 项目详情里的「仓库」卡片区。
 *
 * 用户口径（m03569 ③④）：「项目下的仓库没有展示卡片，参考记忆空间那种卡片；
 * 点击项目卡片到仓库详情下。」所以这里用卡片网格而不是列表 —— 点卡片会切到
 * 「仓库」分段并直接把那个仓库选中（`onOpenRepo`）。
 */
function ProjectRepoCards(props: {
  sessionId: string
  programId: number | null
  programName: string
  onOpenRepo: (repoId: number) => void
}) {
  const [rows, setRows] = useState<RepoRow[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (props.programId === null) {
      setRows([])
      setError('')
      return
    }
    const controller = new AbortController()
    setRows(null)
    setError('')
    fetchRepos(props.sessionId, props.programId, props.programName, controller.signal)
      // ⚠️ 字段是 `repos`（RepoListResponse），不是 `items` —— 读错会在下面 `rows.length` 处炸成白屏
      .then((body) => { if (!controller.signal.aborted) setRows(Array.isArray(body.repos) ? body.repos : []) })
      .catch((err) => {
        if ((err as Error)?.name === 'AbortError') return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => controller.abort()
  }, [props.programId, props.programName, props.sessionId])

  if (error !== '') return <ErrorState message="仓库加载失败" detail={error} />
  if (rows === null) return <Empty>正在拉取项目仓库…</Empty>
  if (rows.length === 0) return <Empty>这个项目下还没有仓库</Empty>

  return (
    <div className={cssBoard.gqVRepoGrid}>
      {rows.map((repo) => (
        <div
          key={repo.repoId}
          className={cssBoard.gqVRepoCard}
          role="button"
          tabIndex={0}
          title={`打开 ${repo.pathWithNamespace} 的仓库详情`}
          onClick={() => props.onOpenRepo(repo.repoId)}
        >
          <div className={cssBoard.gqVRepoHd}>
            <span className={cssBoard.gqVRepoName} title={repo.pathWithNamespace}>{repo.name}</span>
            <Pill>{repo.visibility}</Pill>
          </div>
          <div className={cssBoard.gqVRepoDesc}>{repo.description === '' ? '（没有描述）' : repo.description}</div>
          <div className={cssBoard.gqVRepoStats}>
            <span>默认分支 {repo.defaultBranch === '' ? '—' : repo.defaultBranch}</span>
            <span>{repo.wiki ? 'WIKI 有内容' : 'WIKI 无'}</span>
            <span>{repo.lastPushAt === '' ? '未推送' : `最近推送 ${day(repo.lastPushAt)}`}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

/** 项目页：左项目列表 + 右工作项（下钻到详情）。 */
/**
 * 左侧「项目」列表。
 *
 * 抽出来是因为**仓库下钻页也要能切项目**：用户 2026-10-27 报「从项目点击仓库卡片，
 * 进入的页面不能切换项目」—— 原来项目列表只长在 `ProjectTab` 里，一下钻就被换掉，
 * 想换项目只能先「← 返回项目」。现在两处共用同一个列表，行为一致。
 */
function ProgramNav(props: {
  programs: BoardPayload['programs']
  selected: number | null
  onSelect: (id: number) => void
}) {
  if (props.programs.length === 0) return <Empty>没有可见的项目</Empty>
  return (
    <div className={cssBoard.gqVNavScroll}>
      {props.programs.map((program) => (
        <div
          key={program.id}
          className={cx(cssBoard.gqVNavItem, program.id === props.selected && cssBoard.gqVNavOn)}
          role="button"
          tabIndex={0}
          onClick={() => props.onSelect(program.id)}
        >
          <div className={cssBoard.gqVNavName} title={program.name}>{program.name}</div>
          <div className={cssBoard.gqVNavSub}>
            <span title={program.assignee || '未指派'}>{program.assignee || '未指派'}</span>
            {program.overdue > 0
              ? <span className={cssBoard.gqVErr}>⚠︎{program.overdue}</span>
              : <span>{program.total} 项</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

function ProjectTab(props: {
  board: BoardPayload
  current: BoardPayload['programs'][number] | null
  issues: ProgramIssues | null
  issueError: string | null
  issueFilter: IssueFilter
  openIdent: string | null
  selected: number | null
  sessionId: string
  onOpenRepo: (repoId: number) => void
  onSelect: (id: number) => void
  onFilter: (filter: 'all' | 'open' | 'overdue') => void
  onOpenIdent: (ident: string) => void
  onBack: () => void
  onChanged: () => void
}) {
  const { board, current, issues, issueFilter } = props
  // ⚠️ hooks 必须在任何 return 之前 —— 之前放在下面那个 `openIdent` 提前返回之后，
  // 点进工作项详情再返回时 React 报「渲染的 hooks 比上一次多」→ 整个标签页白屏。
  const [creating, setCreating] = useState(false)
  const [createdHint, setCreatedHint] = useState('')

  if (props.openIdent !== null) {
    return (
      <>
        <div className={css.gqPrCardHd} style={{ marginBottom: 10 }}>
          <Btn size="sm" tone="green" onClick={props.onBack}>← 返回工作项列表</Btn>
        </div>
        <IssueDetail
          sessionId={props.sessionId}
          ident={props.openIdent}
          writesEnabled={true}
          onClose={props.onBack}
          onChanged={props.onChanged}
        />
      </>
    )
  }

  const filtered = issues === null ? [] : issues.issues.filter((item) => {
    if (issueFilter === 'open') return item.state !== 'closed' && item.state !== 'rejected'
    if (issueFilter === 'overdue') return item.overdue
    if (issueFilter === 'done') return item.state === 'closed' || item.state === '已完成'
    return true
  })

  return (
    <div className={cssBoard.gqVCols}>
      <div className={cssBoard.gqVCol} style={{ flex: '0 1 260px' }}>
        <Card>
          <CardTitle title="项目" note={`${board.programs.length} 个`} />
          <ProgramNav programs={board.programs} selected={props.selected} onSelect={props.onSelect} />
        </Card>
      </div>
      <div className={cssBoard.gqVCol}>
        <Card>
          <CardTitle
            title={current === null ? '工作项' : current.name}
            note={current === null ? '左侧选择一个项目' : `${current.category || '—'} · 负责人 ${current.assignee || '未指派'}`}
            // 用户口径（m02229 ②）：新建类主操作放左起按钮组，从左往右排
            actions={(
              // 用户口径（m03569 ③）：「项目详情下没有新建工作项」—— 项目页也能建，不挂仓库
              <Btn size="sm" tone="blue" onClick={() => { setCreatedHint(''); setCreating(true) }} title="在这个项目下新建工作项（不挂仓库）">＋ 新建工作项</Btn>
            )}
            right={
              <Chips
                items={ISSUE_FILTERS}
                value={issueFilter}
                onChange={(key) => props.onFilter(key)}
              />
            }
          />
          {current === null
            ? <Empty>左侧选择一个项目</Empty>
            : (
              <div>
                <div className={cssBoard.gqVStats} style={{ marginBottom: 8 }}>
                  <Stat label="完成率" value={`${current.progress}%`} />
                  <Stat label="工作项" value={current.total} />
                  <Stat label="已完成" value={current.done} tone="ok" />
                  <Stat label="进行中" value={current.progressing} />
                  <Stat label="逾期" value={current.overdue} tone={current.overdue > 0 ? 'err' : undefined} />
                </div>
                <Bar percent={current.progress} title={`${current.progress}% 已完成`} />
                <div className={cssBoard.gqVSectionHd} style={{ marginTop: 14 }}>
                  <span>仓库</span>
                  <span className={cssBoard.gqVDim}>点卡片进仓库详情</span>
                </div>
                <ProjectRepoCards
                  sessionId={props.sessionId}
                  programId={current === null ? null : current.id}
                  programName={current === null ? '' : current.name}
                  onOpenRepo={props.onOpenRepo}
                />
                {createdHint === '' ? null : <Note>{createdHint}</Note>}
                {issues === null && props.issueError === null
                  ? <Empty>正在拉取工作项…</Empty>
                  : props.issueError !== null
                    ? <ErrorState message="工作项加载失败" detail={props.issueError} />
                    : (
                      <div style={{ marginTop: 10 }}>
                        {issues !== null && issues.issues.length < issues.total
                          ? <Note><span className={cssBoard.gqVWarn}>⚠ 工作项数量超过翻页上限，列表已截断（显示 {issues.issues.length} / {issues.total}）。</span></Note>
                          : null}
                        <StateStack rows={issues?.distribution ?? []} />
                        <div style={{ marginTop: 8 }}>
                          {issues !== null && issues.distribution.length === 0
                            ? <Empty>该项目下暂无工作项</Empty>
                            : (
                              <Table head={['编号', '标题', '负责人', '状态', '截止', '逾期']}>
                                {filtered.length === 0
                                  ? <tr><td colSpan={6}><Empty>当前筛选下没有工作项</Empty></td></tr>
                                  : filtered.map((item) => (
                                    <tr
                                      key={item.ident}
                                      style={{ cursor: 'pointer' }}
                                      onClick={() => props.onOpenIdent(item.ident)}
                                      onMouseEnter={() => prefetchIssue(item.ident)}
                                      onFocus={() => prefetchIssue(item.ident)}
                                    >
                                      <td className={cx(cssBoard.gqVNum, cssBoard.gqVDim)}>{item.ident}</td>
                                      <td title="点击查看描述 / 前置依赖 / 评论讨论">{item.title}</td>
                                      <td className={cssBoard.gqVDim}>{item.assignee || '未指派'}</td>
                                      <td><StatePill state={item.state} label={stateLabel(item.state)} /></td>
                                      <td className={cssBoard.gqVNum}>{day(item.deadline)}</td>
                                      <td className={cssBoard.gqVNum}>
                                        {item.overdue ? <span className={cssBoard.gqVErr}>+{item.overdueDays}d</span> : ''}
                                      </td>
                                    </tr>
                                  ))}
                              </Table>
                            )}
                        </div>
                      </div>
                    )}
                {issues === null ? null : (
                  <Note>点击任意一行查看工作项详情（描述 / 前置依赖 / 评论讨论），并可直接改状态、改派、发评论。</Note>
                )}
              </div>
            )}
        </Card>
      </div>
      <IssueCreateDialog
        open={creating}
        target={current === null ? null : {
          programId: current.id,
          programName: current.name,
          repoId: null,
          repoName: '',
        }}
        onClose={() => setCreating(false)}
        onCreated={(message) => { setCreatedHint(message); props.onChanged() }}
      />
    </div>
  )
}

/**
 * 顶栏的「数据时效」标签（用户口径 m02223：让 AI 和人都知道）。
 *
 * 数字与 AI 工具输出里的 `ageSeconds / stale / ttlSeconds` **同源**（都来自宿主
 * `/payload` 的 `freshness`），这样「用户看到的」和「模型被告知的」不会各说一套。
 * 超过新鲜期标黄并把「可能过期」写进可见文字，而不是只放在 title 里。
 * @param props.freshness - 宿主返回的时效元信息；缺失时什么都不渲染（老宿主）。
 */
function FreshnessTag(props: { freshness?: Freshness }) {
  const freshness = props.freshness
  if (freshness === undefined) return null
  const age = freshness.ageSeconds
  const text = age < 60
    ? `${age} 秒前`
    : age < 3600
      ? `${Math.round(age / 60)} 分钟前`
      : `${Math.round(age / 3600)} 小时前`
  const layer = freshness.source === 'disk' ? '落盘快照' : freshness.source === 'memory' ? '内存缓存' : '现拉'
  return (
    <Tag
      tone={freshness.stale ? 'warn' : 'muted'}
      title={`数据抓取于 ${text}（${layer}）；新鲜期 ${freshness.ttlSeconds} 秒`
        + `${freshness.stale ? '，已超过新鲜期——可能不是最新，点「⟳ 刷新」可重拉' : ''}`}
    >
      {freshness.stale ? `数据 ${text} · 可能过期` : `数据 ${text}`}
    </Tag>
  )
}
