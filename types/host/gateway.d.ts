/**
 * dsh-gitee-chat · **公开 gateway**（host 半唯一的 agent 可见出口）。
 *
 * 背景：原先 Gitee 企业 MCP 的 48 个工具只挂在两个 Gitee
 * preset 里 —— 其他 agent（分析、PTC、一次性问答）根本看不到，而 MCP 本身
 * 是**工具类后端**、不是 Gitee 人格的私有物。用户 2026-10-10 要求改成公共能力。
 *
 * 但「全量公开」不等于「48 个 schema 每轮进上下文」：实测 48 个工具的
 * name+description+inputSchema ≈ 46.6 KB ≈ 14.6K tokens/请求。所以这里做成
 * **两级暴露**，只把第一级常驻：
 *
 *   1. **目录**（`op: "list"`，约 1.1K tokens，且只在真用到时才进上下文）：
 *      工具名 + 一句话说明 + 是否写操作（✎）。
 *   2. **按需取参数表**（`op: "schema"`）+ **执行**（`op: "call"`）：
 *      一个 `gitee_ent` 工具的 schema ≈ 100–150 tokens，常驻成本恒定。
 *
 * 为什么不用 DSH 原生的 `deferLoading`：`ToolSchema.deferLoading` 只表达
 * 「延迟发送定义」，而**声明延迟并不激活**（`packages/llm/llm/README.zh.md:162`），
 * 且 `dsh-mcp-client` 不接受该选项（`lib/index.js:153` 直接 `register(definition)`）。
 * 也就是说原生机能不能给出「目录 → 按需加载」这条路。
 *
 * 门禁分工（与 §10/§11 一致）：**档位裁剪留给 Gitee preset**（agent 半用
 * `ctx.tools.restrict` 把这个 gateway 从 Gitee 会话里隐藏，仍用原生 48 工具）；
 * gateway 自己只守一条**部署级承诺**：`allowWrites: false`（只读部署）时硬拦写工具。
 *
 * @module dsh-gitee-chat/host/gateway
 */
import { type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { McpClient } from './mcpClient.ts';
/** gateway 依赖。除 `client` 外都有默认值，便于冒烟测试只注入必要项。 */
export interface GiteeEntGatewayDeps {
    /** 已连到随包 MCP 后端的客户端（host 半负责 `dispose`）。 */
    readonly client: McpClient;
    /** 线上工具名，默认 `PUBLIC_GATEWAY_TOOL_NAME`（`gitee_ent`）。 */
    readonly toolName?: string;
    /** `hostConfig.allowWrites`：false = 只读部署，写工具硬拦。 */
    readonly allowWrites: boolean;
    /** 运行期写名单（`role.current()?.writes`）；未解析出来时返回空数组即可。 */
    readonly runtimeWrites?: () => readonly string[];
    /** 本部署钉住的企业 id（>0 时写进目录抬头，省掉一次 list_enterprises）。 */
    readonly enterpriseId?: number;
    /** 目录里每条描述截断到多少字符（默认 100）。 */
    readonly catalogChars?: number;
    /** 单次结果最多回多少字节（默认 120000，超出截断并提示）。 */
    readonly maxResultBytes?: number;
}
/**
 * 造 `gitee_ent` gateway 工具。
 * @param deps - MCP 客户端与部署开关。
 * @returns 可注册进 `ctx.tools` 的工具定义（**一个**）。
 */
export declare function giteeEntGatewayTool(deps: GiteeEntGatewayDeps): ToolDefinition;
