/**
 * 纯 SVG / CSS 可视化组件（零图表库依赖）。
 *
 * 客户端**没有**内置 mermaid、echarts、d3，模型也无法接收图片，
 * 所以会话内的一切图形都必须由这里自己画——这正是「图表由插件渲染」的含义。
 *
 * @module dsh-gitee-chat/client/charts
 */
import type { DistributionRow } from '../types.ts';
/** 取状态色（未知状态回落到中性色）。 */
export declare function stateColor(state: string): string;
/** 取状态中文名。 */
export declare function stateLabel(state: string): string;
/**
 * 状态分布堆叠条 + 图例。宽度按占比分配，全为 0 时不渲染。
 * @param props.rows - 分布数据。
 */
export declare function StateStack(props: {
    rows: readonly DistributionRow[];
}): import("react").DetailedReactHTMLElement<{
    className: string;
}, HTMLElement>;
/**
 * 进度条。`percent` 已裁剪到 0-100。
 * @param props.percent - 完成率。
 * @param props.showText - 是否在右侧显示百分比。
 */
export declare function ProgressBar(props: {
    percent: number;
    showText?: boolean;
}): import("react").DetailedReactHTMLElement<{
    className: string;
}, HTMLElement>;
/**
 * 分组柱状图：每个项目一根「总量」柱，其中已逾期部分用错误色叠加。
 * 用纯 SVG 画，宽度自适应容器（viewBox + preserveAspectRatio）。
 * @param props.items - 每项的标签、总量、逾期量。
 */
export declare function OverdueBars(props: {
    items: readonly {
        label: string;
        total: number;
        overdue: number;
    }[];
}): import("react").ReactSVGElement;
