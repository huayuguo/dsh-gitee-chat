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

import { toWorkspacePath, type WikiCache } from './wikiCache.ts'
import { nowStamp } from './docCache.ts'
import type { McpDocs } from './mcpDocs.ts'
import type { RepoListResponse, RepoRow, WikiPageResponse, WikiTreeResponse } from '../types.ts'

/** 编排层依赖。 */
export interface RepoServiceDeps {
  readonly docs: McpDocs
  readonly wiki: WikiCache
  /**
   * 按会话取工作目录（会话不在内存里 / 读不到时返回空串）。
   *
   * 存在的唯一理由：侧边栏的文件围栏按会话 cwd 判定，而缓存根在工作区之外，
   * 需要一条 `<cwd>/.dsh/gitee-docs` 软链接才能把缓存里的文件交给侧边栏。
   */
  readonly cwdOf: (sessionId: string) => string
}

/** 仓库定位（前端只能通过列表拿到，这里再做一次形状校验）。 */
export interface RepoRef {
  repoId: number
  /** `path_with_namespace`，如 `example-org/docs`。 */
  repoPath: string
  repoName: string
  /** 列表当时的口径（WIKI 图标只在项目口径下需要重新拉）。 */
  programId: number | null
}

/**
 * 校验 `path_with_namespace` 的形状。
 *
 * 为什么要校验：这个字符串会被拼进**克隆地址**与**本地目录名**。
 * 只允许 `owner/repo` 两段、字符集收紧，`..` 与多余斜杠直接拒绝 ——
 * 浏览器传来的任何字符串都不能影响落盘位置。
 */
function validRepoPath(value: string): boolean {
  return /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(value)
}

/** 由 `public` 值推出中文可见性。 */
export function visibilityOf(publicValue: number): string {
  if (publicValue === 2) return '企业内部开源'
  if (publicValue === 1) return '公开'
  return '私有'
}

/**
 * 创建仓库 / WIKI 编排服务。
 * @param deps - MCP 委派、WIKI 缓存、会话 cwd 解析。
 */
export function createRepoService(deps: RepoServiceDeps) {
  const { docs, wiki } = deps

  /** 裁剪一个 MCP 仓库成界面形状（补上可见性与 WIKI 标记）。 */
  function toRow(repo: Awaited<ReturnType<McpDocs['listRepositories']>>[number]): RepoRow {
    return {
      repoId: repo.repoId,
      name: repo.name,
      path: repo.path,
      pathWithNamespace: repo.pathWithNamespace,
      description: repo.description,
      public: repo.public,
      visibility: visibilityOf(repo.public),
      defaultBranch: repo.defaultBranch,
      membersCount: repo.membersCount,
      lastPushAt: repo.lastPushAt,
      repoSize: repo.repoSize,
      outsourced: repo.outsourced,
      statusName: repo.statusName,
      wiki: repo.wiki,
    }
  }

  return {
    /**
     * 列仓库。
     * @param sessionId - 会话 id（MCP 作用域）。
     * @param programId - null = 不限定项目（走"企业内部开源"口径）。
     * @param programName - 项目名（界面提示用）。
     */
    async repos(sessionId: string, programId: number | null, programName = ''): Promise<RepoListResponse> {
      const scoped = programId !== null && programId > 0
      const list = await docs.listRepositories(sessionId, scoped ? { programId } : { scope: 'internal-open' })
      return {
        ok: true,
        // 现取（本地配置文件 / 环境变量 / 唯一企业自动）—— 不在装配期快照，
        // 否则设置页切企业后这里会一直显示旧企业（见 host/enterpriseId.ts）。
        enterpriseId: docs.resolveEnterpriseId(),
        mode: scoped ? 'project' : 'internal-open',
        programId: scoped ? programId : null,
        programName,
        total: list.length,
        repos: list.map(toRow),
        generatedAt: nowStamp(),
        notice: scoped
          ? `只列项目「${programName || programId}」下的仓库（program_id 过滤）。`
          : '没有选中项目：只列**企业内部开源**的仓库（scope=internal-open）。选中左侧某个项目即可看它名下的全部仓库。',
      }
    },

    /**
     * 取一个仓库的 WIKI 文件树（必要时克隆 / 刷新）。
     *
     * **按需**：只有真的点开某个仓库的 WIKI 才会去克隆 —— 列表阶段不碰 git。
     *
     * @param sessionId - 会话 id。
     * @param ref - 仓库定位。
     * @param refresh - true = 强制 fetch 远端。
     */
    async wiki(sessionId: string, ref: RepoRef, refresh = false): Promise<WikiTreeResponse> {
      void sessionId
      if (!validRepoPath(ref.repoPath)) {
        throw new Error(`仓库路径不合法：${ref.repoPath || '（空）'}。应为 owner/repo 形式。`)
      }
      const result = await wiki.ensure({ repoId: ref.repoId, name: ref.repoName, pathWithNamespace: ref.repoPath }, refresh)
      const pages = result.notice === undefined ? wiki.files(result.dir) : []
      const link = await wiki.workspaceLink(deps.cwdOf(sessionId))
      return {
        ok: true,
        repoId: ref.repoId,
        repoName: ref.repoName,
        repoPath: ref.repoPath,
        head: result.head,
        localDir: result.dir,
        workspaceDir: link === null ? null : toWorkspacePath(link, wiki.cacheRoot, result.dir),
        pages,
        fetched: result.fetched,
        fetchedAt: nowStamp(),
        ...(result.notice === undefined ? {} : { notice: result.notice }),
      }
    },

    /**
     * 读 WIKI 里的一页。
     * @param sessionId - 会话 id。
     * @param ref - 仓库定位。
     * @param relPath - 相对 WIKI 根目录的路径。
     */
    async wikiPage(sessionId: string, ref: RepoRef, relPath: string): Promise<WikiPageResponse> {
      if (!validRepoPath(ref.repoPath)) {
        throw new Error(`仓库路径不合法：${ref.repoPath || '（空）'}。应为 owner/repo 形式。`)
      }
      if (relPath.trim() === '') throw new Error('缺少 path 参数。')
      const result = await wiki.ensure({ repoId: ref.repoId, name: ref.repoName, pathWithNamespace: ref.repoPath }, false)
      if (result.notice !== undefined && !result.head) {
        throw new Error(result.notice)
      }
      const page = wiki.read(result.dir, relPath)
      if (page === undefined) throw new Error(`WIKI 里没有这一页：${relPath}`)
      const link = await wiki.workspaceLink(deps.cwdOf(sessionId))
      const localPath = `${result.dir}/${relPath}`
      return {
        ok: true,
        repoId: ref.repoId,
        repoName: ref.repoName,
        path: relPath,
        name: page.name,
        title: page.title,
        content: page.content,
        truncated: page.truncated,
        bytes: page.bytes,
        localPath,
        workspacePath: link === null ? null : toWorkspacePath(link, wiki.cacheRoot, localPath),
      }
    },
  }
}

export type RepoService = ReturnType<typeof createRepoService>
