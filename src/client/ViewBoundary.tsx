/**
 * 视图错误边界。
 *
 * 为什么需要它：客户端插件抛错时 React 会把这块子树整片卸掉 —— 用户看到的是**白屏**，
 * 手上没有任何线索（控制台又不一定开）。有了边界，至少能在页面上看到
 * 「哪一步炸了 + 原始报错」，反馈问题时截图就够。
 *
 * 只包 `conversation.view` 的正文，不包整个插件：顶栏/标签行还能点，能切回别的页签。
 *
 * @module dsh-gitee-chat/client/ViewBoundary
 */

import { Component, createElement as h, type ErrorInfo, type ReactNode } from 'react'

/** 边界的 props。 */
export interface ViewBoundaryProps {
  /** 被保护的子树。 */
  children: ReactNode
  /** 出错时显示的标题（默认「这个页签渲染失败」）。 */
  title?: string
}

/** 边界的 state。 */
interface ViewBoundaryState {
  /** 捕获到的错误；null = 正常。 */
  error: Error | null
}

/** 渲染错误边界（类组件，React 只支持类做 error boundary）。 */
export class ViewBoundary extends Component<ViewBoundaryProps, ViewBoundaryState> {
  state: ViewBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ViewBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 保留一份到控制台，方便用户直接复制给开发
    console.error('[dsh-gitee-chat] 视图渲染失败：', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children
    return h('div', {
      style: {
        margin: '12px 0',
        padding: '14px 16px',
        borderRadius: 10,
        border: '1px solid var(--gq-danger, #dc2626)',
        background: 'color-mix(in srgb, var(--gq-danger, #dc2626) 6%, transparent)',
        fontSize: 12,
        lineHeight: 1.7,
        color: 'var(--gq-text, #1f2328)',
      },
    },
      h('div', { style: { fontWeight: 600, marginBottom: 6 } }, this.props.title ?? '这个页签渲染失败'),
      h('div', { style: { color: 'var(--gq-text-2, #57606a)', marginBottom: 6 } },
        '这是渲染期的异常，不是数据问题。把下面这段发给开发即可；点其它页签还能继续用。'),
      h('pre', {
        style: {
          margin: 0,
          padding: '10px 12px',
          borderRadius: 8,
          background: 'var(--gq-surface, #fff)',
          border: '1px solid var(--gq-border, #d0d7de)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          fontSize: 12,
        },
      }, `${error.name}: ${error.message}\n${error.stack ?? ''}`.trim()),
    )
  }
}
