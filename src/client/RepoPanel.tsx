/**
 * 「仓库」面板 —— 整屏 Gitee 项目视图里与 项目 / 固定分析 / 知识库 并列的分段。
 *
 * ## 两个口径（需求原话）
 *
 *   - **选中了项目** → 只列**该项目下的**仓库（host 用 `program_id` 过滤）；
 *   - **没选项目** → 只列**企业内部开源**的仓库（`scope=internal-open`）。
 *
 * 两种都是 Gitee 自己的过滤参数，插件不自己筛（见 `DOCS.md` §14）。
 *
 * ## WIKI 为什么挂在仓库下面
 *
 * Gitee 的仓库 WIKI 是**仓库的一个子功能**（`/projects` 上的
 * `wiki_enabled_with_content` 就是它），不是企业/项目知识库那一套 `doc_nodes`
 * —— 后者是企业级或项目级，跟仓库没有从属关系（实测传仓库 id 返回 0）。
 * 所以"仓库下面展示 WIKI"是**唯一**符合 Gitee 数据模型的位置。
 *
 * ## 仓库下面归属三块（用户口径）
 *
 * 「工作项（任务/需求/缺陷）/ 合并请求 / WIKI」都是**仓库的子功能**，所以都放在
 * 仓库详情里用页签切换，而不是各自散到别的分段：
 *
 *   - 工作项：Gitee 企业版的 `project_id` 过滤（与项目的 `program_id` 过滤是同一批
 *     对象的两个维度），新建时就带上 `repoId`，工作项自然挂在仓库下面；
 *   - 合并请求：`/pr/list?repoId=`（0.5.4 起不需要会话处于 Gitee 模式）；
 *   - WIKI：`wiki_enabled_with_content` + 本地克隆（见下）。
 *
 * ## 预览分工（与知识库面板一致）
 *
 * 装了 `dsh-better-sidebar` 就点一下交给它；没装则只内联预览 `.md`。
 * 见 `client/sidebar.ts`。
 *
 * @module dsh-gitee-chat/client/RepoPanel
 */

import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import css from './board.module.css'
import { fetchRepoIssues, fetchRepos, fetchWiki, fetchWikiPage, prefetchIssue, type RepoIssues } from './api.ts'
import { IssueDetail } from './IssueDetail.tsx'
import { IssueCreateDialog } from './IssueCreate.tsx'
import { fetchPrList } from './prApi.ts'
import { sidebarAvailable, sidebarOpenFile } from './sidebar.ts'
import { ColResizer, useColWidth } from './resize.tsx'
import { Card, CardTitle, Empty, ErrorState, List, Markdown, Note, Pill, Row, Segmented, Stat, StatGrid, StatePill, day } from './ui.tsx'
import { Btn } from './prUi.tsx'
import type { PrSummary, RepoListResponse, RepoRow, WikiPageRow, WikiPageResponse, WikiTreeResponse } from '../types.ts'

/** 口径（本项目 / 内源仓库）在本机的记忆键（跨项目切换保留，用户 2026-10-27）。 */
const SCOPE_KEY = 'gq:repo-scope'

/** 面板入参。 */
export interface RepoPanelProps {
  /** 当前会话 id（host 靠它解析 agent 作用域）。 */
  sessionId: string
  /** 当前选中的项目（null = 只列企业内部开源仓库）。 */
  programId: number | null
  /** 项目名。 */
  programName: string
  /**
   * 想直接打开的仓库 id（项目详情的仓库卡片点进来时给）。
   *
   * 列表拉回来自动选中它一次；之后用户自己点列表不再受这个值影响。
   */
  focusRepoId?: number | null
}

/** 本插件自己内联预览的扩展名（与 DocPanel 同口径：只有 Markdown）。 */
const INLINE_PREVIEW_EXT = new Set(['md', 'markdown'])

/** 由文件名取扩展名（小写，无点）。 */
function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 仓库列表项。 */
function RepoItem(props: { repo: RepoRow; on: boolean; onClick: () => void }) {
  const { repo } = props
  return h('div', {
    className: `${css.gqVNavItem} ${props.on ? css.gqVNavOn : ''}`,
    role: 'button',
    tabIndex: 0,
    onClick: props.onClick,
    title: repo.description || repo.pathWithNamespace,
  },
    h('div', { className: css.gqVNavName }, repo.name),
    h('div', { className: css.gqVNavSub },
      h('span', { className: css.gqVDim }, repo.visibility),
      repo.wiki ? h(Pill, null, 'WIKI') : null,
      h('span', { className: css.gqVDim }, repo.lastPushAt === '' ? '' : day(repo.lastPushAt)),
    ),
  )
}

