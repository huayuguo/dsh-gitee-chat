/**
 * 「合并请求」页（原型屏 4）：4 张分类卡 + 视角筛选 + 列表 + 详情抽屉。
 *
 * 口径全部来自宿主 `GET /pr/list` 的 `counts`（它跟列表同一轮取数），
 * 前端**不自己算**「待我审核 / 可合并」，避免两处口径打架。
 * 深链：`#pr=<repoId>:<iid>&dwpane=ai|files|notes&act=merge|check|test`。
 *
 * @module dsh-gitee-chat/client/PrTab
 */

import { useEffect, useMemo, useState } from 'react'
import { createElement as h } from 'react'
import css from './pr.module.css'
import {
  BQ,
  Btn,
  Chips,
  EmptyBox,
  ErrBox,
  Kpi,
  PCard,
  PCardBd,
  PCardHd,
  Skeleton,
  Tag,
  relTime,
  reviewPill,
  testPill,
} from './prUi.tsx'
import { emptyCounts, explainError, fetchPrList, pendingReview, pendingTest, type PrScope, type PrStateFilter } from './prApi.ts'
import { PrDrawer, type PrActionKind, type PrPane } from './PrDrawer.tsx'
import type { PrCounts, PrListResponse, PrSummary } from '../types.ts'

/** 打开中的抽屉。 */
interface DrawerTarget {
  repoId: number
  iid: number
  pane: PrPane
  act: PrActionKind | null
}

/** 从 `location.hash` 解析深链；解析不出具体 PR 就返回 null。 */
function parseHash(hash: string): DrawerTarget | null {
  if (!hash.startsWith('#pr')) return null
  const match = /^#pr=(\d+):(\d+)/.exec(hash)
  if (match === null) return null
  const repoId = Number(match[1])
  const iid = Number(match[2])
  if (!Number.isFinite(repoId) || !Number.isFinite(iid) || repoId <= 0 || iid <= 0) return null
  const pane: PrPane = /[?&]dwpane=files/.test(hash)
    ? 'files'
    : /[?&]dwpane=notes/.test(hash)
      ? 'notes'
      : /[?&]dwpane=ai/.test(hash)
        ? 'ai'
        : 'overview'
  const actMatch = /[?&]act=(merge|check|test|checkAndTest|comment|openCheck|openTest)/.exec(hash)
  const act = actMatch === null ? null : (actMatch[1] as PrActionKind)
  return { repoId, iid, pane, act }
}

