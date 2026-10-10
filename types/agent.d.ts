/**
 * dsh-gitee-chat · **agent（preset）平面**。
 *
 * 与 host 半（`./index`）的分工，是本插件最重要的一条架构纪律：
 *
 * | | host 半（profile bundle） | agent 半（本文件，preset 行） |
 * |---|---|---|
 * | 取数执行器 / 身份解析 | ✅ 拥有 | 消费 |
 * | HTTP 路由（卡片数据） | ✅ 拥有 | — |
 * | 公开 gateway `gitee_ent` | ✅ 注册（对所有 preset） | ✅ `restrict` 隐藏 |
 * | 触发型工具 | — | ✅ 注册 |
 * | 人格上下文注入 | — | ✅ 注册 |
 * | 能力档门禁 | — | ✅ 注册 |
 *
 * **为什么必须分开**：host 半挂在 profile 里，它的注册对所有 preset 生效。
 * 早先版本把工具与人格注入写在 host 半，结果 PTC 等无关 preset 的新会话
 * 也被注入了 Gitee 人格、也能看到 Gitee 工具——这是错误的平面归属。
 * 现在这些东西只在**挂了本行的 preset**（两个 Gitee 模式）里才有；
 * 唯一的例外是公开 gateway（MCP 是工具类后端，用户 2026-10-10 要求公共化），
 * 它由 host 半注册、再由本文件 `restrict` 从 Gitee 会话里隐藏。
 *
 * @module dsh-gitee-chat/agent
 */
import z from 'schemastery';
import { rawMcpToolName } from './mcpNaming.ts';
/** 插件身份。 */
export declare const name = "dsh-gitee-chat-agent";
/**
 * 硬依赖：
 *  - `giteeChat`：host 半发布的能力（执行器 + 身份解析器），由 profile 提供；
 *  - `tools`：注册触发型工具。
 * `systemPrompt` 用可选获取（缺失时只是不注入人格，不该拖垮整个 preset）。
 */
export declare const inject: string[];
/** agent 平面配置（只管"这个 preset 里的 agent 能用什么"）。 */
export interface Config {
    /** 是否把推导出的人格作为运行上下文注入每一轮（默认 true）。 */
    injectPersona?: boolean;
    /** 是否启用能力档门禁：按人格拒绝越权 MCP 调用（默认 true）。 */
    enforceTier?: boolean;
}
/** Loader 用的校验模式。 */
export declare const Config: z<Config>;
/** 补齐默认值。 */
export declare function resolveConfig(config?: Config): {
    injectPersona: boolean;
    enforceTier: boolean;
};
/**
 * 从 wire 工具名里取出本插件 MCP server 的原始工具名。
 *
 * 实现与规则说明在 `./mcpNaming`（host 半与 agent 半共用同一份，因为两个入口
 * 分别打包）。这里再导出，保持 `lib/agent.js` 的既有公开路径与冒烟测试入口。
 */
export { rawMcpToolName };
/**
 * agent 平面插件主体：把 host 半的能力接成「一个 preset 里 agent 能用的东西」。
 * @param ctx - 注入了 giteeChat / tools 的 agent 作用域上下文。
 * @param config - 本 preset 的配置。
 */
export declare function apply(ctx: any, config?: Config): void;
export type { GiteeChatFace } from './host/face.ts';
