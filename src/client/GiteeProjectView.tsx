/**
 * 整屏「Gitee 项目」视图 —— 与 对话 / 轨迹 / 上下文 并列的第 4 个标签页。
 *
 * 版式对齐官方「上下文」标签页：卡片 + 卡头 + 分段开关 + 统计格 + 两列带。
 *
 * 与看板卡片的分工：
 *   - **卡片**（`tool.call.toolview`）：贴着那次工具调用，回答"我刚查到了什么"；
 *   - **本视图**：整屏、可下钻、可操作，回答"现在项目里到底有什么、我要改什么"。
 *
 * ⚠️ 一个必须处理的架构事实：客户端插件在 **profile 层**，它注册的
 * `conversation.view` 对**所有 preset** 可见（包括 PTC）。而客户端拿不到会话的
 * preset（`SessionSummary` 里没有）。所以本视图先问 host「这个会话是不是 Gitee 模式」，
 * 不是就只显示一句提示 —— 绝不把 Gitee 看板塞进无关会话。
 *
 * @module dsh-gitee-chat/client/GiteeProjectView
 */

import { createElement as h, useCallback, useEffect, useState } from 'react'
import css from './board.module.css'
import { fetchBoard, fetchIssues, fetchSession } from './api.ts'
import { AnalysisCards } from './AnalysisCards.tsx'
import { DocPanel } from './DocPanel.tsx'
import { RepoPanel } from './RepoPanel.tsx'
import { IssueDetail } from './IssueDetail.tsx'
import { Bar, Card, CardTitle, Empty, ErrorState, Note, Pill, Segmented, Stat, StatGrid, Table, day, stateColor } from './ui.tsx'
import { StateStack, stateLabel } from './charts.tsx'
import type { BoardPayload, ProgramIssues } from './api.ts'
import type { BoardAnalysis } from '../types.ts'

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
  [key: string]: unknown
}

type Phase =
  | { kind: 'probing' }
  | { kind: 'disabled'; preset: string | null }
  | { kind: 'loading' }
  | { kind: 'ready'; board: BoardPayload; cached: boolean; truncated: boolean }
  | { kind: 'error'; message: string }

/** 顶部的四个页签。 */
type Tab = 'project' | 'repos' | 'analysis' | 'docs'

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
  return h(Card, null,
    h(CardTitle, { title: '本会话未使用 Gitee 模式' }),
    h('div', { className: css.gqVDim, style: { lineHeight: 1.8 } },
      '这个标签页只在挂了「Gitee 企业项目管理」或「Gitee 项目执行」预设的会话里显示项目数据。',
      h('br'),
      `当前预设：${props.preset ?? '未知'}。新建会话时在预设里选 Gitee 模式即可。`,
    ),
  )
}

/**
 * 整屏项目视图。
 * @param props - 会话 props（含 sessionId）。
 */
