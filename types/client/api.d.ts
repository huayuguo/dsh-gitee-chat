/**
 * 卡片 → 宿主取数通道。
 *
 * 卡片不通过模型拿数据：它拿工具调用的**参数**，直接向插件自己的路由要
 * 完整 payload。这是「模型只触发、数据由后台灌」的实现点。
 *
 * @module dsh-gitee-chat/client/api
 */
import type { DocAttachmentResponse, DocDetailResponse, DocListResponse, DocPageResponse, DocSearchResponse, DocSyncResponse, DocTreeResponse, ErrorResponse, HealthResponse, IssueDetailPayload, IssueStateRow, IssueWriteRequest, IssueWriteResult, PayloadResponse, ProgramMemberRow, RepoListResponse, WikiPageResponse, WikiTreeResponse } from '../types.ts';
/** 取数参数（与工具参数同构）。 */
export interface BoardArgs {
    scope?: string;
    program?: number;
    refresh?: boolean;
}
/** 卡片侧错误：带可判定的 code，便于给出可行动的提示。 */
export declare class BoardApiError extends Error {
    readonly code: ErrorResponse['code'] | 'network';
    constructor(code: ErrorResponse['code'] | 'network', message: string);
}
/**
 * 取看板数据。
 * @param args - 工具调用的参数（scope/program/refresh）。
 * @param signal - 取消信号（组件卸载时中断）。
 */
export declare function fetchBoard(args: BoardArgs, signal?: AbortSignal): Promise<PayloadResponse>;
/** 会话是否跑在 Gitee 模式上。 */
export interface SessionProbe {
    ok: boolean;
    sessionId: string;
    /** true/false；null = host 尚不知道这个会话（刚创建、尚无事件）。 */
    gitee: boolean | null;
    preset: string | null;
}
/**
 * 问 host：这个会话是不是 Gitee 模式。
 *
 * 为什么必须问 host：客户端插件在 profile 层，它注册的 conversation.view
 * 对**所有 preset** 可见，客户端自己拿不到会话的 preset（SessionSummary 里没有）。
 * @param sessionId - 当前会话 id。
 */
export declare function fetchSession(sessionId: string, signal?: AbortSignal): Promise<SessionProbe>;
/** 一个工作项（视图下钻用）。 */
export interface WorkItemRow {
    id: number;
    ident: string;
    title: string;
    state: string;
    priorityHuman: string;
    programId: number;
    assignee: string;
    deadline: string;
    typeTitle: string;
    overdue: boolean;
    overdueDays: number;
}
/** 单项目工作项清单。 */
export interface ProgramIssues {
    ok: boolean;
    generatedAt: string;
    programId: number;
    total: number;
    kpi: {
        total: number;
        overdue: number;
        unassigned: number;
    };
    distribution: {
        state: string;
        count: number;
    }[];
    issues: WorkItemRow[];
}
/**
 * 取某个项目的工作项清单（整屏视图下钻）。
 * @param programId - 项目 id。
 * @param state - 可选状态过滤。
 */
