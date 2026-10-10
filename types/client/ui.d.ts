/**
 * 整屏视图的共享 UI 原件。
 *
 * 版式语言对齐 DSH 官方的「上下文」标签页：卡片 + 卡头 + 分段开关 + 统计格 +
 * 行列表 + 居中空态/错误态。这里只放**无状态**的原件，取数与状态机在别处。
 *
 * @module dsh-gitee-chat/client/ui
 */
import { type ReactNode } from 'react';
/** 卡片：视图里所有内容的容器单位。 */
export declare function Card(props: {
    children?: ReactNode;
    style?: Record<string, unknown>;
    grow?: boolean;
}): import("react").DetailedReactHTMLElement<{
    className: string;
    style: Record<string, unknown>;
}, HTMLElement>;
/**
 * 卡头：左侧标题（不换行）+ 可选说明 + 右侧控件（自动靠右）。
 * @param props.title - 标题文本。
 * @param props.note - 标题右侧的次要说明。
 * @param props.right - 右侧控件（通常是分段开关）。
 */
export declare function CardTitle(props: {
    title: ReactNode;
    note?: ReactNode;
    right?: ReactNode;
}): import("react").DetailedReactHTMLElement<{
    className: string;
}, HTMLElement>;
/** 分段开关的一项。 */
export interface SegOption {
    key: string;
    label: ReactNode;
    title?: string;
}
/**
 * 分段开关（标题右侧的 Step/Turn 同款）。
 * @param props.options - 选项。
 * @param props.value - 当前选中项的 key。
 * @param props.onChange - 切换回调。
 * @param props.disabled - 整体禁用。
 */
export declare function Segmented(props: {
    options: readonly SegOption[];
    value: string;
    onChange: (key: string) => void;
    disabled?: boolean;
}): import("react").DetailedReactHTMLElement<{
    className: string;
}, HTMLElement>;
/** 一格统计（Context Stats 的 Turns/Steps 同款）。 */
export declare function Stat(props: {
    label: ReactNode;
    value: ReactNode;
    tone?: 'warn' | 'err' | 'ok';
    title?: string;
}): import("react").DetailedReactHTMLElement<{
    className: string;
    title: string;
}, HTMLElement>;
/** 一行统计格；`auto-fit` 会自动折行。 */
export declare function StatGrid(props: {
    children?: ReactNode;
}): import("react").DetailedReactHTMLElement<{
    className: string;
}, HTMLElement>;
/** 居中的次要提示（空态）。 */
export declare function Empty(props: {
    children?: ReactNode;
}): import("react").DetailedReactHTMLElement<{
    className: string;
}, HTMLElement>;
/**
 * 居中的错误态（带等宽的原始信息 + 重试）。
 * @param props.message - 可读的说明。
 * @param props.detail - 原始错误信息（等宽显示）。
 * @param props.onRetry - 重试回调；不给就不渲染按钮。
 */
export declare function ErrorState(props: {
    message: ReactNode;
    detail?: string;
    onRetry?: () => void;
}): import("react").DetailedReactHTMLElement<{
    className: string;
}, HTMLElement>;
/** 小徽标。 */
export declare function Pill(props: {
    children?: ReactNode;
    tone?: 'warn' | 'err' | 'ok';
    title?: string;
}): import("react").DetailedReactHTMLElement<{
    className: string;
    title: string;
}, HTMLElement>;
/** 彩色圆点（图例 / 健康度）。 */
export declare function Dot(props: {
    color: string;
    title?: string;
}): import("react").DetailedReactHTMLElement<{
    className: string;
    style: {
        background: string;
    };
    title: string;
}, HTMLElement>;
/** 一根细条（进度 / 得分 / 占比）。 */
export declare function Bar(props: {
    percent: number;
    color?: string;
    title?: string;
}): import("react").DetailedReactHTMLElement<{
    className: string;
    title: string;
}, HTMLElement>;
/**
 * 行列表的一行：`[key] 名称 ………… 数值`。
 * @param props.onClick - 给了就是可点的行。
 */
export declare function Row(props: {
    keyText?: ReactNode;
    color?: string;
    name: ReactNode;
    value?: ReactNode;
    title?: string;
    active?: boolean;
    onClick?: () => void;
}): import("react").DetailedReactHTMLElement<{
    className: string;
    title: string;
    onClick: () => void;
    role: "button";
    tabIndex: number;
}, HTMLElement>;
/** 可滚动的行列表容器。 */
export declare function List(props: {
    children?: ReactNode;
    scroll?: boolean;
}): import("react").DetailedReactHTMLElement<{
    className: string;
}, HTMLElement>;
/** 迷你表格。 */
export declare function Table(props: {
    head: ReactNode[];
    children?: ReactNode;
}): import("react").DetailedReactHTMLElement<{
    className: string;
}, HTMLElement>;
/** 一个「标签 / 值」字段（详情面板的字段网格用）。 */
export declare function Field(props: {
    label: ReactNode;
    children?: ReactNode;
}): import("react").DetailedReactHTMLElement<null, HTMLElement>;
/** 底部口径说明。 */
export declare function Note(props: {
    children?: ReactNode;
}): import("react").DetailedReactHTMLElement<{
    className: string;
}, HTMLElement>;
/** 状态 → 主题色。 */
export declare function stateColor(state: string): string;
/** 健康度 / 风险等级 → 主题色。 */
export declare function levelColor(level: string): string;
/**
 * 把 Markdown 渲染成一组元素。
 * @param props.text - Markdown 原文。
 * @param props.plain - true 时只做行内解析（评论用，不产生块级标题）。
 */
export declare function Markdown(props: {
    text: string;
    plain?: boolean;
}): import("react").DetailedReactHTMLElement<{
    className: string;
}, HTMLElement>;
/** 时间戳裁剪到分钟（`2026-09-14T10:35:19+08:00` → `2026-09-14 10:35`）。 */
export declare function stamp(iso: string): string;
/** 日期裁剪到天。 */
export declare function day(iso: string): string;
