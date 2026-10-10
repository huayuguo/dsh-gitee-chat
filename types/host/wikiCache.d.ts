/**
 * 仓库 WIKI 的取数与缓存（host 平面）。
 *
 * ## 为什么这里出现了 git —— 以及它为什么**不是**越界
 *
 * 本层守一条纪律：**MCP 是文档能力的唯一实现**，插件不拼任何 Gitee 端点。
 * 仓库 WIKI 是这条纪律的**唯一例外**，理由是可验证的事实，不是偏好：
 *
 * 实测（2026-09-15）穷举了两侧：
 *   - `api.gitee.com/enterprises/{eid}/projects/{id}/{wikis,wiki,wiki_trees,docs,…}`
 *     —— 全部 404；
 *   - `gitee.com/api/v5/repos/{owner}/{repo}/wikis` —— **405 Not Allowed**
 *     （网关层面就没有这个路由）；
 *   - `doc_nodes` 只有**企业级**与**项目（program）级**两个维度，传仓库 id 返回 0；
 *     且全企业 `is_wiki=true` 的节点为 0 篇。
 *
 * 而仓库 WIKI 确实存在（`/projects` 的 `wiki_enabled_with_content` 有 6 个为 true），
 * 它的**唯一形态是 git 仓库**：
 *
 *     https://gitee.com/{path_with_namespace}.wiki.git   →  一棵 .md 文件树
 *
 * 所以这一段是"补 MCP 补不了的那一格"，不是"重写 MCP 已有的能力"。
 * 集中在这一个文件里，就是为了将来若要把它挪进 fork（做成 MCP 工具），
 * 替换面只有这一个模块。
 *
 * ## 两个实测坑（别踩回去）
 *
 * 1. **必须用 `path_with_namespace`，不能用 `name`**：同一个仓库两者经常不同
 *    （`name=demo-docs` / `path=docs`；`name=demo-server` / `path=demoserver`），
 *    用 name 拼会 404。
 * 2. **token 不进命令行**：`https://oauth2:TOKEN@…` 会出现在 `ps` 里。
 *    这里用 `credential.helper` 从**环境变量**读密码，argv 里只有仓库地址。
 *
 * @module dsh-gitee-chat/host/wiki-cache
 */
/**
 * 工作区里放软链接的目录名。
 *
 * 用 `.dsh/`：这是 DSH 自己的"每工作区状态"约定目录，不会被当成项目源码；
 * 且我们只往里放**一个软链接**，不写任何实体文件。
 */
export declare const WORKSPACE_LINK_DIR = ".dsh";
/** 软链接名（`<cwd>/.dsh/gitee-docs` → 缓存根）。 */
export declare const WORKSPACE_LINK_NAME = "gitee-docs";
/** 单页正文读取上限（字符）。 */
export declare const DEFAULT_MAX_PAGE_CHARS = 200000;
/** wiki 缓存的依赖。 */
export interface WikiCacheDeps {
    /** 缓存根（与附件同一个根：`$DSH_HOME/gitee/docs`）。 */
    readonly cacheRoot: string;
    /**
     * 取 Gitee 访问令牌（**必须每次现取**，不要缓存到闭包里：
     * 令牌轮换后闭包会一直用旧的）。
     */
    readonly token: () => string;
    /** git 可执行文件（默认 `git`，走 PATH）。 */
    readonly git?: string;
    /** 单次 git 超时。 */
    readonly timeoutMs?: number;
    /** 诊断日志（只记命令名与结果，**绝不记 token**）。 */
    readonly log?: (message: string) => void;
}
/** 一次取数的结果。 */
export interface WikiFetchResult {
    /** 本地克隆目录。 */
    dir: string;
    /** 本次是否真的跑了 git（false = 复用已有克隆）。 */
    fetched: boolean;
    /** HEAD commit（空仓为空串）。 */
    head: string;
    /** 取不回来时的一句话说明（此时 head 为空、pages 为空）。 */
    notice?: string;
}
/** WIKI 里的一页（一个文件）。 */
export interface WikiFile {
    path: string;
    name: string;
    title: string;
    bytes: number;
    updatedAt: string;
}
/**
 * 把仓库路径段转成一个安全的目录名。
 * `example-org/docs` → `example-org__docs`（`/` 不能进单个目录名）。
 */
export declare function safeRepoSegment(pathWithNamespace: string): string;
/**
 * 计算一条绝对缓存路径在**会话工作区里可见**的路径。
 *
 * 侧边栏的文件围栏（`workspaceFence`）按**会话 cwd 的 realpath** 判定，
 * 而缓存根在工作区之外 —— 所以必须经由 `<cwd>/.dsh/gitee-docs` 这条软链接
 * 才能让侧边栏读到。
 *
 * @param link - `<cwd>/.dsh/gitee-docs`（软链接绝对路径）。
 * @param cacheRoot - 缓存根绝对路径。
 * @param absolute - 缓存里某个文件的绝对路径。
 * @returns 工作区里可用的绝对路径；`absolute` 不在 `cacheRoot` 下时返回 null。
 */
export declare function toWorkspacePath(link: string, cacheRoot: string, absolute: string): string | null;
/**
 * 创建 WIKI / 附件的取数与缓存。
 * @param deps - 缓存根、令牌来源、git 位置。
 */
export declare function createWikiCache(deps: WikiCacheDeps): {
    cacheRoot: string;
    /** 仓库的本地克隆目录。 */
    dirOf: (repo: {
        pathWithNamespace: string;
        repoId: number;
    }) => string;
    /** 克隆地址（诊断用；**不含 token**）。 */
    cloneUrl: (repo: {
        pathWithNamespace: string;
    }) => string;
    ensure: (repo: {
        repoId: number;
        name: string;
        pathWithNamespace: string;
    }, refresh?: boolean) => Promise<WikiFetchResult>;
    files: (dir: string) => WikiFile[];
    read: (dir: string, relPath: string, maxChars?: number) => {
        content: string;
        truncated: boolean;
        bytes: number;
        title: string;
        name: string;
    } | undefined;
    workspaceLink: (cwd: string) => Promise<string | null>;
};
export type WikiCache = ReturnType<typeof createWikiCache>;