export declare function fetchIssues(programId: number, state?: string, signal?: AbortSignal): Promise<ProgramIssues>;
/** 环境自检（供健康卡片使用）。 */
export declare function fetchHealth(signal?: AbortSignal): Promise<HealthResponse>;
/** token 配置状态（不返回明文 token，只报是否已配置与来源）。 */
export interface TokenStatusResponse {
    ok: boolean;
    configured: boolean;
    source: 'file' | 'env' | null;
    path: string;
}
/** 查询当前 token 是否已配置。 */
export declare function fetchTokenStatus(signal?: AbortSignal): Promise<TokenStatusResponse>;
/** 保存企业版 token（写入 ~/.dsh/.gitee-chat/token，取数即时生效、无需重启）。 */
export declare function postToken(token: string, signal?: AbortSignal): Promise<{
    ok: boolean;
    path: string;
}>;
/** token 可见的一个企业。 */
export interface EnterpriseEntry {
    id: number;
    name: string;
    path?: string;
}
/** 企业列表 + 「现在用的是哪家、为什么是这家」。 */
export interface EnterpriseListResponse {
    ok: boolean;
    enterprises: EnterpriseEntry[];
    /** 脚本解析出的当前企业（0 = 未指定）。 */
    current: number;
    /** 当前值的来源（本地配置文件 / 插件配置 / 环境变量 / 未指定（自动））。 */
    source: string;
    fileEnterpriseId: number;
    configPath: string;
    /** 插件配置钉住的企业（>0 时这里选不生效）。 */
    pinned: number;
    /** 真正生效的企业。 */
    effective: number;
}
/** 切换结果。 */
export interface EnterpriseSwitchResponse {
    ok: boolean;
    selected: {
        id: number;
        name: string;
    } | null;
    configPath: string;
    pinned: number;
    effective: number;
    invalidated: string[];
}
/** 列出 token 可见的企业（未配 token 时宿主返回 409）。 */
export declare function fetchEnterprises(signal?: AbortSignal): Promise<EnterpriseListResponse>;
/** 切换当前企业（写本地配置 + 失效看板缓存与身份人格，无需重启）。 */
export declare function postEnterprise(id: number, signal?: AbortSignal): Promise<EnterpriseSwitchResponse>;
/**
 * 取工作项详情：描述 / 前置依赖 / 评论讨论。
 * @param ident - 工作项编号（如 DM0001）。
 */
export declare function fetchIssue(ident: string, signal?: AbortSignal): Promise<IssueDetailPayload>;
/** 某工作项类型下的可选状态（改状态的选项）。 */
export declare function fetchStates(typeId: number, signal?: AbortSignal): Promise<IssueStateRow[]>;
/** 项目成员（改派的候选人）。 */
export declare function fetchMembers(programId: number, signal?: AbortSignal): Promise<ProgramMemberRow[]>;
/**
 * 提交一次写操作。
 *
 * 这是 UI 里**唯一**会改动 Gitee 数据的调用；host 侧对应唯一写入口
 * `/api/gitee-chat/write`（见 host/write.ts）。必须带 sessionId——
 * host 用它确认这是 Gitee 模式的会话。
 *
 * @param request - 写请求（op / ident / 载荷 / sessionId）。
 */
export declare function postWrite(request: IssueWriteRequest, signal?: AbortSignal): Promise<IssueWriteResult>;
/** 文档视图里"当前项目"的定位信息（首次落盘要用它算缓存目录）。 */
export interface DocHint {
    programId: number | null;
    name: string;
}
/**
 * 列知识库**节点树**的一层（本企业知识库的真实入口）。
 *
 * 与 `fetchDocs`（WikiInfo 文档）的区别：本企业知识库是
 * `DocDirectory` + `AttachFile` 的树，`fetchDocs` 那条路恒为 0。
 *
 * @param sessionId - 会话 id。
 * @param programId - null = 企业级公共知识库；否则是该项目的知识库。
 * @param parentId - 父节点 id（0 = 该范围顶层）。
 */
export declare function fetchDocNodes(sessionId: string, programId: number | null, parentId?: number, signal?: AbortSignal): Promise<DocTreeResponse>;
/**
 * 读一个**附件节点**的内容（本企业知识库真正能读的那条路）。
 *
 * host 会委派 MCP 的 `download_attach_file` 把文件写进缓存根，再把文本读回来。
 * @param nodeId - 节点 id。
 * @param fileId - 附件内容 id（**不是**节点 id）。
 */
export declare function fetchDocAttachment(sessionId: string, input: {
    nodeId: number;
    fileId: number;
    name: string;
    programId: number | null;
    /** 节点当前的远端事实（来自列表）—— 让宿主能判"本地这份还新不新"。 */
    updatedAt?: string;
    /** 节点当前的 `attach_file.size`（0 = 未知）。 */
    size?: number;
    /** 忽略本地缓存强制重下。 */
    refresh?: boolean;
}, signal?: AbortSignal): Promise<DocAttachmentResponse>;
/**
 * 列仓库（**J 层**）。
 *
 * 两种口径（host 侧决定）：
 *   - `programId` 给了 → 该项目下的仓库；
 *   - 没给 → 只列**企业内部开源**的仓库。
 * @param sessionId - 会话 id（host 用它解析 agent 作用域）。
 * @param programId - null = 不限定项目口径。
 * @param programName - 项目名（host 回填到提示语里）。
 */
