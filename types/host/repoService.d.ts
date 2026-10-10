/**
 * 仓库与**仓库 WIKI** 的编排层（host 平面）。
 *
 * 分工与 `docService` 完全一致：
 *   - 仓库**列表**来自 MCP（`list_enterprise_repositories`）—— 插件不拼端点；
 *   - WIKI **正文**来自 git（`./wikiCache`，理由见该文件的注释）；
 *   - 这里只做：选口径、算目录、控刷新、把结果裁剪成界面形状。
 *
 * ## 两个口径（需求原话）
 *
 *   - **点了项目** → 只列**该项目下的**仓库（`program_id` 过滤）；
 *   - **没点项目** → 只列**企业内部开源**的仓库（`scope=internal-open`）。
 *
 * 两条都实测有效（2026-09-15）：9500001 → 4 个；9500002 → 2 个；internal-open → 2 个。
 *
 * @module dsh-gitee-chat/host/repo-service
 */
import { type WikiCache } from './wikiCache.ts';
import type { McpDocs } from './mcpDocs.ts';
import type { RepoListResponse, WikiPageResponse, WikiTreeResponse } from '../types.ts';
/** 编排层依赖。 */
export interface RepoServiceDeps {
    readonly docs: McpDocs;
    readonly wiki: WikiCache;
    /**
     * 按会话取工作目录（会话不在内存里 / 读不到时返回空串）。
     *
     * 存在的唯一理由：侧边栏的文件围栏按会话 cwd 判定，而缓存根在工作区之外，
     * 需要一条 `<cwd>/.dsh/gitee-docs` 软链接才能把缓存里的文件交给侧边栏。
     */
    readonly cwdOf: (sessionId: string) => string;
}
/** 仓库定位（前端只能通过列表拿到，这里再做一次形状校验）。 */
export interface RepoRef {
    repoId: number;
    /** `path_with_namespace`，如 `example-org/docs`。 */
    repoPath: string;
    repoName: string;
    /** 列表当时的口径（WIKI 图标只在项目口径下需要重新拉）。 */
    programId: number | null;
}
/** 由 `public` 值推出中文可见性。 */
export declare function visibilityOf(publicValue: number): string;
/**
 * 创建仓库 / WIKI 编排服务。
 * @param deps - MCP 委派、WIKI 缓存、会话 cwd 解析。
 */
export declare function createRepoService(deps: RepoServiceDeps): {
    /**
     * 列仓库。
     * @param sessionId - 会话 id（MCP 作用域）。
     * @param programId - null = 不限定项目（走"企业内部开源"口径）。
     * @param programName - 项目名（界面提示用）。
     */
    repos(sessionId: string, programId: number | null, programName?: string): Promise<RepoListResponse>;
    /**
     * 取一个仓库的 WIKI 文件树（必要时克隆 / 刷新）。
     *
     * **按需**：只有真的点开某个仓库的 WIKI 才会去克隆 —— 列表阶段不碰 git。
     *
     * @param sessionId - 会话 id。
     * @param ref - 仓库定位。
     * @param refresh - true = 强制 fetch 远端。
     */
    wiki(sessionId: string, ref: RepoRef, refresh?: boolean): Promise<WikiTreeResponse>;
    /**
     * 读 WIKI 里的一页。
     * @param sessionId - 会话 id。
     * @param ref - 仓库定位。
     * @param relPath - 相对 WIKI 根目录的路径。
     */
    wikiPage(sessionId: string, ref: RepoRef, relPath: string): Promise<WikiPageResponse>;
};
export type RepoService = ReturnType<typeof createRepoService>;
