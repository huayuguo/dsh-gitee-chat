/**
 * 知识库文档的**编排层**（host 平面）。
 *
 * 它把两件事接起来：
 *   - `./mcp-docs` —— **唯一的文档实现**（委派 MCP 工具）
 *   - `./doc-cache` —— 按需缓存 + 页级四态判定（纯函数）
 *
 * 这一层**只做编排**：调哪个工具、什么时候落盘、哪些页该拉。
 * 它**不认识任何文档端点**（那是 MCP 的事）。
 *
 * 三条行为纪律：
 *
 *   1. **不预拉** —— 列表只列文档；正文只在被选中那一页时取。
 *   2. **不覆盖本地改动** —— `local-dirty` 的页永不自动覆盖，只报告。
 *   3. **冲突不自动合并** —— `conflict` 明确抛给界面，让人决策。
 *
 * @module dsh-gitee-chat/host/doc-service
 */
import type { McpDocs } from './mcpDocs.ts';
import type { DocAttachmentResponse, DocDetailResponse, DocListResponse, DocPageResponse, DocPageStateView, DocSearchResponse, DocSyncResponse, DocTreeResponse } from '../types.ts';
/** 编排层依赖。 */
export interface DocServiceDeps {
    readonly docs: McpDocs;
    /** 缓存根（默认 `$DSH_HOME/gitee/docs`）。 */
    readonly cacheRoot: string;
    /** 单页正文落盘上限（字符）。 */
    readonly maxPageChars?: number;
    /**
     * 读取**附件内容**的实现（可选）。
     *
     * 本企业知识库的真实内容是 `AttachFile`（上传的 .md/.docx/.pdf…），
     * 读它需要 MCP 侧的下载工具。**这个依赖在不在，就是"内容可读"的开关** ——
     * 不在时界面会**明确标注"只能看结构与文件名"**，而不是给一个点了没反应的入口。
     */
    readonly readAttachmentContent?: (input: {
        sessionId: string;
        nodeId: number;
        fileName: string;
        /** 附件内容 id（`list_doc_nodes` 的 `file_id`），**不是**节点 id。 */
        fileId: number;
        programId: number | null;
        /** 该节点应落的缓存目录（由编排层算好）。 */
        cacheDir: string;
    }) => Promise<{
        savedPath: string;
        bytes: number;
        contentType: string;
        ext: string;
        /** 文本类返回正文；二进制类返回 null（不假装能预览）。 */
        content: string | null;
        truncated: boolean;
    }>;
    /**
     * 按会话取工作目录（读不到返回空串）。
     *
     * 存在的唯一理由：侧边栏的文件围栏按**会话 cwd**判定，而缓存根在工作区之外。
     * 把 `<cwd>/.dsh/gitee-docs` 这条软链接交给侧边栏，它才读得到缓存里的文件。
     */
    readonly cwdOf?: (sessionId: string) => string;
    /** 工作区软链接路径解析（在缓存根与工作区之间换算）。 */
    readonly workspaceLink?: (cwd: string) => Promise<string | null>;
    /** 缓存根 → 工作区可见路径的换算（纯函数）。 */
    readonly toWorkspacePath?: (link: string, absolute: string) => string | null;
}
/**
 * 创建文档编排服务。
 * @param deps - 委派客户端、缓存根、上限。
 */
