/**
 * 触发型工具：模型只负责「说要什么」，取数由脚本完成，渲染由卡片完成。
 *
 * 设计要点（对应需求方的口径）：
 *   - 工具**返回值只有摘要**（payload.summary）。全量数据不进上下文，
 *     所以上下文占用与数据量解耦——一千个工作项和十个工作项，
 *     模型看到的一样长。
 *   - 工具**不是**取数通道的唯一样式：卡片会拿同样的参数去
 *     /api/gitee-chat/payload 取完整数据。两处共用同一个执行器的进程内缓存。
 *
 * @module dsh-gitee-chat/host/tools
 */
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { GqRunner } from './gq.ts';
import type { McpInspection } from './mcpBinary.ts';
import type { RoleResolver } from './role.ts';
/** 工具依赖。 */
export interface GiteeChatToolDeps {
    readonly runner: GqRunner;
    /** 身份/人格解析器（`gitee_role` 工具与提示词注入共用一份缓存）。 */
    readonly role: RoleResolver;
    /**
     * 随包 MCP 后端状态（可选：兼容只传 `runner` 的旧调用点）。
     *
     * `gitee_chat_health` 用它回答「为什么 AI 建不了项目 / 改不了 Gitee 上的东西」——
     * 那是 MCP 通道的问题，取数自检（gq 脚本那条路）看不出来。
     */
    readonly mcp?: () => McpInspection;
}
/**
 * 注册 gitee-chat 的触发型工具。
 * @param deps - 取数执行器。
 * @returns 可注册进 `ctx.tools` 的工具定义数组。
 */
export declare function giteeChatTools(deps: GiteeChatToolDeps): ToolDefinition[];
