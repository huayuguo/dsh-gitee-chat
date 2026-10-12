/**
 * Gitee 企业知识库文档 —— **MCP 委派层**（host 平面）。
 *
 * ## 这个文件存在的唯一理由
 *
 * 本层只守一条纪律：**MCP 是文档能力的唯一实现**。
 * 插件**不实现任何文档端点** —— 不拼 `/doc_nodes/tile`、不拼 `/docs/{id}/files`、
 * 不自己调 `/docs/{id}/export`。所有文档数据都经 MCP 工具获得。
 *
 * 而 MCP 行（`mcp-gitee`，`@deepseek-ai/dsh-mcp-client`）挂在 **preset** 里，
 * `serverName: gitee_ent`，所以：
 *
 *   1. 工具名是 `mcp__gitee_ent__<tool>`；
 *   2. 它**只在该 preset 的 agent 作用域可见** —— profile 层的全局视角看不到；
 *   3. 所以调用必须带 `agent`，否则拿到 `UNKNOWN_TOOL`。
 *
 * 这与「客户端插件拿不到会话的 preset」是同一类事实，
 * 解法也同款：**由 host 按 sessionId 解析出作用域**。
 *
 * ## 白拿的好处
 *
 * `./agent` 里那个能力档 guard 是 **agent 作用域**的。host 经该作用域调用
 * 会照样过 guard —— 于是**标签页发起的文档调用与模型发起的受完全相同的档位约束**。
 * 这是"只有一份实现"的直接收益，不需要在 host 侧再写一套权限判断。
 *
 * @module dsh-gitee-chat/host/mcp-docs
 */
import { type EnterpriseIdResolver } from './enterpriseId.ts';
/** 文档委派失败的原因（供路由映射 HTTP 状态）。 */
export type DocErrorCode = 
/** 请求没带 sessionId。 */
'no-session'
/** 该会话没有活的 agent（未加载 / 已归档）。 */
 | 'no-agent'
/** 宿主没有 tools 注册表（组合不完整）。 */
 | 'no-tools'
/** 解析不出企业 id（没钉、没有本地配置、token 又对不上唯一企业）。 */
 | 'no-enterprise'
/** MCP 工具不存在（多半是该会话没挂 Gitee preset，或前缀配错了）。 */
 | 'unknown-tool'
/** MCP 工具本身报错（参数、权限、网络…）。 */
 | 'tool-failed'
/** MCP 返回的形状不是我们能认的 JSON。 */
 | 'bad-response'
/** 调用超时。 */
 | 'timeout';