export declare function createDocService(deps: DocServiceDeps): {
    /** 缓存根（诊断/界面展示用）。 */
    cacheRoot: string;
    /**
     * 读一个**附件节点**的内容（并落到本地缓存）。
     *
     * 这是本企业知识库**唯一真正能读内容**的路径（实测：全是
     * `DocDirectory` + `AttachFile`，没有 WikiInfo 文档）。
     *
     * 流程（每一步都有理由）：
     *   1. 算缓存目录 `pj-<pid>/<nodeId>-<slug>/`（按项目分文件夹，需求指定）；
     *   2. 委派 MCP 的 `download_attach_file` 把文件写进去 —— **workspace 传缓存根**，
     *      因为缓存根在会话工作区之外，不传会被沙箱直接拒绝；
     *   3. 从磁盘读回来；文本类返回正文，二进制类只返回元信息（不假装能预览）。
     *
     * ## 一致性口径（A1：缓存的变更感知）
     *
     * 附件**不可变**（在 Gitee 上改 = 重新上传成新节点），所以这里没有"页级 version"，
     * 也不存在 `local-dirty` / `conflict` —— 我们从不改本地附件。
     * 唯一要回答的是：**远端那份还是不是我下的那份？** 依据是节点上的
     * `updatedAt` 与 `size`（下载时把它们记进 `.gitee-attach.json`）。
     *
     * 于是点击的语义是**省网络**的：
     *   · `synced`       → 直接读本地，**一次 MCP 调用都不发**
     *   · `remote-ahead` → 仍然给本地那份，但标出"远端已更新"；
     *                      **绝不自动覆盖** —— 要新的就显式 `refresh=1`
     *   · `not-cached` / `missing` → 下载
     *
     * @param sessionId - 会话 id。
     * @param input - 节点 id、file_id、名字、所属项目、当前远端事实、是否强制重下。
     */
    attachment(sessionId: string, input: {
        nodeId: number;
        fileId: number;
        name: string;
        programId: number | null;
        /** 当前节点上的 `updated_at`（用于判定远端有没有变；可缺）。 */
        updatedAt?: string;
        /** 当前节点上的 `attach_file.size`（0 = 未知）。 */
        size?: number;
        /** 忽略本地缓存，强制重下。 */
        refresh?: boolean;
    }): Promise<DocAttachmentResponse>;
    /**
     * 列知识库**节点**（`doc_nodes` 树）—— 本企业知识库的**真实入口**。
     *
     * 为什么不用 `list_enterprise_documents`：实测（2026-09-15）本企业**一篇
     * `WikiInfo` 文档都没有**，那条路恒返回 0；真实内容是 `DocDirectory` +
     * `AttachFile` 组成的树，只能从 `/doc_nodes/level` 走。
     *
     * **按需**：只列给定范围、给定父节点下的**一层**；展开哪一层由界面决定。
     *
     * @param sessionId - 会话 id（作用域）。
     * @param programId - null = 企业级公共知识库；否则是该项目的知识库。
     * @param parentId - 父节点 id（0 = 该范围顶层）。
     */
    listNodes(sessionId: string, programId: number | null, parentId?: number): Promise<DocTreeResponse>;
    /**
     * 列出 `WikiInfo` 文档（`list_enterprise_documents`）。
     *
     * ⚠️ **本企业暂未使用这种形态**（实测为 0 篇）。这条路径保留给"知识库文档
     * 形态"（可编辑、有页级 version、能协作）—— 一旦有人在网页上建了这种文档，
     * `detail` / `page` / `sync` 这一套立刻可用。
     *
     * @param sessionId - 会话 id（作用域）。
     * @param scope - `common` = 企业级公共文档；`program` = 指定项目。
     * @param programId - scope=program 时的项目 id。
     */
    list(sessionId: string, scope: "common" | "program", programId?: number): Promise<DocListResponse>;
    /**
     * 企业级关键词搜索。
     *
     * ⚠️ **不能按项目过滤** —— MCP 的 `search` 与 `program_id` 互斥。
     * 响应里带 `enterpriseWide: true`，界面据此明确提示。
     *
     * @param sessionId - 会话 id。
     * @param query - 关键词。
     */
    search(sessionId: string, query: string): Promise<DocSearchResponse>;
    /**
     * 文档详情：**页树 + 每页的本地状态**，并给出"哪些页需要拉"。
     *
     * 成本 = 1 次 MCP 调用（`list_enterprise_document_pages` 一次带回全部页的 version）。
     * 这就是"按需"的关键：核对很便宜，所以可以每次打开都核。
     *
     * @param sessionId - 会话 id。
     * @param documentId - 文档 id。
     * @param hint - 首次访问时用来定位缓存目录（programId 与 name）。
     */
    detail(sessionId: string, documentId: number, hint?: {
        programId: number | null;
        name: string;
    }): Promise<DocDetailResponse>;
    /**
     * 读一页正文：**本地优先、且只在确认一致时用本地**。
     *
     * 决策表（`state` 由四态判定给出）：
     *   - `synced` / `local-dirty` / `conflict`：本地有内容 → 直接给本地
     *     （已改未推送的版本就是用户要看的那个；冲突也要让他先看到本地）
     *   - `not-cached` / `missing` / `remote-ahead`：从 MCP 取，并落盘
     *
     * @param sessionId - 会话 id。
     * @param documentId - 文档 id。
     * @param pageId - 页 id。
     * @param hint - 首次访问时用来定位缓存目录。
     */
    page(sessionId: string, documentId: number, pageId: number, hint?: {
        programId: number | null;
        name: string;
    }): Promise<DocPageResponse>;
    /**
     * 核对 / 拉取。
     *
     * `check` 只报告差异；`pull` 逐页把需要拉的拉下来。
     * **`local-dirty` 与 `conflict` 的页永不自动拉取**（那会覆盖用户的编辑），
     * 只在响应里列出来。
     *
     * @param sessionId - 会话 id。
     * @param documentId - 文档 id。
     * @param mode - `check` | `pull`。
     * @param hint - 首次访问时用来定位缓存目录。
     */
    sync(sessionId: string, documentId: number, mode: "check" | "pull", hint?: {
        programId: number | null;
        name: string;
    }): Promise<DocSyncResponse>;
    /**
     * 清掉**一个附件/文档节点**的本地缓存（界面上的「清缓存」）。
     *
     * 语义是安全的：缓存本来就是"读过才在"的副本，删掉只是让下一次点击重新下载，
     * 不会动 Gitee 上任何东西 —— 所以这里**不需要二次确认**。
     *
     * @param input - 节点 id、名字、归属项目（用它算缓存目录）。
     */
    forgetAttachment(input: {
        nodeId: number;
        name: string;
        programId: number | null;
    }): {
        removed: boolean;
        dir: string;
    };
    /**
     * 清掉**一个项目（或企业级公共）**的全部附件缓存。
     *
     * 走的是 `scopePath`（`pj-<id>/` 或 `_common/`）—— 整个目录一次删掉，
     * 而不是逐条点名。**不碰 `wiki/`**：仓库 WIKI 是 git 克隆、另一套语义，
     * 要清它有单独的入口。
     *
     * @param programId - null = 企业级公共。
     */
    forgetScope(programId: number | null): {
        removed: boolean;
        dir: string;
    };
    /** 某个项目/公共文档集合的本地目录（界面显示与批量清理都用它）。 */
    scopePath(programId: number | null): string;
    /**
     * 缓存用量（A2 的"看"那一半）：附件与仓库 WIKI 分开报。
     *
     * 分开是有理由的：附件是"读过的副本"，WIKI 是**整个 git 克隆**（通常大得多）。
     * 合成一个数字会让人以为清附件就能腾出空间。
     */
    cacheInfo(): {
        cacheRoot: string;
        attachments: {
            count: number;
            bytes: number;
        };
        wikis: {
            count: number;
            bytes: number;
        };
        truncated: boolean;
    };
    /** 状态名（界面文案，集中一处避免各处自己写）。 */
    label(state: DocPageStateView): string;
    /** 供 /ping 诊断：本地缓存根与已缓存文档数。 */
    snapshot(): {
        cacheRoot: string;
        documents: number;
        enterpriseId: number;
    };
};
/** 编排服务类型。 */
export type DocService = ReturnType<typeof createDocService>;
/** 默认缓存根：`$DSH_HOME/gitee/docs`（需求指定，不带点）。 */
export declare function defaultDocsRoot(dshHome: string): string;