/** 合并请求页。 */
export function PrTab(props: {
  sessionId: string
  /** 首次拿到 counts 时回传给外层（页签数字 / 概览卡用）。 */
  onCounts?: (counts: PrCounts) => void
  /** 深链里已经解析好的目标（外层解析不到就传 null）。 */
  deepLink?: DrawerTarget | null
}) {
  const [scope, setScope] = useState<PrScope>('assign')
  const [state, setState] = useState<PrStateFilter>('opened')
  const [query, setQuery] = useState('')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<PrListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<{ message: string; hint: string; code: string } | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [drawer, setDrawer] = useState<DrawerTarget | null>(props.deepLink ?? null)

  // 搜索输入 250ms 防抖（不每敲一个字就打一次宿主）。
  useEffect(() => {
    const timer = setTimeout(() => setKeyword(query.trim()), 250)
    return () => clearTimeout(timer)
  }, [query])

  // 切视角 / 状态 / 搜索时回到第 1 页。
  useEffect(() => { setPage(1) }, [scope, state, keyword])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    fetchPrList(props.sessionId, {
      scope,
      state,
      ...(keyword === '' ? {} : { q: keyword }),
      page,
    }, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return
        setData(next)
        setLoading(false)
        props.onCounts?.(next.counts)
      })
      .catch((cause) => {
        if ((cause as Error | undefined)?.name === 'AbortError') return
        setError(explainError(cause))
        setLoading(false)
      })
    return () => controller.abort()
  }, [props.sessionId, scope, state, keyword, page, reloadKey])

  // 深链：外部传进来的目标 + 运行时 hashchange。
  useEffect(() => {
    if (props.deepLink !== null && props.deepLink !== undefined) setDrawer(props.deepLink)
  }, [props.deepLink])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onHash = () => {
      const parsed = parseHash(window.location.hash)
      if (parsed !== null) setDrawer(parsed)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const counts = data?.counts ?? emptyCounts()
  const items = data?.items ?? []
  const total = data?.total ?? 0
  const hasMore = items.length < total

  const scopeItems = useMemo(() => ([
    { key: 'assign' as PrScope, label: '待我审核', title: '口径：打开 + 待审查 + 我是审查人', tone: 'red' as const },
    { key: 'test' as PrScope, label: '待我测试', title: '口径：打开 + 待测试 + 我是测试人', tone: 'amber' as const },
    { key: 'create' as PrScope, label: '我提出的', title: '口径：我创建的 PR', tone: 'blue' as const },
    { key: 'all' as PrScope, label: '全部', title: '本企业内我能看到的 PR', tone: 'slate' as const },
  ]), [])

  const refresh = () => setReloadKey((key) => key + 1)

  const openDrawer = (target: { repoId: number; iid: number }, pane: PrPane = 'overview') => {
    setDrawer({ repoId: target.repoId, iid: target.iid, pane, act: null })
  }

  const kpis = (
    <div className={css.gqPrGrid4}>
      <Kpi
        tone="warn"
        icon="◎"
        title="待我审核"
        tag="需我动作"
        value={counts.review}
        sub={counts.review === 0 ? '没有等我审的 PR' : '点这张卡只看待我审核'}
        barPercent={counts.review === 0 ? 0 : 100}
        active={scope === 'assign'}
        onClick={() => setScope('assign')}
      />
      <Kpi
        tone="violet"
        icon="⌁"
        title="待我测试"
        tag="需我动作"
        value={counts.test}
        sub={counts.test === 0 ? '没有等我测的 PR' : '点这张卡只看待我测试'}
        barPercent={counts.test === 0 ? 0 : 100}
        active={scope === 'test'}
        onClick={() => setScope('test')}
      />
      <Kpi
        tone="info"
        icon="↗"
        title="我提出的"
        tag="进行中"
        value={counts.mine}
        sub={counts.mine === 0 ? '我还没有打开的 PR' : '点这张卡只看我提的'}
        barPercent={counts.mine === 0 ? 0 : 100}
        active={scope === 'create'}
        onClick={() => setScope('create')}
      />
      <Kpi
        tone="ok"
        icon="✓"
        title="可合并"
        tag="可立即合并"
        value={counts.mergeable}
        sub={counts.mergeable === 0 ? '暂时没有满足条件的' : '审查与测试均已通过'}
        barPercent={counts.mergeable === 0 ? 0 : 100}
        active={scope === 'all'}
        onClick={() => { setScope('all'); setState('opened') }}
      />
    </div>
  )

  const listCard = (
    <PCard>
      <PCardHd
        title="合并请求"
        sub={data === null ? '正在读取…' : `共 ${total} 个 · 当前视角：${scopeItems.find((item) => item.key === scope)?.label ?? scope}`}
        // 用户口径（m02229 ②）：新建 PR 放左起按钮组，从左往右排
        actions={(
          <Btn
            size="sm"
            tone="purple"
            title="在插件里直接建合并请求（不必去 Gitee 网页）"
            // 只改 hash：对话框的开关状态由 GiteeProjectView 统一持有（同 `#pr=` 的做法）
            onClick={() => {
              if (typeof window !== 'undefined') window.location.hash = '#newpr'
            }}
          >＋ 新建 PR</Btn>
        )}
        right={
          <>
            <div className={css.gqPrSearchWrap}>
              <input
                className={`${css.gqPrInput} ${css.gqPrSearch}`}
                placeholder="搜索标题 / 作者 / 分支"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="搜索合并请求"
              />
            </div>
            <Btn size="sm" onClick={refresh} title="重新向宿主取一次（Gitee 侧变了就点这里）">刷新</Btn>
          </>
        }
      />
      <PCardBd style={{ padding: 0 }}>
        <div style={{ padding: '10px 14px' }}>
          <Chips items={scopeItems} value={scope} onChange={(key) => setScope(key)} />
          <div style={{ height: 6 }} />
          <Chips
            items={[
              { key: 'opened' as PrStateFilter, label: '打开', tone: 'green' as const },
              { key: 'merged' as PrStateFilter, label: '已合并', tone: 'purple' as const },
              { key: 'closed' as PrStateFilter, label: '已关闭', tone: 'slate' as const },
              { key: 'all' as PrStateFilter, label: '全部状态', tone: 'cyan' as const },
            ]}
            value={state}
            onChange={(key) => setState(key)}
          />
        </div>
        {loading
          ? <div style={{ padding: '4px 14px 14px' }}><Skeleton rows={5} rowHeight={34} /></div>
          : error !== null
            ? <div style={{ padding: 14 }}><ErrBox message={error.message} hint={error.hint} code={error.code} onRetry={refresh} retryLabel="重试" /></div>
            : items.length === 0
              ? (
                <EmptyBox
                  title={keyword === '' ? '这个视角下没有 PR' : `没有匹配「${keyword}」的 PR`}
                  hint={keyword === ''
                    ? '换个视角或状态看看；也可以去 Gitee 网页确认这个 PR 是否指派给了你。'
                    : '换个关键词，或清空搜索。'}
                  action={<Btn size="sm" onClick={() => { setQuery(''); setState('all'); setScope('all') }}>放宽筛选</Btn>}
                />
              )
              : (
                <div>
                  {items.map((pr) => (
                    <PrRow
                      key={pr.id}
                      pr={pr}
                      onOpen={() => openDrawer(pr)}
                      onAi={() => openDrawer(pr, 'ai')}
                    />
                  ))}
                  {hasMore
                    ? (
                      <div className={css.gqPrListFoot}>
                        <Btn size="sm" onClick={() => setPage((current) => current + 1)}>
                          加载更多（已显示 {items.length} / {total}）
                        </Btn>
                      </div>
                    )
                    : (
                      <div className={css.gqPrListFoot}>
                        <span className={css.gqPrRowStat}>共 {total} 个 · 已全部显示</span>
                      </div>
                    )}
                </div>
              )}
      </PCardBd>
    </PCard>
  )

  return (
    <>
      {kpis}
      {listCard}
      <div className={css.gqPrGrid2}>
        <PCard>
          <PCardHd title="视角与判定口径" sub="界面上所有「待我X / 可合并」都是这一套口径" />
          <PCardBd>
            <div className={css.gqPrRowSub} style={{ display: 'block', lineHeight: 1.8 }}>
              · 待我审核 = 状态打开 + 审查状态待审查 + 我是审查人<br />
              · 待我测试 = 状态打开 + 测试状态待测试 + 我是测试人<br />
              · 我提出的 = 我创建且仍在打开的 PR<br />
              · 可合并 = 我**真实有**合并权限 + 审查已通过 + 测试已通过（`mergeable` 由宿主算，前端不猜）
            </div>
            <BQ tone="info">
              权限来自 `get_enterprise_pull_auth`；取不到时按钮保持不可用并显示原因，不按角色推断。
            </BQ>
          </PCardBd>
        </PCard>
        <PCard>
          <PCardHd title="数据与刷新" sub="PR 数据实时走 Gitee；计数与列表同一轮取数" />
          <PCardBd>
            <div className={css.gqPrRowSub} style={{ display: 'block', lineHeight: 1.8 }}>
              · 列表与四张分类卡来自同一次 `GET /pr/list`（counts 全局口径）<br />
              · 详情 / 文件 / 评论来自 `GET /pr/detail`（打开抽屉时才取）<br />
              · 写动作成功后用宿主返回的新详情刷新（不做乐观更新）
            </div>
            <div className={css.gqPrAiActions} style={{ marginTop: 10 }}>
              <Btn size="sm" onClick={refresh}>立即刷新列表</Btn>
              <span className={css.gqPrRowStat}>{data === null ? '' : `读取于 ${relTime(new Date().toISOString())}`}</span>
            </div>
          </PCardBd>
        </PCard>
      </div>
      {drawer === null
        ? null
        : (
          <PrDrawer
            key={`${drawer.repoId}:${drawer.iid}`}
            sessionId={props.sessionId}
            repoId={drawer.repoId}
            iid={drawer.iid}
            pane={drawer.pane}
            initialAction={drawer.act}
            onPaneChange={(pane) => setDrawer((current) => (current === null ? current : { ...current, pane }))}
            onClose={() => setDrawer(null)}
            onChanged={refresh}
          />
        )}
    </>
  )
}

