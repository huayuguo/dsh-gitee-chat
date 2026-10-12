/**
 * dsh-gitee-chat · **host 半（profile bundle）**。
 *
 * 职责：
 *   1. 取数执行器（脚本执行 + 进程内缓存）
 *   2. 身份/人格解析器（进程级缓存；`systemPrompt.context` 是同步的，必须在装配外解析）
 *   3. 卡片数据通道 `/api/gitee-chat/*`
 *   4. 把 1&2 经 `ctx.provide('giteeChat', …)` 交给 agent 平面
 *   5. **公开 gateway**：一个进程级工具 `gitee_ent`（两级：list → schema → call），
 *      让**所有** preset 的 agent 都能用 Gitee 企业 MCP（用户 2026-10-10 口径）。
 *
 * ⚠️ 除第 5 条那**一个**工具外，本文件里不得注册任何 agent 可见的东西
 * （人格上下文、门禁、其他工具都不行）。host 半挂在 profile 里，注册即对
 * **所有 preset** 生效——早先版本把工具与人格注入写在这里，导致 PTC 等无关
 * preset 的新会话也被注入 Gitee 人格、也能看到 Gitee 工具。那些东西属于
 * agent 平面，见 `./agent`；第 5 条是**故意的例外**。
 *
 * @module dsh-gitee-chat
 */
import z from 'schemastery';
import { DEFAULT_MCP_TOOL_PREFIX } from './mcpNaming.ts';
/** 插件身份。 */
export declare const name = "dsh-gitee-chat";
/** host 半只需要 HTTP 路由载体；`webRuntime` 用可选获取（读可信 authority 列表）。 */
export declare const inject: string[];
/** 包版本（被 /ping 回显）。
 *
 * **从 package.json 读**，不写死：写死会出现「代码说 0.2.0、包说 0.1.0」的漂移，
 * 而这正是排障时最需要可信的一个数字。读不到时回落到 `0.0.0`——冒烟测试会断言
 * 这个回落**不生效**（即真读到了版本），所以它只会以「测试红了」的形式暴露问题。
 */
export declare const VERSION: string;
/**
 * agent 半的**组合行名**。
 *
 * 判定「这个会话是不是 Gitee 模式」不看 preset 叫什么名字，而是看这个 preset
 * 的组合里**有没有挂我们的 agent 行**——这是事实，不是命名约定。
 * 同事把自己的 preset 叫 `我的项目助手` 也能正常工作。
 */
export declare const AGENT_ROW_NAME = "dsh-gitee-chat/agent";
/**
 * MCP 文档工具名的默认前缀。
 *
 * 唯一的真源在 `./mcpNaming`：agent 半的能力档门禁要用**同一条**前缀规则
 * （区分本插件的 Gitee 工具与同一个 preset 里别家 MCP server 的工具），
 * 而两个入口分别打包、不共享运行时模块。这里只再导出，保持既有公开路径。
 */
export { DEFAULT_MCP_TOOL_PREFIX };
/** host 平面配置（部署级：连哪个企业、脚本在哪、怎么取数）。 */
export interface Config {
    /** Gitee 企业版 API base。 */
    apiBase?: string;
    /** 传给 gq 脚本的同参数短时缓存秒数（0=关闭）。仅写 /tmp，不是数据库。 */
    cacheTtlSeconds?: number;
    /** 单次脚本执行超时（毫秒）。 */
    scriptTimeoutMs?: number;
    /** 无 token 时是否降级为样例数据渲染（仅用于验证 UI；生产建议 false）。 */
    allowFixtureFallback?: boolean;
    /** 覆盖 gq 脚本路径（默认包内 scripts/gitee/gq.mjs）。 */
    scriptPath?: string;
    /**
     * 固定使用的企业 id。0/不填 = 让脚本解析：只有一个企业时自动使用；
     * 多个企业时**报错要求显式指定**（静默挑一个会拿错公司的数据）。
     * 不想重启就切换：改 `$DSH_HOME/.gitee-chat/config.json` 或 `gq enterprises --use <id>`。
     */
    enterpriseId?: number;
    /** 身份/人格解析结果的缓存时长（秒，默认 600）。 */
    roleTtlSeconds?: number;
    /** 人格模式：auto（默认，按身份推导）/ manager / project / exec（人工强制）。 */
    mode?: 'auto' | 'manager' | 'project' | 'exec';
    /** 企业版端点要求的应用标识 UA（默认内置；换 MCP 版本/平台时覆盖）。 */
    userAgent?: string;
    /** 是否开启写通道（改状态 / 评论 / 改派）。只读部署设 false。 */
    allowWrites?: boolean;
    /**
     * 显式声明哪些 preset id 属于 Gitee 模式。
     * 留空（默认）= 按**事实**判定：preset 的组合里挂了 `agentRowName` 那一行。
     */
    presetIds?: string[];
    /** 组合里代表本插件的行名（默认 `dsh-gitee-chat/agent`）。 */
    agentRowName?: string;
    /**
     * 知识库文档。
     *
     * 这里**没有任何端点配置** —— 文档能力的唯一实现是 MCP，
     * 插件只配置"缓存在哪、工具叫什么名字"。
     */
    docs?: {
        /** 本地缓存根（默认 `$DSH_HOME/gitee/docs`）。 */
        root?: string;
        /**
         * MCP 工具名前缀（默认 `mcp__gitee_ent__`）。
         * 必须与 preset 里 `mcp-gitee` 行的 `serverName` 一致（当前是 `gitee_ent`）。
         */
        mcpToolPrefix?: string;
        /** 读本地前是否先跑一次一致性核对（默认 true）。 */
        autoCheckOnRead?: boolean;
        /** 单页正文落盘上限（字符，默认 200000）。 */
        maxPageBytes?: number;
    };
    /** 部署级阈值覆盖（等价于对应的 GITEE_CHAT_* 环境变量，但不必重启）。 */
    thresholds?: {
        stallDays?: number;
        overloadOpen?: number;
        overloadOverdue?: number;
        requiredLabels?: number;
        weeklyCapacity?: number;
        trendWeeks?: number;
        milestoneRiskDays?: number;
    };
}
/** Loader 用的校验模式（字段都可选，缺省由 resolveConfig 兜底）。 */
export declare const Config: z<Config>;
/** 补齐默认值（直接调用绕过 Loader 时同样成立）。 */
export declare function resolveConfig(config?: Config): {
    apiBase: string;
    cacheTtlSeconds: number;
    scriptTimeoutMs: number;
    allowFixtureFallback: boolean;
    scriptPath: string;
    enterpriseId: number;
    roleTtlSeconds: number;
    mode: string;
    userAgent: string;
    allowWrites: boolean;
    presetIds: string[];
    agentRowName: string;
    docs: {
        root: string;
        mcpToolPrefix: string;
        autoCheckOnRead: boolean;
        maxPageBytes: number;
    };
    thresholds: {
        stallDays?: number;
        overloadOpen?: number;
        overloadOverdue?: number;
        requiredLabels?: number;
        weeklyCapacity?: number;
        trendWeeks?: number;
        milestoneRiskDays?: number;
    };
};
/** 解析后的配置。 */
export type ResolvedConfig = ReturnType<typeof resolveConfig>;
/**
 * 把配置里的阈值与 UA 翻译成子进程环境变量。
 * 只加自己认识的键，不改动、不清理继承来的环境。
 */
