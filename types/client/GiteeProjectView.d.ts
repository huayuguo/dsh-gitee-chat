/**
 * 整屏「Gitee 项目」视图 —— 与 对话 / 轨迹 / 上下文 并列的第 4 个标签页。
 *
 * 版式对齐官方「上下文」标签页：卡片 + 卡头 + 分段开关 + 统计格 + 两列带。
 *
 * 与看板卡片的分工：
 *   - **卡片**（`tool.call.toolview`）：贴着那次工具调用，回答"我刚查到了什么"；
 *   - **本视图**：整屏、可下钻、可操作，回答"现在项目里到底有什么、我要改什么"。
 *
 * ⚠️ 一个必须处理的架构事实：客户端插件在 **profile 层**，它注册的
 * `conversation.view` 对**所有 preset** 可见（包括 PTC）。而客户端拿不到会话的
 * preset（`SessionSummary` 里没有）。所以本视图先问 host「这个会话是不是 Gitee 模式」，
 * 不是就只显示一句提示 —— 绝不把 Gitee 看板塞进无关会话。
 *
 * @module dsh-gitee-chat/client/GiteeProjectView
 */
import type { BoardPayload, ProgramIssues } from './api.ts';
/** 视图入参（slot 注入的标准 props + owner props）。 */
export interface GiteeProjectViewProps {
    /** 当前会话 id —— 用于向 host 确认是否 Gitee 模式，也用于写操作鉴权。 */
    sessionId?: string;
    /**
     * 离线预览用的种子数据。
     *
     * **仅供 `scripts/render-check.mjs` 的 SSR 自检注入**：服务端渲染不跑 effect，
     * 没有它就无法把「已就绪」状态的界面渲染成静态 HTML。正常槽位渲染不传。
     */
    preload?: {
        board: BoardPayload;
        issues?: ProgramIssues;
    };
    [key: string]: unknown;
}
/**
 * 「本会话未使用 Gitee 模式」提示。
 *
 * 单独导出有两个理由：它是**唯一**会在无关会话里出现的界面（必须能被单独
 * 审阅），以及离线预览 / SSR 自检需要直接渲染它（服务端不跑 effect，
 * 走不到 ready 之外的分支）。
 *
 * @param props.preset - 该会话实际使用的 preset id（未知为 null）。
 */
export declare function GiteeModeNotice(props: {
    preset?: string | null;
}): import("react").FunctionComponentElement<{
    children?: import("react").ReactNode;
    style?: Record<string, unknown>;
    grow?: boolean;
}>;
/**
 * 整屏项目视图。
 * @param props - 会话 props（含 sessionId）。
 */
export declare function GiteeProjectView(props: GiteeProjectViewProps): import("react").DetailedReactHTMLElement<{
    className: string;
    'data-gq-root': string;
}, HTMLElement>;
