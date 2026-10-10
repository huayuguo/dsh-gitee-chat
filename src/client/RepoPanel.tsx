/**
 * 「仓库」面板 —— 整屏 Gitee 项目视图里与 项目 / 固定分析 / 知识库 并列的分段。
 *
 * ## 两个口径（需求原话）
 *
 *   - **选中了项目** → 只列**该项目下的**仓库（host 用 `program_id` 过滤）；
 *   - **没选项目** → 只列**企业内部开源**的仓库（`scope=internal-open`）。
 *
 * 两种都是 Gitee 自己的过滤参数，插件不自己筛。
 *
 * ## WIKI 为什么挂在仓库下面
 *
 * Gitee 的仓库 WIKI 是**仓库的一个子功能**（`/projects` 上的
 * `wiki_enabled_with_content` 就是它），不是企业/项目知识库那一套 `doc_nodes`
 * —— 后者是企业级或项目级，跟仓库没有从属关系（实测传仓库 id 返回 0）。
 * 所以"仓库下面展示 WIKI"是**唯一**符合 Gitee 数据模型的位置。
 *
 * ## 预览分工（与知识库面板一致）
 *
 * 装了 `dsh-better-sidebar` 就点一下交给它；没装则只内联预览 `.md`。
 * 见 `client/sidebar.ts`。
 *
 * @module dsh-gitee-chat/client/RepoPanel
 */

import { createElement as h, useCallback, useEffect, useState } from 'react'
import css from './board.module.css'
import { fetchRepos, fetchWiki, fetchWikiPage } from './api.ts'
import { sidebarAvailable, sidebarOpenFile } from './sidebar.ts'
import { Card, CardTitle, Empty, ErrorState, Markdown, Note, Pill, Segmented, Stat, StatGrid, day } from './ui.tsx'
import type { RepoListResponse, RepoRow, WikiPageRow, WikiPageResponse, WikiTreeResponse } from '../types.ts'

/** 面板入参。 */
export interface RepoPanelProps {
  /** 当前会话 id（host 靠它解析 agent 作用域）。 */
  sessionId: string
  /** 当前选中的项目（null = 只列企业内部开源仓库）。 */
  programId: number | null
  /** 项目名。 */
  programName: string
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
  const [scope, setScope] = useState<'project' | 'internal'>(programId === null ? 'internal' : 'project')

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

  /** 选中一个仓库：有 WIKI 才去拉（没 WIKI 不白跑一趟 git）。 */
  const pick = useCallback((repo: RepoRow) => {
    setSelected(repo)
    setWiki(null)
    setWikiPhase('idle')
    setPage(null)
    setPageFilter('')
    setDelegated(false)
    setDelegatedPath('')
    if (repo.wiki) void loadWiki(repo, false)
    else setWikiPhase('ready')
  }, [loadWiki])

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

  const listCard = h(Card, null,
    h(CardTitle, {
      title: '仓库',
      note: list === null
        ? '按项目取数'
        : (list.mode === 'project'
            ? `项目「${list.programName || list.programId}」下的仓库 · ${list.total} 个`
            : `未选项目 · 企业内部开源仓库 ${list.total} 个`),
      right: h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' } },
        h(Segmented, {
          options: [
            { key: 'project', label: '本项目' },
            { key: 'internal', label: '企业内部开源' },
          ],
          value: scope,
          onChange: (key) => setScope(key === 'internal' ? 'internal' : 'project'),
          disabled: programId === null,
        }),
        h('button', {
          type: 'button',
          className: css.gqVSegBtn,
          style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 5 },
          onClick: () => void load(),
        }, '刷新'),
      ),
    }),
    scope === 'project' && programId === null
      ? h(Note, null, '当前没有选中项目，已切到「企业内部开源」。')
      : null,
    list !== null ? h(Note, null, list.notice) : null,
    phase === 'loading'
      ? h(Empty, null, '正在拉取仓库列表…')
      : phase === 'error'
        ? h(ErrorState, { message: '仓库列表加载失败', detail: error, onRetry: () => void load() })
        : repos.length === 0
          ? h(Empty, null, list?.mode === 'project' ? '该项目名下没有仓库' : '企业内部没有开源仓库')
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
          : h(Note, null, 'Gitee 的 `wiki_enabled_with_content` 对这个仓库是 false —— 它没有 WIKI 内容。'),
      )

  const pageCard = pageCardOf({ page, pageError, delegated, delegatedPath, pagePath, sidebarReady: sidebarAvailable() })

  return h('div', null,
    h(Note, null,
      list?.mode === 'project'
        ? `当前口径：**项目下的仓库**（Gitee 的 \`program_id\` 过滤，项目「${programName || programId}」）。切到「企业内部开源」就只列企业内部开源的仓库。`
        : '当前口径：**企业内部开源**（Gitee 的 `scope=internal-open`）。切回「本项目」就只列当前项目名下的仓库。',
      h('br'),
      'WIKI 挂在仓库下面：Gitee 的 WIKI 是**仓库的子功能**（`wiki_enabled_with_content`），与「知识库」分段里的企业/项目知识库（`doc_nodes`）是两套东西。',
    ),
    h('div', { className: css.gqVCols },
      h('div', { className: css.gqVCol, style: { flex: '0 1 340px' } }, listCard),
      h('div', { className: css.gqVCol }, infoCard, wikiCard, pageCard),
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
              '已在**侧边栏**打开：',
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
                    `本插件不预览 .${extOf(page.name) || '未知'}。`
                    + (sidebarReady ? '已检测到侧边栏，但没能交给它。' : '装 `dsh-better-sidebar` 后点击即由它打开。'))),
              page.truncated ? h(Note, null, h('span', { className: css.gqVWarn }, '⚠ 正文超长已截断显示。')) : null,
            ),
  )
}
