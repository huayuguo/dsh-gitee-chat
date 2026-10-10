/**
 * 写通道：**全包唯一的写入口**。
 *
 * 纪律（这是本模块存在的全部理由）：
 *   - 任何改动 Gitee 数据的动作，都必须经过 `createIssueWriter().write()`。
 *     路由、未来的按钮、将来任何新入口，一律调它——不允许出现第二套写逻辑。
 *   - UI 不直连 Gitee：浏览器 → `/api/gitee-chat/write` → 这里 → gq 脚本 → Gitee。
 *   - 每次写都返回**结构化结果**（而不是裸 HTTP），失败带可读原因。
 *
 * 与 AI 侧写操作的关系：模型有自己的 MCP 写工具（`update_enterprise_issue` 等），
 * 那是**另一个平面**、另一条通道，故意不复用——MCP 工具受能力档门禁约束，
 * 而这里只做 UI 的最小写集合（改状态 / 评论 / 改派），三档人格都有这个权限。
 *
 * **第四种 op：`doc-page-update`**（知识库文档页，整页替换）。
 * 它同样从这一个入口出去（UI 只有一条写路），但**实现是委派**：
 * 转交 MCP 的 `update_enterprise_document_page`，插件不拼文档端点。
 * MCP 是文档能力的唯一实现。
 *
 * @module dsh-gitee-chat/host/write
 */
import type { GqRunner } from './gq.ts';
import type { McpDocs } from './mcpDocs.ts';
import type { IssueWriteRequest, IssueWriteResult } from '../types.ts';
/** 写通道选项。 */
export interface IssueWriterOptions {
    readonly runner: GqRunner;
    /** 关掉写通道（只读部署）。默认开。 */
    readonly enabled?: boolean;
    /**
     * 文档委派客户端（可选）。
     *
     * 文档写**不在这个文件里拼端点** —— 它委派给 MCP 的
     * `update_enterprise_document_page`。
     * 这里只负责"UI 的写只有一个入口"这条纪律。
     */
    readonly docs?: McpDocs;
}
/** 写失败：带 code，供路由映射 HTTP 语义。 */
export declare class WriteError extends Error {
    readonly code: 'disabled' | 'bad-request' | 'forbidden' | 'failed';
    constructor(code: 'disabled' | 'bad-request' | 'forbidden' | 'failed', message: string);
}
/**
 * 创建写通道。
 * @param options - 执行器、开关与文档委派客户端。
 */
export declare function createIssueWriter(options: IssueWriterOptions): {
    /** 写通道是否开启。 */
    enabled(): boolean;
    /** 最近若干条写操作（只读，给诊断用）。 */
    recent(limit?: number): readonly {
        at: string;
        op: string;
        ident: string;
        ok: boolean;
        detail: string;
    }[];
    /**
     * 执行一次写操作。**UI 的所有改动都从这里出去。**
     * @param request - 归一化前的请求（来自 HTTP，字段不可信）。
     */
    write(request: IssueWriteRequest): Promise<IssueWriteResult>;
};
/** 写通道类型。 */
export type IssueWriter = ReturnType<typeof createIssueWriter>;
