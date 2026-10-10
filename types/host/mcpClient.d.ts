/**
 * dsh-gitee-chat · **MCP stdio 客户端**（host 半自用，只做 JSON-RPC 那几帧）。
 *
 * 为什么不用 `@deepseek-ai/dsh-mcp-client`：它把 MCP 工具注册进**调用方的作用域**，
 * 而公开 gateway 要的是**进程级一个入口**；而且我们要的是
 * 「先目录（list）→ 再参数表（schema）→ 再执行（call）」的两级暴露，
 * 这与「把 48 个工具 schema 每轮塞进上下文」正好相反。
 *
 * 协议：MCP `2024-11-05`，stdio，一行一个 JSON-RPC 2.0 帧。
 * 只实现 gateway 需要的三帧：`initialize` / `tools/list` / `tools/call`。
 *
 * 生命周期：**懒启动、可重启**。子进程退出（或拉起失败）后，下一次调用会
 * 重新拉起 —— MCP server 是无状态查询进程，重启没有状态损失；反过来，
 * 把「启动失败」变成永久错误会让一次抖动废掉整个会话。
 *
 * @module dsh-gitee-chat/host/mcpClient
 */
/** `tools/list` 里的一项（只保留 gateway 用得到的字段）。 */
export interface McpToolInfo {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: unknown;
}
/** `tools/call` 的结果。`isError` 为真表示 MCP server 报的业务错误。 */
export interface McpCallResult {
    readonly text: string;
    readonly isError: boolean;
}
/** 构造参数。`command` 为空串时所有请求都会以 `missing-binary` 失败。 */
export interface McpClientOptions {
    readonly command: string;
    readonly args?: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    /** 单帧超时（毫秒）。默认 60s，与 preset 里 `toolCallTimeoutMs` 的出厂值一致。 */
    readonly timeoutMs?: number;
    /** 握手 `clientInfo.version`（由调用点传 `VERSION`，避免版本号出现第二处真源）。 */
    readonly clientVersion?: string;
    readonly logger?: {
        warn(message: string): void;
    };
}
/** 带 `code` 的错误：gateway 靠它把失败翻成可行动文案。 */
export interface McpClientError extends Error {
    readonly code: 'missing-binary' | 'timeout' | 'mcp-exited' | 'mcp-error' | 'protocol';
}
export interface McpClient {
    /** 工具目录。 */
    list(): Promise<McpToolInfo[]>;
    /** 执行一个工具。MCP 报的 JSON-RPC error 会抛出（`code: 'mcp-error'`）。 */
    call(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
    /** 杀掉子进程并拒绝所有在途请求（幂等）。 */
    dispose(): void;
}
/**
 * 造一个 MCP 客户端。**不会**在构造时启动进程 —— 第一次 `list`/`call` 才拉起。
 * @param options - 命令行、环境变量与超时。
 * @returns 客户端；用完调 `dispose()`。
 */
export declare function createMcpClient(options: McpClientOptions): McpClient;
