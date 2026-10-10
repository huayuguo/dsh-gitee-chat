/**
 * 卡片数据通道：/api/gitee-chat/* 。
 *
 * 这条路由是「模型只触发、数据由后台灌」的那一半——卡片拿工具调用的参数
 * 来这里取**完整**结构化 payload，全程不经过模型上下文。
 *
 * 路由表（prefix = /api/gitee-chat）：
 *   POST /payload   body {scope?, program?, refresh?} → PayloadResponse | ErrorResponse
 *   GET  /session?sessionId=                          → 这个会话是不是 Gitee 模式
 *   GET  /issues?program=&state=                      → 单项目工作项清单
 *   GET  /issue?ident=                                → 工作项详情（描述/前置依赖/评论）
 *   GET  /states?type=                                → 某类型下可选状态（改状态用）
 *   GET  /members?program=                            → 项目成员（改派用）
 *   POST /write     body {op, ident, …}                → 唯一写入口（改状态/评论/改派/文档页）
 *   GET  /health                                      → HealthResponse
 *   GET  /enterprises | POST /enterprise              → 企业列表 / 切换
 *   GET  /token | POST /token body {token}            → token 状态 / 写入 ~/.dsh/.gitee-chat/token
 *   GET  /preview                                     → 卡片静态预览
 *   GET  /ping                                        → { ok, version, scriptExists, mcp, docs }
 *   GET  /docs?sessionId=&program=                     → 知识库文档列表（委派 MCP）
 *   GET  /docs/search?sessionId=&q=                    → 企业级关键词搜索（不能按项目过滤）
 *   GET  /doc?sessionId=&documentId=                   → 页树 + 本地四态
 *   GET  /doc/page?sessionId=&documentId=&pageId=      → 单页正文（本地优先）
 *   POST /doc/sync  body {sessionId, documentId, mode} → 核对 / 拉取变更
 *   GET  /doc/nodes?sessionId=&program=&parentId=      → 知识库节点树（本企业真实形态）
 *   GET  /doc/attachment?sessionId=&nodeId=&fileId=    → 读附件内容（委派 MCP 下载）
 *   GET  /doc/repos?sessionId=&program=                → 仓库列表（委派 MCP）
 *   GET  /doc/wiki?sessionId=&repoId=&repoPath=        → 仓库 WIKI 文件树（git 克隆）
 *   GET  /doc/wiki/page?sessionId=&repoId=&path=       → WIKI 一页正文
 *   GET  /doc/cache?sessionId=&program=                → 缓存用量（附件 / 仓库 WIKI 分开报）
 *   POST /doc/cache/forget body {sessionId,target,…}   → 清缓存（单个附件 / 一个范围）
 *
 * 知识库文档那几条路由**不自己拼 Gitee 端点**：它们全部经
 * `host/mcp-docs` 委派 MCP 工具（这是本层的纪律）。
 * **唯一的例外**是仓库 WIKI 的正文：Gitee 没有任何 HTTP 接口能列它
 * （实测企业 API 全 404、开放 API 是 405），只有 git 形态
 * `{path_with_namespace}.wiki.git` —— 见 `host/wikiCache.ts`。
 * `sessionId` 是必带参数 —— 它是拿到 agent 作用域的唯一钥匙。
 *
 * 每个请求都过与 /api 网关同款的 browser-trust fence（loopback 或部署的
 * trustedHosts，且同源）。这是 DNS-rebinding / 跨站防御，不是认证。
 *
 * **写路由额外要求 `sessionId` 属于一个 Gitee 模式的会话** ——
 * 这条路由挂在 profile 层，浏览器只要在 loopback 就能打到；
 * 用它把"谁能写"收敛到"确实开着 Gitee 模式的会话"。
 *
 * @module dsh-gitee-chat/host/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type GqRunner } from './gq.ts';
import type { DocService } from './docService.ts';
import type { RepoService } from './repoService.ts';
import { type IssueWriter } from './write.ts';
import type { RoleResolver } from './role.ts';
import type { McpInspection } from './mcpBinary.ts';
/** 路由前缀（webServer 以 prefix 注册，内部按 pathname 分派）。 */
export declare const ROUTE_PREFIX = "/api/gitee-chat";
/** 路由依赖。 */
export interface RouteDeps {
    readonly runner: GqRunner;
    /**
     * 判定一个会话是否跑在 Gitee 模式上。
     * 返回 `true/false`，未知时返回 `undefined`（视图据此决定展示还是提示）。
     */
    readonly isGiteeSession: (sessionId: string) => Promise<boolean | undefined>;
    /** 该会话的 preset id（未知为 null），用于诊断。 */
    readonly presetOf: (sessionId: string) => string | null;
    /** 身份/人格解析器（/role 直接读缓存，不触发新的脚本执行）。 */
    readonly role: RoleResolver;
    /** **唯一写入口**（改状态 / 评论 / 改派）。 */
    readonly writer: IssueWriter;
    /** 当前部署的可信 authority 列表（来自 webRuntime；缺失时只用 loopback）。 */
    readonly trustedHosts: () => readonly string[];
    readonly version: string;
    /**
     * 随包 MCP 后端的只读状态（供 /ping 与 /health 诊断）。
     * 必须只读：GET 不该有副作用，落地动作在装配期做。
     */
    readonly mcp: () => McpInspection;
    /**
     * 知识库文档服务（编排层）。
     *
     * 路由只调它的方法，**不自己拼 Gitee 文档端点** —— 文档能力的唯一实现是 MCP，
     * 见 `host/mcpDocs.ts`。
     */
    readonly docs: DocService;
    /**
     * 仓库与仓库 WIKI 的编排层（J 层）。
     *
     * 列表同样只走 MCP；WIKI 正文走 git（Gitee 没有 HTTP 接口），
     * 理由与边界见 `host/wikiCache.ts`。
     */
    readonly repos: RepoService;
}
/**
 * 创建路由处理器。
 * @param deps - 执行器、信任列表、版本号。
 * @returns 供 `ctx.webServer.register` 使用的 handler。
 */
export declare function createRouteHandler(deps: RouteDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
