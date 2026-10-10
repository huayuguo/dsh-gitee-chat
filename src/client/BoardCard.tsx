/**
 * 看板卡片：在对话流里渲染 Gitee 项目全景。
 *
 * 数据来自插件自己的路由（`/api/gitee-chat/payload`），**不经过模型**——
 * 所以卡片能展示任意体量的数据而不占上下文。
 *
 * 本文件只管「取数与状态机」，视觉全在 `BoardView`（纯展示，可确定性测试）。
 *
 * @module dsh-gitee-chat/client/BoardCard
 */

import { createElement as h, useCallback, useEffect, useMemo, useState } from 'react'
import css from './board.module.css'
import { BoardApiError, fetchBoard } from './api.ts'
import { BoardView } from './BoardView.tsx'
import type { BoardArgs, PayloadResponse } from './api.ts'

/** 从工具调用块里读出参数（running 与 settled 两种形态字段不同）。 */
function readArgs(block: any): BoardArgs {
  const raw = block?.call?.argsRaw ?? block?.argsRaw
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? (parsed as BoardArgs) : {}
  } catch {
    return {}
  }
}

/** 卡片内部状态。 */
type CardState =
  | { status: 'waiting' }
  | { status: 'loading' }
  | { status: 'ok'; data: PayloadResponse }
  | { status: 'error'; error: BoardApiError }

/** 失败态的可行动提示（比一个红色方块有用得多）。 */
function errorHint(error: BoardApiError): string {
  switch (error.code) {
    case 'no-token':
      return '未配置 Gitee 企业版 token：设置环境变量 GITEE_ENT_MCP_ACCESS_TOKEN，或写入 $DSH_HOME/.gitee-chat/token，然后点「重试」。'
    case 'timeout':
      return '脚本执行超时。可缩小范围（指定单个项目）或调大 scriptTimeoutMs 后重试。'
    case 'network':
      return '连不上宿主路由。确认插件已挂载且页面已刷新。'
    default:
      return `取数失败：${error.message}`
  }
}

/**
 * 看板卡片主组件。`props` 是 slot 注入的 ToolCallOwnerProps。
 * @param props.block - 运行中或已结算的工具调用块。
 */
export function BoardCard(props: any) {
  const block = props?.block
  /** 已结算：ToolResultNode 带 kind 字段，RunningToolCall 没有。 */
  const settled = block?.kind === 'tool-result'

  const argsRaw = block?.call?.argsRaw ?? block?.argsRaw ?? ''
  const args = useMemo(() => readArgs(block), [argsRaw])
  const argsKey = `${args.scope === 'mywork' ? 'mywork' : 'portfolio'}:${args.program ?? 'all'}`

  const [state, setState] = useState<CardState>({ status: 'waiting' })

  const load = useCallback(async (refresh: boolean, signal?: AbortSignal) => {
    setState({ status: 'loading' })
    try {
      const data = await fetchBoard({ scope: args.scope, program: args.program, refresh }, signal)
      if (signal?.aborted !== true) setState({ status: 'ok', data })
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return
      setState({
        status: 'error',
        error: error instanceof BoardApiError
          ? error
          : new BoardApiError('script-failed', error instanceof Error ? error.message : String(error)),
      })
    }
  }, [args.scope, args.program])

  useEffect(() => {
    if (!settled) {
      setState({ status: 'waiting' })
      return
    }
    const controller = new AbortController()
    void load(false, controller.signal)
    return () => controller.abort()
  }, [settled, argsKey, load])

  // ── 拉取中 ──────────────────────────────────────────────────────────────
  if (state.status === 'waiting' || state.status === 'loading') {
    return h('div', { className: css.gqCard },
      h('div', { className: css.gqState },
        h('span', { className: css.gqSpinner }),
        h('span', null, state.status === 'waiting' ? '等待取数脚本…' : '正在拉取 Gitee 数据…'),
      ),
    )
  }

  // ── 失败 ────────────────────────────────────────────────────────────────
  if (state.status === 'error') {
    return h('div', { className: css.gqCard },
      h('div', { className: css.gqError },
        h('div', { className: css.gqErrorCode }, state.error.code),
        h('div', null, state.error.message),
      ),
      h('div', { className: css.gqHint }, errorHint(state.error)),
      h('div', { className: css.gqFoot },
        h('span', null, 'Gitee 看板'),
        h('button', { className: css.gqBtn, onClick: () => void load(true) }, '重试'),
      ),
    )
  }

  // ── 成功 ────────────────────────────────────────────────────────────────
  return h(BoardView, {
    payload: state.data.payload,
    cached: state.data.cached,
    degraded: state.data.degraded,
    onRefresh: () => void load(true),
  })
}