/**
 * 仓库面板（左列表 + 右 WIKI）。
 * @param props - 会话与当前项目。
 */
export function RepoPanel(props: RepoPanelProps) {
  const { sessionId, programId, programName } = props

  const [list, setList] = useState<RepoListResponse | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<RepoRow | null>(null)
  /**
   * 取数口径开关。
   *
   * 需求要的是"点了项目 → 项目下的仓库；没点项目 → 企业内部开源"。
   * 而「项目」分段里**总有一个项目是选中的**（没有"全不选"这个状态），
   * 所以这里把这个选择显式做成开关 —— 两种口径都到得了，
   * 而不是让"企业内部开源"变成一条走不到的分支。
   */
  const [scope, setScope] = useState<'project' | 'internal'>(() => {
    // 用户 2026-10-27：「点击切换项目后：内源仓库选中失效」——
    // 口径只存在组件状态里，切换项目/重新挂载就丢。改成记在 localStorage，
    // 重挂载也按上次的口径恢复。没有记过时：有项目就本项目，没项目就内源。
    try {
      const remembered = window.localStorage.getItem(SCOPE_KEY)
      if (remembered === 'internal' || remembered === 'project') return remembered
    } catch { /* 隐私模式拿不到 localStorage：退回按 programId 推断 */ }
    return programId === null ? 'internal' : 'project'
  })

  const [wiki, setWiki] = useState<WikiTreeResponse | null>(null)
  const [wikiPhase, setWikiPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [wikiError, setWikiError] = useState('')

  const [page, setPage] = useState<WikiPageResponse | null>(null)
  const [pagePath, setPagePath] = useState('')
  /**
   * WIKI 页过滤词。
   *
   * **纯前端**：WIKI 一旦克隆下来，整棵树就在本地 —— 过滤不该再发任何请求
   * （Gitee 侧本来也没有 WIKI 的搜索接口）。这是"本地已有数据就本地用"的直接体现。
   */
  const [pageFilter, setPageFilter] = useState('')
  const [pageError, setPageError] = useState('')
  const [delegated, setDelegated] = useState(false)
  /** 交给侧边栏时用的那条路径（显示出来，排障时一眼看到用的是哪条）。 */
  const [delegatedPath, setDelegatedPath] = useState('')

  /**
   * 仓库详情的页签：工作项 / 合并请求 / WIKI。
   *
   * 三块都是**仓库的子功能**（Gitee 数据模型如此），所以收在仓库详情里用页签切，
   * 而不是散到别的分段去（用户口径：仓库下面归属 工作项、PR、WIKI）。
   */
  const [tab, setTab] = useState<'issues' | 'pr' | 'wiki'>('issues')
  const [repoIssues, setRepoIssues] = useState<RepoIssues | null>(null)
  const [issuesPhase, setIssuesPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  /**
   * 仓库「工作项」里点开的那一条（`ident`）。
   *
   * 用户 2026-10-27 反馈：仓库页的工作项「这三个工作项目不可点击」——原来只是纯展示。
   * 现在点一行就在原地打开详情（跟项目页签里的行为一致），返回时留在仓库页。
   */
  const [openIdent, setOpenIdent] = useState<string | null>(null)
  const [issuesError, setIssuesError] = useState('')
  const [prItems, setPrItems] = useState<PrSummary[] | null>(null)
  const [prPhase, setPrPhase] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [prError, setPrError] = useState('')
  /** 仓库列表栏宽（可拖拽，见 `resize.tsx`）。 */
  const [listWidth, setListWidth] = useColWidth('repo', 220)

  /** 新建弹窗是否打开（表单状态由 IssueCreateDialog 自己管）。 */
  const [creating, setCreating] = useState(false)
  /** 建成后的提示（弹窗关掉之后显示在卡片上）。 */
  const [createdHint, setCreatedHint] = useState('')

  /** 切口径并记住（用户口径要跨项目切换保留）。 */
  const chooseScope = useCallback((next: 'project' | 'internal') => {
    setScope(next)
    try { window.localStorage.setItem(SCOPE_KEY, next) } catch { /* 记不住就算了，不影响本回合 */ }
  }, [])

  /** 拉仓库列表（项目 / 口径切换时重拉）。 */
  const load = useCallback(async (signal?: AbortSignal) => {
    setPhase('loading')
    setSelected(null)
    setWiki(null)
    setWikiPhase('idle')
    setPage(null)
    const wanted = scope === 'project' && programId !== null && programId > 0 ? programId : null
    try {
      const data = await fetchRepos(sessionId, wanted, wanted === null ? '' : programName, signal)
      if (signal?.aborted === true) return
      setList(data)
      setPhase('ready')
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }, [programId, programName, scope, sessionId])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  /** 拉一个仓库的 WIKI 树。 */
  /** 拉一个仓库下的工作项（仓库详情「工作项」页签）。 */
  const loadRepoIssues = useCallback(async (repoId: number, signal?: AbortSignal) => {
    setIssuesPhase('loading')
    setIssuesError('')
    try {
      const data = await fetchRepoIssues(repoId, undefined, signal)
      if (signal?.aborted === true) return
      setRepoIssues(data)
      setIssuesPhase('ready')
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      setIssuesError(err instanceof Error ? err.message : String(err))
      setIssuesPhase('error')
    }
  }, [])

  /** 拉一个仓库下的合并请求（仓库详情「合并请求」页签）。 */
  const loadRepoPrs = useCallback(async (repoId: number, signal?: AbortSignal) => {
    setPrPhase('loading')
    setPrError('')
    try {
      const data = await fetchPrList(sessionId, { scope: 'all', state: 'all', repoId })
      if (signal?.aborted === true) return
      setPrItems(data.items)
      setPrPhase('ready')
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      setPrError(err instanceof Error ? err.message : String(err))
      setPrPhase('error')
    }
  }, [sessionId])

  const loadWiki = useCallback(async (repo: RepoRow, refresh: boolean, signal?: AbortSignal) => {
    setWikiPhase('loading')
    setWikiError('')
    setPage(null)
    try {
      const data = await fetchWiki(sessionId, { repoId: repo.repoId, repoPath: repo.pathWithNamespace, repoName: repo.name }, refresh, signal)
      if (signal?.aborted === true) return
      setWiki(data)
      setWikiPhase('ready')
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      setWikiError(err instanceof Error ? err.message : String(err))
      setWikiPhase('error')
    }
  }, [sessionId])

  /**
   * 选中一个仓库：三块子功能一起准备。
   *
   * 工作项与合并请求各一次轻量请求（都支持 repoId 过滤），WIKI 仍然「有内容才去克隆」
   * —— 克隆是重量级动作，没 WIKI 的仓库不白跑一趟 git。
   */
  const pick = useCallback((repo: RepoRow) => {
    setSelected(repo)
    setTab('issues')
    setRepoIssues(null)
    setIssuesPhase('idle')
    setPrItems(null)
    setPrPhase('idle')
    setCreating(false)
    setCreatedHint('')
    setWiki(null)
    setWikiPhase('idle')
    setPage(null)
    setPageFilter('')
    setDelegated(false)
    setDelegatedPath('')
    void loadRepoIssues(repo.repoId)
    void loadRepoPrs(repo.repoId)
    if (repo.wiki) void loadWiki(repo, false)
    else setWikiPhase('ready')
  }, [loadWiki, loadRepoIssues, loadRepoPrs])

  /**
   * 从项目详情的仓库卡片跳进来时，自动选中那个仓库（只做一次）。
   *
   * 依赖里带 `selected` 是为了「列表已就绪、但刚才还没选中」那一次补挂；
   * 一旦已经选中同一个仓库就不再 pick（pick 会重置三块数据）。
   */
  // 每个 focusRepoId 只应用一次：依赖里绝不能带 `selected`，否则用户点了别的仓库 →
  // selected 变 → 这个 effect 又跑一遍 → 发现 selected !== focus → 立刻 pick 回原仓库，
  // 表现就是「点了马上被切回去」。
  const appliedFocus = useRef<number | null>(null)
  useEffect(() => {
    const focus = props.focusRepoId ?? null
    if (focus === null || list === null) return
    if (appliedFocus.current === focus) return
    // ⚠️ 字段是 `repos`（RepoListResponse），不是 `items`
    const hit = list.repos.find((repo) => repo.repoId === focus)
    if (hit === undefined) return
    appliedFocus.current = focus
    if (selected === null || selected.repoId !== focus) pick(hit)
    // 只随列表 / 入参变化重跑；selected 故意不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, pick, props.focusRepoId])

  /**
   * 打开 WIKI 里的一页：先读回来，再决定谁显示。
   *
   * 与 `DocPanel` 同一分工：**有侧边栏就一律交给它**（目标路径优先用工作区软链接
   * 下的那条，拿不到就用真实路径），没有侧边栏才自己内联预览 `.md`。
   */
  const openPage = useCallback(async (row: WikiPageRow) => {
    if (selected === null) return
    setPagePath(row.path)
    setPage(null)
    setPageError('')
    setDelegated(false)
    setDelegatedPath('')
    try {
      const data = await fetchWikiPage(sessionId, { repoId: selected.repoId, repoPath: selected.pathWithNamespace, repoName: selected.name }, row.path)
      setPage(data)
      const target = data.workspacePath ?? data.localPath
      if (sidebarOpenFile(sessionId, target, data.name)) {
        setDelegatedPath(target)
        setDelegated(true)
      }
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err))
    }
  }, [selected, sessionId])

  const repos = list?.repos ?? []
  /**
   * 过滤后的 WIKI 页。
   *
   * 大小写不敏感、匹配**整条相对路径**（不只是文件名）——WIKI 常有
   * `设计/接口.md` 这种分层，只匹配文件名会让人搜不到"设计"这一类。
   */
  const filteredPages = (() => {
    const all = wiki?.pages ?? []
    const q = pageFilter.trim().toLowerCase()
    if (q === '') return all
    return all.filter((row) => row.path.toLowerCase().includes(q) || row.title.toLowerCase().includes(q))
  })()

  // 用户 2026-10-27 口径：仓库列表里「刷新」不要；「本项目」也不用；
  // 「企业内部开源」改名「内源仓库」，做成一枚可点选的胶囊（默认灰、选中浅蓝）。
  const listCard = h(Card, null,
    h(CardTitle, {
      title: '仓库',
      note: list === null
        ? '按项目取数'
        : (list.mode === 'project'
            ? `项目「${list.programName || list.programId}」下的仓库 · ${list.total} 个`
            : `内源仓库 · ${list.total} 个`),
      right: h('span', { style: { marginLeft: 'auto' } },
        h('button', {
          type: 'button',
          className: scope === 'internal' ? `${css.gqVScopeChip} ${css.gqVScopeChipOn}` : css.gqVScopeChip,
          'aria-pressed': scope === 'internal',
          title: scope === 'internal' ? '点一下回到本项目仓库' : '点一下只看企业内部开源（内源）仓库',
          onClick: () => chooseScope(scope === 'internal' ? 'project' : 'internal'),
        }, '内源仓库'),
      ),
    }),
    list !== null ? h(Note, null, list.notice) : null,
    phase === 'loading'
      ? h(Empty, null, '正在拉取仓库列表…')
      : phase === 'error'
        ? h(ErrorState, { message: '仓库列表加载失败', detail: error, onRetry: () => void load() })
        : repos.length === 0
          ? h(Empty, null, list?.mode === 'project' ? '该项目名下没有仓库' : '企业内部没有内源仓库')
          : h('div', { className: css.gqVNavScroll, style: { maxHeight: 460 } },
              repos.map((repo) => h(RepoItem, { key: repo.repoId, repo, on: repo.repoId === selected?.repoId, onClick: () => pick(repo) }))),
  )

  const infoCard = h(Card, null,
    h(CardTitle, {
      title: selected === null ? '仓库信息' : selected.name,
      note: selected === null ? '左侧选择一个仓库' : selected.pathWithNamespace,
    }),
    selected === null
      ? h(Empty, null, '左侧选择一个仓库，下面会列出它的 WIKI')
      : h('div', null,
          h(StatGrid, null,
            h(Stat, { label: '仓库 id', value: selected.repoId }),
            h(Stat, { label: '可见性', value: selected.visibility }),
            h(Stat, { label: '默认分支', value: selected.defaultBranch || '—' }),
            h(Stat, { label: '成员', value: selected.membersCount }),
            h(Stat, { label: '大小', value: `${(selected.repoSize / 1024).toFixed(1)} MB` }),
            h(Stat, { label: '状态', value: selected.statusName || '—' }),
            h(Stat, { label: '最近推送', value: day(selected.lastPushAt) }),
            h(Stat, { label: 'WIKI', value: selected.wiki ? '有内容' : '无', tone: selected.wiki ? 'ok' : undefined }),
          ),
          selected.description !== ''
            ? h(Note, null, selected.description)
            : null,
          selected.outsourced
            ? h(Note, null, h('span', { className: css.gqVWarn }, '这个仓库标记为外包。'))
            : null,
        ),
  )

  const wikiCard = selected === null
    ? null
    : h(Card, null,
        h(CardTitle, {
          title: `WIKI${wiki === null || wiki.pages.length === 0 ? '' : ` · ${filteredPages.length}/${wiki.pages.length} 页`}`,
          note: selected.wiki
            ? (wiki === null ? '按需拉取' : `HEAD ${wiki.head === '' ? '（空仓）' : wiki.head.slice(0, 8)} · ${wiki.fetched ? '本次已取远端' : '本地缓存'} · ${wiki.localDir}`)
            : '这个仓库没有 WIKI 内容',
          right: selected.wiki
            ? h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' } },
              h('input', {
                type: 'search',
                value: pageFilter,
                placeholder: '按路径/文件名过滤（本地，不发请求）',
                'aria-label': 'WIKI 页过滤',
                style: { width: 200, padding: '2px 6px', borderRadius: 5, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', fontSize: 12 },
                onChange: (e: { target?: { value?: string } }) => setPageFilter(e?.target?.value ?? ''),
              }),
              h('button', {
                type: 'button',
                className: css.gqVSegBtn,
                style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 5, marginLeft: 'auto' },
                onClick: () => void loadWiki(selected, true),
              }, '刷新'))
            : null,
        }),
        selected.wiki
          ? (wikiPhase === 'loading'
              ? h(Empty, null, '正在克隆 / 刷新 WIKI（首次会慢一点）…')
              : wikiPhase === 'error'
                ? h(ErrorState, { message: 'WIKI 拉取失败', detail: wikiError, onRetry: () => void loadWiki(selected, true) })
                : wiki === null
                  ? h(Empty, null, '正在准备…')
                  : h('div', null,
                      wiki.notice !== undefined ? h(Note, null, h('span', { className: css.gqVWarn }, wiki.notice)) : null,
                      wiki.pages.length === 0
                        ? h(Empty, null, '这个仓库的 WIKI 是空的（或还没建首页）。')
                        : filteredPages.length === 0
                          ? h(Empty, null, `没有匹配「${pageFilter}」的页（共 ${wiki.pages.length} 页）。`)
                          : h('div', { className: css.gqVNavScroll, style: { maxHeight: 260 } },
                            filteredPages.map((row) => h('div', {
                              key: row.path,
                              className: `${css.gqVNavItem} ${row.path === pagePath ? css.gqVNavOn : ''}`,
                              role: 'button',
                              tabIndex: 0,
                              title: row.path,
                              onClick: () => void openPage(row),
                            },
                              h('div', { className: css.gqVNavName }, `${INLINE_PREVIEW_EXT.has(extOf(row.name)) ? '📄 ' : '📎 '}${row.title}`),
                              h('div', { className: css.gqVNavSub },
                                h('span', { className: css.gqVDim }, `.${extOf(row.name) || '—'}`),
                                h('span', { className: css.gqVDim }, `${(row.bytes / 1024).toFixed(1)} KB`),
                                h('span', { className: css.gqVDim }, row.path.includes('/') ? row.path.split('/').slice(0, -1).join('/') : ''),
                              ),
                            ))),
                    ))
          : h(Note, null, '这个仓库没有 WIKI 内容。'),
      )

  const pageCard = pageCardOf({ page, pageError, delegated, delegatedPath, pagePath, sidebarReady: sidebarAvailable() })

  /**
   * 仓库详情的页签条：工作项 / 合并请求 / WIKI。
   *
   * 三者都是 Gitee 里「仓库的子功能」，所以收在仓库详情里用页签切，而不是散到
   * 别的分段去（用户口径：仓库下面归属 工作项、PR、WIKI）。
   */
  const tabBar = selected === null
    ? null
    : h('div', { style: { margin: '4px 0 8px' } },
        h(Segmented, {
          plain: true,
          options: [
            { key: 'issues', tone: 'sand' as const, label: repoIssues === null ? '工作项' : `工作项 ${repoIssues.total}` },
            { key: 'pr', tone: 'rose' as const, label: prItems === null ? '合并请求' : `合并请求 ${prItems.length}` },
            { key: 'wiki', tone: 'olive' as const, label: 'WIKI' },
          ],
          value: tab,
          onChange: (key) => {
            setTab(key as 'issues' | 'pr' | 'wiki')
            // 懒加载：切到哪个页签、且还没取过，才去取（不重复发请求）
            if (key === 'issues' && issuesPhase === 'idle' && selected !== null) void loadRepoIssues(selected.repoId)
            if (key === 'pr' && prPhase === 'idle' && selected !== null) void loadRepoPrs(selected.repoId)
          },
        }),
      )

  /** 工作项页签：仓库维度的工作项清单 + 新建入口。 */
  const issuesCard = selected === null
    ? null
    : openIdent !== null
      // 点开某条工作项：原地显示详情（用户 2026-10-27：仓库页的工作项要能点）
      ? h('div', null,
          h('div', { style: { marginBottom: 10 } },
            h(Btn, {
              size: 'sm',
              tone: 'green',
              onClick: () => setOpenIdent(null),
              title: '回到这个仓库的工作项列表',
            }, '← 返回工作项列表'),
          ),
          h(IssueDetail, {
            sessionId,
            ident: openIdent,
            writesEnabled: true,
            onClose: () => setOpenIdent(null),
            onChanged: () => { void loadRepoIssues(selected.repoId) },
          }),
        )
      : h(Card, null,
        h(CardTitle, {
          title: '工作项',
          note: programId === null
            ? '工作项挂在「项目 + 仓库」下：先在「项目」分段选一个项目，再来这里新建'
            : `Gitee 企业版 \`project_id\` 过滤（仓库 ${selected.name}）；新建时自动挂在仓库下`,
          // 用户口径（m02229 ②）：新建类主操作放左起按钮组，从左往右排
          actions: h(Btn, {
            size: 'sm',
            // 蓝色 = 建工作项（用户口径 m01634 ①：新建按钮要醒目）
            tone: 'blue',
            disabled: programId === null,
            title: programId === null ? '需要先在「项目」分段选中一个项目' : '新建一个工作项并挂在当前仓库下',
            onClick: () => { setCreatedHint(''); setCreating(true) },
          }, '＋ 新建工作项'),
        }),
        // 新建弹窗照 Gitee 网页版的排布（用户口径：之前的行内表单「太难看」）
        h(IssueCreateDialog, {
          open: creating,
          target: {
            programId,
            programName,
            repoId: selected.repoId,
            repoName: selected.name,
          },
          onClose: () => setCreating(false),
          onCreated: (message) => {
            setCreatedHint(message)
            void loadRepoIssues(selected.repoId)
          },
        }),
        createdHint === '' ? null : h(Note, null, createdHint),
        issuesPhase === 'loading'
          ? h(Empty, null, '正在取仓库工作项…')
          : issuesPhase === 'error'
            ? h(ErrorState, { message: '仓库工作项加载失败', detail: issuesError, onRetry: () => void loadRepoIssues(selected.repoId) })
            : repoIssues === null || repoIssues.issues.length === 0
              ? h(Empty, null, '这个仓库下面还没有工作项。点右上角「新建工作项」建一个，它会挂在这个仓库下。')
              : h(List, null, repoIssues.issues.map((it) => h(Row, {
                  key: it.ident,
                  keyText: it.ident,
                  name: it.title,
                  title: `${it.ident} · ${it.typeTitle || '未分类'} · ${it.assignee || '未指派'}`,
                  onClick: () => setOpenIdent(it.ident),
                  onMouseEnter: () => prefetchIssue(it.ident),
                  onFocus: () => prefetchIssue(it.ident),
                  value: h('span', null,
                    h(StatePill, { state: it.state }),
                    it.overdue ? h(Pill, { tone: 'warn' }, `逾期 ${it.overdueDays} 天`) : null,
                  ),
                }))),
      )

  /** 合并请求页签：这个仓库的 PR 列表（点一行跳到合并请求页的抽屉）。 */
  const repoPrCard = selected === null
    ? null
    : h(Card, null,
        h(CardTitle, {
          title: '合并请求',
          note: `仓库 ${selected.name} 的 PR（\`/pr/list?repoId=\`）`,
          // 用户口径（m02229 ②）：新建 PR 放左起按钮组
          actions: h(Btn, {
            size: 'sm',
            // 紫色 = 建 PR（与蓝色的「新建工作项」区分开）
            tone: 'purple',
            title: '带着这个仓库去建合并请求',
            // 带着仓库 id 进对话框（`#newpr=<repoId>` 由项目视图解析）
            onClick: () => {
              if (typeof window !== 'undefined') window.location.hash = `#newpr=${selected.repoId}`
            },
          }, '＋ 新建 PR'),
          right: h('span', { style: { display: 'inline-flex', gap: 8 } },
            h('button', {
              type: 'button',
              className: css.gqVBtn,
              onClick: () => {
                // 深链交给合并请求页自己解析（与 `#pr=<repoId>:<iid>` 同一套规则）
                if (typeof window !== 'undefined') window.location.hash = `#pr=${selected.repoId}:`
              },
            }, '去合并请求页 →')),
        }),
        prPhase === 'loading'
          ? h(Empty, null, '正在取仓库合并请求…')
          : prPhase === 'error'
            ? h(ErrorState, { message: '合并请求加载失败', detail: prError, onRetry: () => void loadRepoPrs(selected.repoId) })
            : prItems === null || prItems.length === 0
              ? h(Empty, null, '这个仓库还没有合并请求。')
              : h(List, null, prItems.map((pr) => h(Row, {
                  key: pr.iid,
                  keyText: `!${pr.iid}`,
                  name: pr.title,
                  title: `${pr.sourceBranch} → ${pr.targetBranch}`,
                  onClick: () => {
                    if (typeof window !== 'undefined') window.location.hash = `#pr=${pr.repoId}:${pr.iid}`
                  },
                  value: h('span', null,
                    h(Pill, { tone: pr.state === 'merged' ? 'ok' : pr.state === 'closed' ? 'err' : undefined }, pr.state === 'opened' ? '打开' : pr.state === 'merged' ? '已合并' : '已关闭'),
                    pr.checkState === 2 ? h(Pill, { tone: 'ok' }, '审查通过') : null,
                    pr.testState === 2 ? h(Pill, { tone: 'ok' }, '测试通过') : null,
                  ),
                }))),
      )

  return h('div', null,
    h('div', { className: css.gqVSplit },
      h('div', { style: { flex: '0 0 auto', width: listWidth, minWidth: 0, alignSelf: 'stretch' } }, listCard),
      h(ColResizer, { width: listWidth, onResize: setListWidth }),
      h('div', { className: css.gqVSplitMain },
        infoCard,
        tabBar,
        tab === 'issues' ? issuesCard : tab === 'pr' ? repoPrCard : wikiCard,
        tab === 'wiki' ? pageCard : null,
      ),
    ),
  )
}

/** WIKI 正文卡片（预览分工与 DocPanel 一致）。 */
function pageCardOf(props: {
  page: WikiPageResponse | null
  pageError: string
  delegated: boolean
  delegatedPath: string
  pagePath: string
  sidebarReady: boolean
}) {
  const { page, pageError, delegated, delegatedPath, pagePath, sidebarReady } = props
  if (page === null && pageError === '' && pagePath === '') return null
  return h(Card, null,
    h(CardTitle, {
      title: page === null ? (pagePath === '' ? 'WIKI 正文' : pagePath) : page.title,
      note: page === null ? '' : `${page.path} · ${(page.bytes / 1024).toFixed(1)} KB`,
    }),
    pageError !== ''
      ? h(ErrorState, { message: '正文读取失败', detail: pageError })
      : page === null
        ? h(Empty, null, '正在读取…')
        : delegated
          ? h(Note, null,
              '已在侧边栏打开：',
              h('code', null, delegatedPath),
              h('br'),
              `本地缓存：${page.localPath}`,
              h('br'),
              h('span', { className: css.gqVDim },
                '若侧边栏提示"路径在工作区之外"，那是它的**文件围栏**（默认开）在拦 —— 按它给的按钮关掉即可。'))
          : h('div', null,
              h(Note, null, `已缓存到 ${page.localPath}`),
              INLINE_PREVIEW_EXT.has(extOf(page.name))
                ? h('div', { className: css.gqVMd, style: { maxHeight: 460, overflow: 'auto', marginTop: 6 } },
                    h(Markdown, { text: page.content }))
                : h(Note, null, h('span', { className: css.gqVWarn },
                    `.${extOf(page.name) || '未知'} 类型不支持内联预览，已缓存到本地。`)),
              page.truncated ? h(Note, null, h('span', { className: css.gqVWarn }, '⚠ 正文超长已截断显示。')) : null,
            ),
  )
}