/** 委派层错误：带可判定的 code，便于路由给出可行动的提示。 */
export declare class DocError extends Error {
    readonly code: DocErrorCode;
    constructor(code: DocErrorCode, message: string);
}
/** `ctx.tools` 的最小可用表面（只取我们要用的那个方法）。 */
export interface ToolsService {
    execute(exec: {
        callId: string;
        name: string;
        arguments: unknown;
        agent?: unknown;
        signal: AbortSignal;
    }): Promise<ToolExecutionLike>;
}
/** `tools.execute` 的返回（成功/失败两态，见 tools 服务契约）。 */
export interface ToolExecutionLike {
    isError: boolean;
    value?: unknown;
    content?: unknown;
    error?: {
        message?: string;
        info?: {
            name?: string;
            code?: string;
        };
    };
}
/** 委派层依赖。 */
export interface McpDocDeps {
    /** 按会话 id 取活着的 agent（作用域）。拿不到返回 undefined。 */
    readonly agentOf: (sessionId: string) => unknown | undefined;
    /** 取 tools 注册表（可选：组合不完整时为 undefined）。 */
    readonly tools: () => ToolsService | undefined;
    /** MCP 工具名前缀（默认 `mcp__gitee_ent__`，跟 preset 的 serverName 走）。 */
    readonly toolPrefix: string;
    /** 企业 id **解析器**（工具的第一个必填参数，每次调用现取 —— 见 host/enterpriseId.ts）。 */
    readonly enterprise: EnterpriseIdResolver;
    /** 单次调用超时（毫秒）。 */
    readonly timeoutMs?: number;
}
/** 文档节点的界面形状（由 MCP 的 Document 裁剪而来）。 */
export interface DocSummary {
    documentId: number;
    documentNodeId: number;
    name: string;
    filePath: string;
    programId: number | null;
    programName: string;
    updatedAt: string;
    createdAt: string;
}
/** 页/文件夹的界面形状。 */
export interface DocPageSummary {
    pageId: number;
    parentPageId: number;
    name: string;
    /** `page` | `folder` */
    type: string;
    /** 远程权威版本（提交 id 语义）。核对就靠它。 */
    version: string;
    lastEditTime: string;
    contentType: string;
}
/** 一页正文。 */
export interface DocPageContent extends DocPageSummary {
    content: string;
    /** 正文是否被我们截断（截断必须显式告知，见 F-19）。 */
    truncated: boolean;
    bytes: number;
}
/**
 * 知识库**节点**（`doc_nodes` 树里的一项）。
 *
 * 这是本企业知识库的**真实形态**（实测 2026-09-15）：企业/项目知识库是一棵
 * `DocDirectory`（文件夹）+ `AttachFile`（上传的 .md/.docx/.pdf/.png…）的树。
 *
 * ⚠️ **不是** `list_enterprise_documents` 那种 `WikiInfo` 文档 —— 本企业一篇都没有，
 * 所以那条路永远返回 0。这不是 bug，是**绑错了数据源**。
 */
export interface DocNodeSummary {
    nodeId: number;
    parentId: number;
    name: string;
    /** `DocDirectory` / `AttachFile` / 其它（原样透传，界面按它分支）。 */
    fileType: string;
    /**
     * 附件/文档内容的 id —— **读内容用它**（`download_attach_file`）。
     * 目录节点为 0。注意它**不是**节点 id。
     */
    fileId: number;
    /** 知识库内的路径，如 `项目知识库/[PRD] xxx/设备参数文档.md`。 */
    filePath: string;
    /**
     * 附件字节数（来自节点上的 `attach_file.size`）。
     *
     * 目录节点、以及接口不带该字段时为 **0** —— 消费方必须按"0 = 未知"处理，
     * 不能拿它当"空文件"。它是**缓存变更感知**的两个依据之一（另一个是 `updatedAt`）：
     * 附件不可变，远端变没变只能靠这两个字段比，见 `docCache.classifyAttachState`。
     */
    size: number;
    programId: number | null;
    createdAt: string;
    updatedAt: string;
    /** 由文件名推出的扩展名（小写；无扩展名为空串）。 */
    ext: string;
}
/** 搜索结果命中（企业级，不能按项目过滤）。 */
export interface DocSearchHit {
    documentId: number;
    documentNodeId: number;
    documentName: string;
    documentPath: string;
    pageId: number;
    pageName: string;
    contentPreview: string;
    updatedAt: string;
}
/** 仓库的界面形状（由 MCP `list_enterprise_repositories` 裁剪而来）。 */
export interface RepoSummary {
    repoId: number;
    name: string;
    /**
     * URL 路径段（**不是** name）。
     *
     * 实测（2026-09-15）：同一个仓库 `name` 与 `path` 经常不同 ——
     * `name=demo-docs` 而 `path=docs`、`name=demo-server` 而 `path=demoserver`。
     * 用 `name` 拼 `{repo}.wiki.git` 会 404，必须用 `path_with_namespace`。
     */
    path: string;
    pathWithNamespace: string;
    description: string;
    /** `public` 原始值：0=私有，2=企业内部开源。 */
    public: number;
    defaultBranch: string;
    membersCount: number;
    lastPushAt: string;
    repoSize: number;
    outsourced: boolean;
    statusName: string;
    /**
     * WIKI 是否有内容 —— 来自 fork 的 `types.Repository.wiki_enabled_with_content`。
     *
     * 这个字段是本 fork **补声明**的：Go 的 `json.Unmarshal` 只填声明过的字段，
     * 早先没声明，于是接口明明返回了、客户端却永远是 false（与 `DocNode.FileId`
     * 同一类静默丢数据的坑）。
     */
    wiki: boolean;
}
/**
 * 从一个 `tools.execute` 结果里取出 MCP 工具返回的 JSON 载荷。
 *
 * ## 为什么这里必须写得这么啰嗦（一次真实事故）
 *
 * DSH 的 MCP 桥接（`@deepseek-ai/dsh-mcp-client`）**不是**把工具返回的 JSON
 * 直接放进 `value`。它的契约是：
 *
 * ```js
 * value = { content: [ { type: 'text', text: '<工具返回的 JSON 文本>' } ],
 *           ...(structuredContent !== undefined ? { structuredContent } : {}) }
 * ```
 *
 * 也就是说 —— **`value` 是 `{content: [...]}` 这个信封，真正的载荷在文本块里**。
 * 早先这里写成「`value` 存在就直接返回它」，于是每个字段查找都落空：
 * `record.data` / `record.documents` / `record.total_count` 全是 undefined，
 * 界面永远显示"顶层 0 项"，**而且不报错** —— 最难查的一类故障。
 *
 * 所以现在的顺序是：`structuredContent` → `value.content` 文本块解析 → `value` 本身
 * → 顶层 `content`。四步都试过才报 `bad-response`。
 *
 * @param name - 工具名（错误信息里用）。
 * @param result - `tools.execute` 的返回。
 */