/** 一行 PR。 */
function PrRow(props: { pr: PrSummary; onOpen: () => void; onAi: () => void }) {
  const pr = props.pr
  const review = reviewPill(pr.checkState, pr.checkPassed, pr.prAssignNum)
  const test = testPill(pr.testState, pr.testPassed, pr.prTestNum)
  const needMe = pendingReview(pr) || pendingTest(pr)
  return (
    <div
      className={css.gqPrRow}
      role="button"
      tabIndex={0}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onOpen()
        }
      }}
    >
      <div className={css.gqPrRowIid}>!{pr.iid}</div>
      <div className={css.gqPrRowBody}>
        <div className={css.gqPrRowTitle}>
          {pr.title}
          {pr.draft ? <Tag tone="muted">草稿</Tag> : null}
        </div>
        <div className={css.gqPrRowSub}>
          <span className={css.gqPrTplName}>{pr.repoPath}</span>
          <span className={css.gqPrBranchCode}>{pr.sourceBranch}</span>
          <span className={css.gqPrBranchArrow}>→</span>
          <span className={css.gqPrBranchCode}>{pr.targetBranch}</span>
          <span>·</span>
          <span>{pr.author?.name ?? '（未知作者）'}</span>
          <span>·</span>
          <span>更新于 {relTime(pr.updatedAt)}</span>
        </div>
        <div className={css.gqPrRowPills}>
          <Tag tone={review.tone}>{review.label}</Tag>
          <Tag tone={test.tone}>{test.label}</Tag>
          {pr.mergeable ? <Tag tone="ok">可合并</Tag> : <Tag tone="muted">不可合并</Tag>}
        </div>
      </div>
      <div className={css.gqPrRowRight} onClick={(event) => event.stopPropagation()}>
        <Btn size="sm" onClick={props.onAi} title="在抽屉里打开 AI 审核页">AI 审核</Btn>
        <Btn size="sm" tone={needMe ? 'primary' : 'default'} onClick={props.onOpen} title="打开详情抽屉">
          {needMe ? '去处理' : '查看'}
        </Btn>
      </div>
    </div>
  )
}

// 说明：这里保留 `h` 的引用，避免 bundler 因 JSX 工厂切换产生告警（与其它 client 文件一致）。
void h
