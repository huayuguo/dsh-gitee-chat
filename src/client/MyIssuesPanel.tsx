/**
 * 「我的工作项」页签 —— 负责人**或**协作者是我的工作项，跨项目汇总。
 *
 * 数据来源刻意选「零额外请求」：`board.myIssues` 是脚本在**已经取到的那批工作项**
 * 上过滤出来的（见 `scripts/gitee/gq.mjs` 的 `finalize`）。所以这个页签打开是瞬时的，
 * 不会再单独打一轮企业 API —— 这也是用户抱怨「点一下就要重拉」的直接对策之一。
 *
 * 点击一行：切到「项目」页签、选中它所属的项目、并直接把那张工作项的详情打开
 * （复用 `GiteeProjectView` 已有的 `openIdent` 下钻通道，不另开一套）。
 *
 * @module dsh-gitee-chat/client/MyIssuesPanel
 */

import { createElement as h, useMemo, useState } from 'react'
import cssB from './board.module.css'
import { Card, CardTitle, Empty, List, Note, Pill, Row, StatePill } from './ui.tsx'
import { Chips, type ChipTone } from './prUi.tsx'
import { prefetchIssue } from './api.ts'
import type { MyIssueRow } from '../types.ts'

/** 面板入参。 */
export interface MyIssuesPanelProps {
  /** `board.myIssues`（老版本脚本没有这个字段时调用方传空数组）。 */
  rows: MyIssueRow[]
  /** 点开一行：跳去该工作项的详情。 */
  onOpen: (row: MyIssueRow) => void
}

/** 状态是不是「已完成」那一类（完成的不用红点提醒）。 */
function isClosed(state: string): boolean {
  return state === 'closed' || state === '已完成' || state === 'closed_issue'
}

/**
 * 我的工作项的汇总行：负责人 / 协作者 / 逾期。
 */
/** 分类筛选：每类一颗色卡（浅底深字，选中实心），逾期单独一套红。 */
type Filter = 'all' | 'open' | 'done' | 'overdue'

const FILTERS: ReadonlyArray<{ key: Filter; label: string; tone: ChipTone }> = [
  { key: 'all', label: '全部', tone: 'slate' },
  { key: 'open', label: '未完成', tone: 'blue' },
  { key: 'done', label: '完成', tone: 'green' },
  { key: 'overdue', label: '逾期', tone: 'red' },
]

export function MyIssuesPanel(props: MyIssuesPanelProps) {
  const rows = props.rows
  const [filter, setFilter] = useState<Filter>('open')
  const owners = rows.filter((row) => row.role === 'owner')
  const collabs = rows.filter((row) => row.role === 'collaborator')
  const overdue = rows.filter((row) => row.overdue && !isClosed(row.state))
  const done = rows.filter((row) => isClosed(row.state))
  const open = rows.filter((row) => !isClosed(row.state))

  const counts: Record<Filter, number> = {
    all: rows.length,
    open: open.length,
    done: done.length,
    overdue: overdue.length,
  }

  const shown = useMemo(() => {
    if (filter === 'open') return open
    if (filter === 'done') return done
    if (filter === 'overdue') return overdue
    return rows
    // rows/open/done/overdue 都是同一份 props.rows 的派生值，依赖 filter 足够
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, rows])

  return (
    <Card>
      <CardTitle
        title="我的工作项"
        note={`负责人 ${owners.length} · 协作者 ${collabs.length} · 逾期 ${overdue.length}`}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <Chips
          items={FILTERS.map((item) => ({ ...item, label: `${item.label} ${counts[item.key]}` }))}
          value={filter}
          onChange={(key) => setFilter(key)}
        />
        <span className={cssB.gqVDim} style={{ fontSize: 11.5 }}>口径：负责人是我，或协作者里有我</span>
      </div>
      {shown.length === 0 && rows.length > 0
        ? <Empty>当前分类下没有工作项，切上面的色卡看别的分类。</Empty>
        : rows.length === 0
        ? (
          <Empty>
            这个企业里还没有指派给我或拉我当协作者的工作项。
            <Note>口径：负责人是我，或协作者里有我。数据取自看板同一批工作项，不额外拉取。</Note>
          </Empty>
        )
        : (
          <List>
            {shown.map((row) => h(Row, {
              key: `${row.programId}:${row.ident}`,
              keyText: row.ident,
              // 逾期用红点，进行中用灰点，完成的不打点
              color: isClosed(row.state) ? 'var(--dsw-alias-border-l2)' : row.overdue ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)',
              name: h('span', null,
                h('span', null, row.title),
                h('span', { className: cssB.gqVDim, style: { marginLeft: 8 } },
                  `${row.programName === '' ? '未挂项目' : row.programName}${row.priorityHuman === '' ? '' : ` · ${row.priorityHuman}`}`),
              ),
              value: h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
                row.role === 'owner'
                  ? h(Pill, { tone: 'ok', title: '我是负责人' }, '负责人')
                  : h(Pill, { title: '我是协作者' }, '协作者'),
                row.overdue && !isClosed(row.state) ? h(Pill, { tone: 'err' }, '逾期') : null,
                h(StatePill, { state: row.state }),
                row.deadline === '' ? null : h('span', { className: cssB.gqVDim }, row.deadline),
              ),
              onClick: () => props.onOpen(row),
              // 悬停即预取详情，点下去直接命中宿主 30s 缓存
              onMouseEnter: () => prefetchIssue(row.ident),
              title: `打开 ${row.ident}（在「项目」页签里）`,
            }))}
          </List>
        )}
    </Card>
  )
}