export declare function unwrapToolResult(name: string, result: ToolExecutionLike): unknown;
/**
 * 创建文档委派客户端。
 *
 * **每一个方法都只做三件事**：拼参数 → 按作用域调 MCP → 裁剪成界面要的形状。
 * 任何"这个端点该怎么调"的知识都**不在这个文件里**，它在 MCP 工具的描述里。
 *
 * @param deps - agent 解析、tools 注册表、前缀与企业 id 解析器。
 */
export declare function createMcpDocs(deps: McpDocDeps): {
    /**
     * 当前生效的企业 id（**现取**：诊断用；缓存分层也以它为准）。
     *
     * 注意它是同步解析的第 1–3 步（flag/env/本地配置），自动识别出来的那家会作为
     * 最近一次探测结果回报 —— 与真正发给 MCP 的 id 在自动识别场景下可能有一拍之差。
     */
    resolveEnterpriseId: () => number;
    /** 工具名前缀（诊断用）。 */
    toolPrefix: string;
    /**
     * 列举企业文档（可按项目过滤）。
     * 委派 `list_enterprise_documents` → `/doc_nodes/tile`。
     * @param sessionId - 会话 id。
     * @param options - programId 传了就是项目文档；search 传了就是搜索（**与 programId 互斥**，MCP 会拒）。
     */
    listDocuments(sessionId: string, options?: {
        programId?: number;
        search?: string;
        page?: number;
        perPage?: number;
    }): Promise<{
        documents: DocSummary[];
        total: number;
        searchMode: boolean;
    }>;
    /**
     * 企业级关键词搜索（**不能按项目过滤** —— 这是 MCP 的硬限制）。
     * @param sessionId - 会话 id。
     * @param query - 关键词。
     */
    searchDocuments(sessionId: string, query: string, page?: number): Promise<DocSearchHit[]>;
    /**
     * 列知识库**节点**（`doc_nodes` 树）—— 本企业知识库的**真实入口**。
     *
     * 委派 `list_doc_nodes` → `GET /{eid}/doc_nodes/level`。
     * 与 `listDocuments`（tile/WikiInfo）的区别，见 `DocNodeSummary` 的说明：
     * **tile 那条路在本企业恒为 0**，别再用它当列表源。
     *
     * @param sessionId - 会话 id。
     * @param options - parentId（默认 0=该范围顶层）、programId（传了就是项目知识库）、fileType 过滤。
     */
    listNodes(sessionId: string, options?: {
        parentId?: number;
        programId?: number;
    }): Promise<DocNodeSummary[]>;
    /**
     * 列企业**仓库**。
     *
     * 委派 `list_enterprise_repositories` → `GET /{eid}/projects`。
     * 注意路径是 `projects`（Gitee 企业版 API 里"仓库"就叫 project），
     * 与 `list_program_doc_nodes` 的"项目（program）"**不是一回事**。
     *
     * 实测（2026-09-15）两条过滤都有效，且是界面上那两种口径的唯一实现：
     *   - `program_id=<id>` → 该项目下的仓库（9500001 → 4 个；9500002 → 2 个）
     *   - `scope=internal-open` → 企业内部开源（24 个里 2 个）
     *
     * @param sessionId - 会话 id。
     * @param options - programId（项目下）或 scope（内置枚举），二者互斥使用。
     */
    listRepositories(sessionId: string, options?: {
        programId?: number;
        scope?: string;
        perPage?: number;
    }): Promise<RepoSummary[]>;
    /**
     * 把**附件内容**下载到本地目录。
     *
     * 委派 `download_attach_file`（**本 fork 独有**，v0.2.1-dsh.3 加入）→
     * `GET /{eid}/attach_files/{file_id}`。
     *
     * ⚠️ 两个实测教训，别改回去：
     *   1. 节点里的 `attach_file.download_url` 指向 **Web 域**，要会话 Cookie，
     *      用企业 token 打是 401 —— 必须走 API 形态（本工具就是这么实现的）。
     *   2. 目录作用域由**本次调用传的 `workspace`** 决定；缓存根在会话工作区之外，
     *      所以调用方必须把 `workspace` 指到缓存根，否则会被直接拒绝。
     *
     * @param sessionId - 会话 id。
     * @param input - file_id、目标目录、workspace（目录作用域上限）、可选文件名。
     */
    downloadAttachFile(sessionId: string, input: {
        fileId: number;
        outputDirectory: string;
        workspace: string;
        fileName?: string;
        overwrite?: boolean;
    }): Promise<{
        savedPath: string;
        filename: string;
        bytes: number;
        contentType: string;
    }>;
    /**
     * 列一个文档里的全部页与文件夹（**一次就带回全部页的 version**，核对成本极低）。
     * 委派 `list_enterprise_document_pages` → `/docs/{id}/files`。
     *
     * ⚠️ 只对 `WikiInfo` 文档有效。**本企业暂无此类文档**（实测），
     * 项目资料是 `AttachFile` 附件，没有"页"这个概念。
     */
    listPages(sessionId: string, documentId: number): Promise<DocPageSummary[]>;
    /**
     * 读一页正文。`version` 传历史版本 / commit id 可读历史。
     * 委派 `get_enterprise_document_page`。
     * @param sessionId - 会话 id。
     * @param documentId - 文档 id。
     * @param pageId - 页 id。
     * @param version - 可选：读历史版本。
     * @param maxChars - 正文截断上限（超出置 truncated）。
     */
    getPage(sessionId: string, documentId: number, pageId: number, version?: string, maxChars?: number): Promise<DocPageContent>;
    /**
     * 改一页正文 —— **整页替换**，必须带 `expected_version` 与 `commit_message`。
     *
     * 委派 `update_enterprise_document_page`。乐观锁由 **MCP 工具**实现
     * （它会先重读页面，版本不符直接拒），插件**不重复实现**这道校验，
     * 但也**绝不绕过**它。
     *
     * @param sessionId - 会话 id。
     * @param input - 文档/页 id、整页内容、期望版本、提交说明。
     */
    updatePage(sessionId: string, input: {
        documentId: number;
        pageId: number;
        content: string;
        expectedVersion: string;
        commitMessage: string;
        pageName?: string;
    }): Promise<DocPageSummary>;
};
/** 委派客户端类型。 */
export type McpDocs = ReturnType<typeof createMcpDocs>;
