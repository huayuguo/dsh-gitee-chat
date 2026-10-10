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
/**
 * 看板卡片主组件。`props` 是 slot 注入的 ToolCallOwnerProps。
 * @param props.block - 运行中或已结算的工具调用块。
 */
export declare function BoardCard(props: any): import("react").DetailedReactHTMLElement<{
    className: string;
}, HTMLElement> | import("react").FunctionComponentElement<import("./BoardView.tsx").BoardViewProps>;
