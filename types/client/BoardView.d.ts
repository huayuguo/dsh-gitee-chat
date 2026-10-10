/**
 * 看板视图（纯展示层）。
 *
 * 与 `BoardCard` 分开的理由：取数是有状态、依赖网络的，展示是纯函数。
 * 拆开后展示层可以被确定性渲染测试覆盖（见 scripts/render-check.mjs），
 * 于是「卡片长什么样」不再是只能在浏览器里肉眼确认的东西。
 *
 * @module dsh-gitee-chat/client/BoardView
 */
import type { BoardPayload } from '../types.ts';
/** 视图入参。 */
export interface BoardViewProps {
    payload: BoardPayload;
    /** 本次是否命中宿主缓存。 */
    cached?: boolean;
    /** 是否样例数据。 */
    degraded?: boolean;
    /** 点「刷新」时回调（不传则不显示按钮的交互效果）。 */
    onRefresh?: () => void;
    /** 风险最多展示几条。 */
    maxRisks?: number;
}
/**
 * 渲染看板全貌：KPI → 状态分布 → 项目柱状 → 项目健康度 → 风险清单 → 页脚。
 * @param props - payload 与交互回调。
 */
export declare function BoardView(props: BoardViewProps): import("react").DetailedReactHTMLElement<{
    className: string;
}, HTMLElement>;
