/**
 * 工作项详情面板（F-09）+ 会话内写回（G-05 / F-10）。
 *
 * 三块内容，对应需求方最早提的三件事：
 *   1. **描述** —— Markdown 渲染，并且把「## 前置依赖」那一段单独抽出来
 *   2. **前置依赖** —— 已完成的画绿、未完成的标红并明确说「卡住本项」
 *   3. **评论中的讨论** —— 按时间正序，回复关系靠引用块呈现
 *
 * 写回：状态 / 评论 / 改派三个动作，全部走 `postWrite` → host 的唯一写入口。
 * 界面上**没有第二套写逻辑**，也没有「先乐观更新再补发」的时序问题——
 * 写完重新拉一次详情，看到的就是服务端的真值。
 *
 * @module dsh-gitee-chat/client/IssueDetail
 */
import type { IssueDetailPayload, IssueStateRow, ProgramMemberRow } from '../types.ts';
/** 详情面板的入参。 */
export interface IssueDetailProps {
    /** 会话 id（写操作必须带上，host 用它确认这是 Gitee 会话）。 */
    sessionId: string;
    /** 要展示的工作项编号。 */
    ident: string;
    /** 写通道是否开启（只读部署会置 false）。 */
    writesEnabled: boolean;
    /** 关闭面板。 */
    onClose?: () => void;
    /** 数据变更后的回调（父级据此刷新看板）。 */
    onChanged?: () => void;
    /**
     * 离线预览用的种子数据。
     *
     * **仅供 `scripts/render-check.mjs` 的 SSR 自检注入**：服务端渲染不跑 effect，
     * 没有它就无法把详情面板渲染成静态 HTML。正常槽位渲染不传，组件自己去拉。
     */
    preload?: {
        detail: IssueDetailPayload;
        states?: IssueStateRow[];
        members?: ProgramMemberRow[];
    };
}
/**
 * 工作项详情面板。
 * @param props - 见 {@link IssueDetailProps}。
 */
export declare function IssueDetail(props: IssueDetailProps): import("react").DetailedReactHTMLElement<null, HTMLElement> | import("react").FunctionComponentElement<{
    children?: import("react").ReactNode;
    style?: Record<string, unknown>;
    grow?: boolean;
}>;