export declare function childEnvOverrides(resolved: ResolvedConfig): NodeJS.ProcessEnv;
/**
 * 判断一段 preset 组合文本里是否挂了指定的行。
 *
 * 用文本匹配而不是 YAML 解析：组合文件是较小的受控输入，且加一个 YAML
 * 依赖只为读一个 `name:` 不划算。匹配限定在 `name:` 这一行的整行，
 * 避免命中注释或别处的同名子串。
 */
export declare function compositionMountsRow(text: string, rowName: string): boolean;
/**
 * host 半插件主体：装配执行器与解析器、挂路由、发布服务。
 * @param ctx - cordis 上下文（需要 webServer）。
 * @param config - Loader 传入的原始配置。
 */
export declare function apply(ctx: any, config?: Config): void;
export { createGqRunner, defaultScriptPath } from './host/gq.ts';
export { binaryName, dshHome, ensureMaterialized, inspectMcpBinary, isOnPath, materializedPath, platformKey, readManifest, toolGapOf, userBinDir, } from './host/mcpBinary.ts';
export { createIssueWriter, WriteError } from './host/write.ts';
export { createRoleResolver } from './host/role.ts';
export { createMcpClient } from './host/mcpClient.ts';
export { giteeEntGatewayTool } from './host/gateway.ts';
export { PUBLIC_GATEWAY_TOOL_NAME, rawMcpToolName } from './mcpNaming.ts';
export { WRITE_TOOLS, WRITE_TOOLS_BY_TIER } from './generated/tierWrites.ts';
export type { McpClient, McpCallResult, McpToolInfo, McpClientOptions } from './host/mcpClient.ts';
export type { GiteeEntGatewayDeps } from './host/gateway.ts';
export { listEnterprises, switchEnterprise, invalidateAfterEnterpriseSwitch } from './host/enterprise.ts';
export { createEnterpriseIdResolver, resolveEnterpriseIdNow, noEnterpriseHint, unauthorizedEnterpriseHint } from './host/enterpriseId.ts';
export { DocError, createMcpDocs, unwrapToolResult, } from './host/mcpDocs.ts';
export { createDocService, defaultDocsRoot } from './host/docService.ts';
export { createRepoService, visibilityOf } from './host/repoService.ts';
export { createWikiCache, toWorkspacePath, safeRepoSegment, WORKSPACE_LINK_DIR, WORKSPACE_LINK_NAME, } from './host/wikiCache.ts';
export { classifyPageState, enterpriseLayer, pageRelPath, planPull, readIndex, rollupDocState, safeSlug, stripExtension, documentDir, MANIFEST_NAME, TEXT_PREVIEW_EXT, extOf, readTextFile, ATTACH_MANIFEST_NAME, classifyAttachState, readAttachManifest, writeAttachManifest, attachFileExists, cacheStats, humanBytes, } from './host/docCache.ts';
export type { McpDocs, ToolsService } from './host/mcpDocs.ts';
export type { DocService } from './host/docService.ts';
export type { RepoService } from './host/repoService.ts';
export type { WikiCache } from './host/wikiCache.ts';
export type { DocManifest, DocPageState } from './host/docCache.ts';
export type { IssueWriter, IssueWriterOptions } from './host/write.ts';
export type { GqRunner, RunRequest, RunResult } from './host/gq.ts';
export type { McpBinaryReport, McpInspection, McpManifest } from './host/mcpBinary.ts';
export type { RoleResolver, RoleSnapshot } from './host/role.ts';
export type { EnterpriseEntry, EnterpriseListPayload, SwitchResult } from './host/enterprise.ts';
export type { EnterpriseIdResolution, EnterpriseIdResolver, EnterpriseIdSource } from './host/enterpriseId.ts';
export type { GiteeChatFace } from './host/face.ts';
export type { PersonaKey, PersonaMode, PersonaTier, RolePayload } from './types.ts';
