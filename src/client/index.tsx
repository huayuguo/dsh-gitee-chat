/**
 * dsh-gitee-chat · client 半。
 *
 * 唯一职责：把 `gitee_board` 这个工具的调用卡片，替换成会话内的看板渲染器。
 *
 * 为什么用 `tool.call.toolview`：它的 key 就是**线上工具名**，key 域是开放的
 * （已占用的只有 15 个内置工具），所以为自定义工具注册卡片是增量行为，
 * 不会影响任何既有 UI；而不注册时该工具自动回落到通用卡片。
 *
 * 注意（与官方配方一致）：本文件被 esbuild 打成 CJS + ModuleLoader 包装，
 * 不能用 JSX 之外的全局，React 必须从 require('react') 取。
 *
 * @module dsh-gitee-chat/client
 */

import { CSS_TEXT } from './board.module.css'
import { CSS_TEXT as ISSUE_CSS_TEXT } from './issue.module.css'
import { CSS_TEXT as PR_CSS_TEXT } from './pr.module.css'
import { BoardCard } from './BoardCard.tsx'
import { GiteeProjectView } from './GiteeProjectView.tsx'
import { GiteeSettingsSection } from './TokenSettings.tsx'
import { bindRuntime } from './runtime.ts'
import { bindSidebar } from './sidebar.ts'
import { TOKENS_CSS } from './tokens.ts'

/** 样式元素 id（幂等注入，卸载时移除）。 */
const STYLE_ID = 'dsh-gitee-chat-style'

/**
 * 注入的样式文本：令牌 + 0.5.4 工作台样式 + 旧看板卡片样式。
 *
 * 令牌（`--gq-*`）只在 `[data-gq-root]` 作用域里定义（见 tokens.ts），
 * 组件树根节点都带这个属性 —— 这样变量既不会漏到产品样式里，
 * 也不需要页面里出现任何裸色值。
 */
// 每加一个 `.module.css` 都必须在这里登记，否则类名有映射、样式却没注入
// （新增弹窗时就踩过：弹窗被渲染成没有定位的裸块，整页被撑开）
const STYLE_TEXT = [TOKENS_CSS, PR_CSS_TEXT, ISSUE_CSS_TEXT, CSS_TEXT].join('\n')

/**
 * 注入本包样式；返回移除函数。
 * 只创建并持有自己这一个 <style>，不触碰产品 DOM 的其他部分。
 */
function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.getElementById(STYLE_ID)
  if (existing !== null) {
    return () => existing.remove()
  }
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = STYLE_TEXT
  document.head.appendChild(el)
  return () => el.remove()
}

/**
 * 本行依赖的 client 行（**服务依赖声明**，不是 npm 依赖）。
 *
 * `slots` 服务由 `@deepseek-ai/dsh-client-ui-renderer` 提供；声明在这里，
 * 装载器才会先把它物化出来 —— 否则我们只会在下面 `ctx.get('slots')` 拿到
 * `undefined` 然后静默消失（卡片不渲染、还没有日志）。
 */
export const inject = ['slots']

/**
 * 客户端插件主体：注册看板卡片渲染器。
 * @param ctx - 浏览器侧 cordis 上下文。
 */
export function apply(ctx: any): void {
  const slots = ctx.get('slots')
  if (slots === undefined) {
    // 有 inject 声明后这里理论上不会走到；真走到了就**大声报错**，
    // 不要静默 return —— 静默失效在生产里等于"卡片偶尔不出现"且无从排查。
    throw new Error('[dsh-gitee-chat] slots 服务不可用（client 行依赖未满足）')
  }

  ctx.effect(() => injectStyles())

  // 绑定宿主 ctx：AI 审核的 prompt 要靠它取 `sessions.scope(id).conversation.send`
  // 才能投递进会话（见 runtime.ts 的 sendPrompt）。漏了这一句 `sendPrompt` 会直接
  // 返回「运行时尚未挂载」，界面上永远只有黄色提示、消息永远发不出去。
  bindRuntime(ctx)

  // 侧边栏桥接：**可选依赖**。装了 `dsh-better-sidebar` 就把"打开文件"交给它，
  // 没装就本插件自己内联预览 .md（见 client/sidebar.ts 的说明）。
  // 必须在渲染前绑定，所以放在注册槽位之前。
  bindSidebar(ctx)

  // 看板卡片：key 必须与 host 侧工具名完全一致。
  ctx.effect(() => slots.inject('tool.call.toolview', () => slots.register(
    { name: 'tool.call.toolview', key: 'gitee_board' },
    BoardCard,
  )))

  // 整屏视图：与 对话 / 轨迹 / 上下文 并列的第 4 个标签页。
  //
  // ⚠️ 注册在 profile 层 → 这个标签页会出现在**所有**会话里（客户端拿不到会话的 preset）。
  // 0.5.4 起这里**不再按会话 preset 拦截**：数据走 host 的进程级直连 MCP（用户口径
  // 「任何模式都可以」），视图只拿 sessionId 作为「AI 审核默认投递到哪」的提示。
  // order=30 排在上下文（由 dsh-context 注册在 20）之后。
  ctx.effect(() => slots.inject('conversation.view', () => slots.register(
    { name: 'conversation.view', id: 'gitee', order: 30, label: 'Gitee 项目' },
    GiteeProjectView,
  )))

  // ⚠️ 这里**故意不注册 `main` + `sidebar.panellist`**（用户 2026-10-26 口径：
  // 「Gitee 项目可以不影响右侧边栏么，他只跟随会话窗口的区域」）。
  //
  // 机制上的硬约束（读 DSH 客户端包确认）：右侧边栏的 occupant 订阅 `layout.panelInfo`，
  // 只要 `activePanelId !== null`（= 选中了任何全局 main 面板）它就立刻 `show(undefined)`
  // 并 `ctx.layout.closeRightbar()` —— 右列被算成 0 宽，看起来像"整页占了全屏"。
  // 没有任何 register 选项 / ILayout 方法能"打开全局面板但保留右栏"，所以唯一的
  // 座位就是 `conversation.view`（渲染在会话正文区里，`activePanelId` 保持 null）。
  //
  // 代价：左侧栏那个「Gitee 项目」行没有了，入口是会话头的「Gitee 项目」标签。
  // 想换回来（接受右栏消失）只需恢复 git 历史里 0.5.4 的 `main` 注册段。

  // 应用「设置 → Gitee 企业项目」：token 配置的**正式入口**（与「插件市场」并列）。
  //
  // 为什么要有它："token 该在哪配"是机器级的事、与当前会话无关 ——
  // 使用者第一眼会在设置里找它（会话里的标签页不带 token 配置）。
  // id 用自己的 `gitee`（不起 shipped 的 id，免得顶掉别人的格子）；order=45 紧挨插件市场（40）。
  ctx.effect(() => slots.inject('settings.section', () => slots.register(
    { name: 'settings.section', id: 'gitee', order: 45, label: 'Gitee 企业项目' },
    GiteeSettingsSection,
  )))
}