export declare function fetchRepos(sessionId: string, programId: number | null, programName?: string, signal?: AbortSignal): Promise<RepoListResponse>;
/**
 * 取一个仓库的 WIKI 文件树。
 *
 * ⚠️ 这一条**不是** MCP 提供的：Gitee 没有列仓库 WIKI 的 HTTP 接口，
 * host 走的是 git 克隆 `{path_with_namespace}.wiki.git`。
 * @param repoId - 仓库 id。
 * @param repoPath - `path_with_namespace`（**不是 name**，两者经常不同）。
 * @param refresh - true = 强制 fetch 远端。
 */
export declare function fetchWiki(sessionId: string, repo: {
    repoId: number;
    repoPath: string;
    repoName: string;
}, refresh?: boolean, signal?: AbortSignal): Promise<WikiTreeResponse>;
/**
 * 读 WIKI 里的一页正文。
 * @param path - 相对 WIKI 根目录的路径。
 */
export declare function fetchWikiPage(sessionId: string, repo: {
    repoId: number;
    repoPath: string;
    repoName: string;
}, path: string, signal?: AbortSignal): Promise<WikiPageResponse>;
/** 缓存用量响应。 */
export interface CacheInfoResponse {
    ok: true;
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
    /** 当前范围的目录（`pj-<id>/` 或 `_common/`）。 */
    scopeDir: string;
}
/** 清缓存响应。 */
export interface CacheForgetResponse {
    ok: true;
    target: 'attachment' | 'scope';
    /** false = 本来就没缓存（不是错误）。 */
    removed: boolean;
    dir: string;
}
/**
 * 看缓存用量（附件与仓库 WIKI 分开报）。
 * @param sessionId - 会话 id（与其他文档路由保持一致）。
 * @param programId - 用来算"当前范围"的目录。
 */
export declare function fetchCacheInfo(sessionId: string, programId: number | null, signal?: AbortSignal): Promise<CacheInfoResponse>;
/**
 * 清缓存。**安全动作**：缓存是"读过才在"的副本，删了只让下次点击重新下载。
 * @param target - `attachment` 清一个节点；`scope` 清一个项目/企业级公共的全部附件。
 */
export declare function forgetCache(sessionId: string, target: {
    kind: 'attachment';
    nodeId: number;
    name: string;
    programId: number | null;
} | {
    kind: 'scope';
    programId: number | null;
}, signal?: AbortSignal): Promise<CacheForgetResponse>;
/**
 * 列出知识库文档（**WikiInfo 形态**）。
 *
 * ⚠️ 本企业暂未使用这种形态，实测为 0 篇 —— 界面请用 `fetchDocNodes`。
 * @param sessionId - 会话 id（host 用它解析 agent 作用域）。
 * @param programId - null = 企业级公共文档；否则是该项目的文档。
 */
export declare function fetchDocs(sessionId: string, programId: number | null, signal?: AbortSignal): Promise<DocListResponse>;
/**
 * 企业级关键词搜索（**不能按项目过滤** —— MCP 的硬限制）。
 * @param sessionId - 会话 id。
 * @param query - 关键词。
 */
export declare function searchDocs(sessionId: string, query: string, signal?: AbortSignal): Promise<DocSearchResponse>;
/** 取文档详情：页树 + 每页的本地四态 + 待拉页。 */
export declare function fetchDoc(sessionId: string, documentId: number, hint?: DocHint, signal?: AbortSignal): Promise<DocDetailResponse>;
/** 取一页正文（本地优先，不一致时才走 MCP）。 */
export declare function fetchDocPage(sessionId: string, documentId: number, pageId: number, hint?: DocHint, signal?: AbortSignal): Promise<DocPageResponse>;
/**
 * 核对 / 拉取变更。
 * @param mode - `check` 只报告差异；`pull` 逐页拉取（本地已改的页永不覆盖）。
 */
export declare function postDocSync(sessionId: string, documentId: number, mode: 'check' | 'pull', hint?: DocHint, signal?: AbortSignal): Promise<DocSyncResponse>;
export type { DocListResponse, DocDetailResponse, DocPageResponse, DocSyncResponse, DocSearchResponse };