export function GiteeProjectView(props: GiteeProjectViewProps) {
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  const seed = props.preload
  const [phase, setPhase] = useState<Phase>(() => seed === undefined
    ? { kind: 'probing' }
    : { kind: 'ready', board: seed.board, cached: false, truncated: seed.board.truncated === true })
  const [tab, setTab] = useState<Tab>('project')
  const [selected, setSelected] = useState<number | null>(seed?.board.programs[0]?.id ?? null)
  const [issues, setIssues] = useState<ProgramIssues | null>(seed?.issues ?? null)
  const [issueError, setIssueError] = useState<string | null>(null)
  const [openIdent, setOpenIdent] = useState<string | null>(null)
  const [issueFilter, setIssueFilter] = useState<'all' | 'open' | 'overdue'>('open')

  /** 先确认会话是否 Gitee 模式，再取看板数据。 */
  const load = useCallback(async (refresh: boolean, signal?: AbortSignal) => {
    setPhase((prev) => (prev.kind === 'ready' && !refresh ? prev : { kind: 'loading' }))
    try {
      const probe = await fetchSession(sessionId, signal)
      // gitee 为 null 表示 host 还不知道这个会话（刚建、事件未到），
      // 也可能是 host 无法读取该 preset 的组合。两种情况都按"未启用"处理，
      // 宁可不渲染，也不要把 Gitee 数据塞进无关会话。
      if (probe.gitee !== true) {
        setPhase({ kind: 'disabled', preset: probe.preset })
        return
      }
      const res = await fetchBoard({ scope: 'portfolio', refresh }, signal)
      if (signal?.aborted === true) return
      setPhase({ kind: 'ready', board: res.payload, cached: res.cached, truncated: res.payload.truncated === true })
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

  /**
   * 页签：项目 / 仓库 / 固定分析 / 知识库。
   *
   * 与标题**分行**放（需求要求"这一行下面再作一行"）：标题行回答"这是哪家企业、
   * 什么时候拉的数"，这一行才是导航。页签宽度会随「固定分析」的计数变化，
   * 挤在标题右侧会让标题被推着走。
   */
  const tabs = h(Segmented, {
    options: [
      { key: 'project', label: '项目' },
      { key: 'repos', label: '仓库' },
      { key: 'analysis', label: `固定分析${phase.kind === 'ready' && phase.board.analysis ? ` (${phase.board.analysis.totals.nonCompliant + phase.board.analysis.totals.overdue})` : ''}` },
      { key: 'docs', label: '知识库' },
    ],
    value: tab,
    onChange: (key) => setTab(key === 'analysis' ? 'analysis' : key === 'docs' ? 'docs' : key === 'repos' ? 'repos' : 'project'),
  })

  /** 页签行（与标题分行）+ 刷新按钮。 */
  const tabBar = h('div', { className: css.gqVBanner },
    tabs,
    h('button', {
      type: 'button',
      className: css.gqVSegBtn,
      style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 5 },
      onClick: () => void load(true),
    }, '刷新'),
  )

  // ── 非 Gitee 会话：只给一句提示，不渲染任何 Gitee 内容 ────────────────────
  if (phase.kind === 'disabled') {
    return h('div', { className: css.gqRoot, 'data-gq-root': '' }, h(GiteeModeNotice, { preset: phase.preset }))
  }

  if (phase.kind === 'probing' || phase.kind === 'loading') {
    return h('div', { className: css.gqRoot, 'data-gq-root': '' },
      h(Card, null, h(Empty, null, '正在拉取 Gitee 项目数据…')),
    )
  }

  if (phase.kind === 'error') {
    return h('div', { className: css.gqRoot, 'data-gq-root': '' },
      h(Card, null,
        h(CardTitle, { title: 'Gitee 项目' }),
        h(ErrorState, { message: '取数失败', detail: phase.message, onRetry: () => void load(true) }),
        // token / 企业这类配置**不在这里配**（曾经这里有个 ⚙ 设置 弹窗，已删除）：配置入口只有
        // 应用「设置 → Gitee 企业项目」。它必须能在"还没进 Gitee 模式 / 还没 token"时也够得着，
        // 否则就互为前提了。
        h(Note, null, 'token、企业这类配置在应用「设置 → Gitee 企业项目」里改；保存后回来点「重试」即可。'),
      ),
    )
  }

  const board = phase.board
  const analysis: BoardAnalysis | undefined = board.analysis
  const current = board.programs.find((p) => p.id === selected) ?? null

  // ── 顶部：项目摘要条 ────────────────────────────────────────────────────
  const head = h(Card, null,
    h(CardTitle, {
      title: '▣ Gitee 项目',
      note: `${board.enterprise.name || `企业 ${board.enterprise.id}`} · ${board.source === 'fixture' ? '样例数据' : '实时拉取'} · ${board.generatedAt}`
        + (board.me === null ? '' : ` · 我：${board.me.name}`),
      right: h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' } },
        board.source === 'fixture' ? h(Pill, { tone: 'warn' }, '样例数据') : null,
        phase.cached ? h(Pill, null, '缓存') : null,
        phase.truncated ? h(Pill, { tone: 'warn' }, '已截断') : null,
      ),
    }),
    h(StatGrid, null,
      h(Stat, { label: '项目', value: board.kpi.programs }),
      h(Stat, { label: '工作项', value: board.kpi.issues }),
      h(Stat, { label: '进行中', value: board.kpi.progressing }),
      h(Stat, { label: '已完成', value: board.kpi.done }),
      h(Stat, { label: '逾期', value: board.kpi.overdue, tone: board.kpi.overdue > 0 ? 'err' : undefined }),
      h(Stat, { label: '无人认领', value: board.kpi.unassigned, tone: board.kpi.unassigned > 0 ? 'warn' : undefined }),
      analysis === undefined ? null : h(Stat, { label: '规范不合规', value: analysis.totals.nonCompliant, tone: analysis.totals.nonCompliant > 0 ? 'warn' : undefined }),
      analysis === undefined ? null : h(Stat, { label: '过载人员', value: analysis.totals.overloadedOwners, tone: analysis.totals.overloadedOwners > 0 ? 'err' : undefined }),
    ),
    board.truncated === true
      ? h(Note, null, h('span', { className: css.gqVWarn }, '⚠ 工作项数量超过翻页上限，以下统计只覆盖已取到的部分。可在配置里调大 maxPages 或缩小范围。'))
      : null,
  )

  // ── 仓库页签：左仓库列表 + 右 WIKI（WIKI 挂在仓库下面）─────────────────
  //
  // 取数口径由 host 决定（选中项目 → program_id 过滤；未选 → internal-open）。
  if (tab === 'repos') {
    return h('div', { className: css.gqRoot, 'data-gq-root': '' },
      head,
      tabBar,
      h(RepoPanel, {
        sessionId,
        programId: selected,
        programName: current?.name ?? '',
      }),
    )
  }

  // ── 知识库页签：文档列在左、页树与正文在右（按需读取，不预拉）──────────
  //
  // 数据全部由 host 经 MCP 工具取得：本视图不拼任何文档端点。
  if (tab === 'docs') {
    return h('div', { className: css.gqRoot, 'data-gq-root': '' },
      head,
      tabBar,
      h(DocPanel, {
        sessionId,
        programId: selected,
        programName: current?.name ?? '',
      }),
    )
  }

  // ── 固定分析页签 ────────────────────────────────────────────────────────
  if (tab === 'analysis') {
    return h('div', { className: css.gqRoot, 'data-gq-root': '' },
      head,
      tabBar,
      analysis === undefined
        ? h(Card, null, h(Empty, null, '本次数据未包含固定分析（脚本版本较旧？）'))
        : h(AnalysisCards, { analysis, managementEnabled: true }),
    )
  }

  // ── 项目页签：左项目列表 + 右工作项（下钻到详情）────────────────────────
  const nav = h(Card, null,
    h(CardTitle, { title: '项目', note: `${board.programs.length} 个` }),
    board.programs.length === 0
      ? h(Empty, null, '没有可见的项目')
      : h('div', { className: css.gqVNavScroll },
          board.programs.map((p) => h('div', {
            key: p.id,
            className: `${css.gqVNavItem} ${p.id === selected ? css.gqVNavOn : ''}`,
            role: 'button',
            tabIndex: 0,
            onClick: () => { setSelected(p.id); setOpenIdent(null) },
          },
            h('div', { className: css.gqVNavName, title: p.name }, p.name),
            h('div', { className: css.gqVNavSub },
              h('span', { title: p.assignee || '未指派' }, p.assignee || '未指派'),
              p.overdue > 0
                ? h('span', { className: css.gqVErr }, `⚠︎${p.overdue}`)
                : h('span', null, `${p.total} 项`),
            ),
          )),
        ),
  )

  const filtered = issues === null ? [] : issues.issues.filter((it) => {
    if (issueFilter === 'open') return it.state !== 'closed' && it.state !== 'rejected'
    if (issueFilter === 'overdue') return it.overdue
    return true
  })

  const detailPanel = h('div', { className: css.gqVCol },
    nav,
  )

  const workItems = h(Card, null,
    h(CardTitle, {
      title: current === null ? '工作项' : current.name,
      note: current === null ? '左侧选择一个项目' : `${current.category || '—'} · 负责人 ${current.assignee || '未指派'}`,
      right: h(Segmented, {
        options: [
          { key: 'open', label: '未完成' },
          { key: 'overdue', label: '逾期' },
          { key: 'all', label: '全部' },
        ],
        value: issueFilter,
        onChange: (key) => setIssueFilter(key === 'overdue' ? 'overdue' : key === 'all' ? 'all' : 'open'),
        disabled: issues === null,
      }),
    }),

    current === null ? h(Empty, null, '左侧选择一个项目') : h('div', null,
      // 进度 + 状态分布
      h('div', { className: css.gqVStats, style: { marginBottom: 8 } },
        h(Stat, { label: '完成率', value: `${current.progress}%` }),
        h(Stat, { label: '工作项', value: current.total }),
        h(Stat, { label: '已完成', value: current.done, tone: 'ok' }),
        h(Stat, { label: '进行中', value: current.progressing }),
        h(Stat, { label: '逾期', value: current.overdue, tone: current.overdue > 0 ? 'err' : undefined }),
      ),
      h(Bar, { percent: current.progress, title: `${current.progress}% 已完成` }),
      issues === null && issueError === null
        ? h(Empty, null, '正在拉取工作项…')
        : issueError !== null
          ? h(ErrorState, { message: '工作项加载失败', detail: issueError })
          : h('div', { style: { marginTop: 10 } },
              issues !== null && issues.truncated
                ? h(Note, null, h('span', { className: css.gqVWarn }, '⚠ 工作项数量超过翻页上限，列表已截断。'))
                : null,
              h(StateStack, { rows: issues?.distribution ?? [] }),
              h('div', { style: { marginTop: 8 } },
                issues !== null && issues.distribution.length === 0
                  ? h(Empty, null, '该项目下暂无工作项')
                  : h(Table, { head: ['编号', '标题', '负责人', '状态', '截止', '逾期'] },
                      filtered.length === 0
                        ? h('tr', null, h('td', { colSpan: 6 }, h(Empty, null, '当前筛选下没有工作项')))
                        : filtered.map((it) => h('tr', {
                            key: it.ident,
                            style: { cursor: 'pointer' },
                            onClick: () => setOpenIdent(it.ident),
                          },
                            h('td', { className: `${css.gqVNum} ${css.gqVDim}` }, it.ident),
                            h('td', { title: '点击查看描述 / 前置依赖 / 评论讨论' }, it.title),
                            h('td', { className: css.gqVDim }, it.assignee || '未指派'),
                            h('td', null, h('span', { style: { color: stateColor(it.state) } }, stateLabel(it.state))),
                            h('td', { className: css.gqVNum }, day(it.deadline)),
                            h('td', { className: css.gqVNum }, it.overdue ? h('span', { className: css.gqVErr }, `+${it.overdueDays}d`) : ''),
                          )),
                    ),
              ),
              h(Note, null, '点击任意一行查看工作项详情（描述 / 前置依赖 / 评论讨论），并可直接改状态、改派、发评论。'),
            ),
    ),
  )

  return h('div', { className: css.gqRoot, 'data-gq-root': '' },
    head,
    tabBar,
    openIdent === null
      ? h('div', { className: css.gqVCols },
          h('div', { className: css.gqVCol, style: { flex: '0 1 260px' } }, detailPanel),
          h('div', { className: css.gqVCol }, workItems),
        )
      : h('div', null,
          h('div', { className: css.gqVBanner },
            h('button', { type: 'button', className: css.gqVSegBtn, style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 5 }, onClick: () => setOpenIdent(null) }, '← 返回工作项列表'),
          ),
          h(IssueDetail, {
            sessionId,
            ident: openIdent,
            writesEnabled: true,
            onClose: () => setOpenIdent(null),
            onChanged: () => { void load(true) },
          }),
        ),
  )
}
