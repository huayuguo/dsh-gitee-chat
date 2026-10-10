/**
 * 固定分析卡片（E-01 ~ E-10）。
 *
 * **这一层不做任何计算**：每一个数字都来自 gq 脚本的 `analysis` 字段。
 * 组件只负责把它排成能看懂的样子。判断口径写在每张卡片的脚注里，
 * 阈值随数据下发，所以结论永远可以复算。
 *
 * @module dsh-gitee-chat/client/AnalysisCards
 */
import type { BoardAnalysis } from '../types.ts';
/**
 * 固定分析全部分组。
 * @param props.analysis - 脚本算好的分析结果。
 * @param props.managementEnabled - 项目管理与分析是否开启（执行档只看本人视角）。
 */
export declare function AnalysisCards(props: {
    analysis: BoardAnalysis;
    managementEnabled: boolean;
}): import("react").DetailedReactHTMLElement<null, HTMLElement>;
