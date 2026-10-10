/**
 * dsh-gitee-chat · **MCP 工具名规则**（host 半与 agent 半共用的唯一真源）。
 *
 * 为什么单独成文件：host 半（`./index`）与 agent 半（`./agent`）由 esbuild
 * **分别打包**、互不共享运行时模块（见 `build.mjs` 的平面纪律）。把这条命名
 * 规则放在中立模块里，两边各自内联一份**同一实现**，而不是两处硬编码前缀
 * ——两处硬编码必然漂移。
 *
 * 桥接规则：`mcp__<serverName>__<toolName>`，`serverName` 取自 preset 里
 * `mcp-gitee` 行的 `serverName`（当前 `gitee_ent`）。
 *
 * @module dsh-gitee-chat/mcpNaming
 */
/**
 * 本插件的 MCP 工具名前缀（默认 `mcp__gitee_ent__`）。
 *
 * 必须与 `presets/<id>/agent.cordis.yml` 里 `mcp-gitee` 行的 `serverName` 一致。
 * 改 preset 的 serverName 就要改这里（或改配置 `docs.mcpToolPrefix`）。
 */
export declare const DEFAULT_MCP_TOOL_PREFIX = "mcp__gitee_ent__";
/**
 * **公开 gateway 的工具名**（host 半注册，进程级一个入口）。
 *
 * 与 `DEFAULT_MCP_TOOL_PREFIX` 的区别：前缀是「桥接后」的名字
 * （`mcp__gitee_ent__list_programs`，只存在于 Gitee preset 的作用域里），
 * 而这是 gateway 自己的名字（`gitee_ent`，注册在全局层，所有 agent 可见）。
 * Gitee preset 里 agent 半会用 `ctx.tools.restrict` 把它隐藏，改用原生工具。
 *
 * 取这个名字的原因：它就是 MCP server 的 `serverName`（`gitee_ent`），
 * 使用者不用记第二个名字。
 */
export declare const PUBLIC_GATEWAY_TOOL_NAME = "gitee_ent";
/**
 * 从 wire 工具名里取出**本插件那个 MCP server** 的原始工具名。
 *
 * ⚠️ 必须按 **server 前缀**过滤，不能只看 `mcp__`。
 *
 * 一个 preset 里往往还挂着别的 MCP server，
 * 它们的工具名同样以 `mcp__` 开头，但**不归本插件的门禁管**。只看 `mcp__`
 * 会让 Gitee 的能力档表去审别家的工具：`mcp__openviking__remember` 被剥成
 * `remember`、`mcp__openviking__write` 被剥成 `write`，两个都"不在本档工具集内"，
 * 于是被拒绝并报出误导性的「当前人格不具备该操作的权限」（2026-09-17 实测误伤：
 * Gitee 模式的管理者人格下，AI **完全无法写 OpenViking 记忆**）。
 *
 * 反向也危险：别家 server 若有与 Gitee 同名的工具，会被误**放行**。
 *
 * @param wireName - 桥接后的工具名，形如 `mcp__gitee_ent__list_programs`。
 * @param prefix - 本部署的 MCP 前缀（来自 `hostConfig.mcpToolPrefix`）。
 * @returns 属于本 server 时返回裸工具名；否则 `undefined`（= 不归本门禁管）。
 */
export declare function rawMcpToolName(wireName: string, prefix?: string): string | undefined;
