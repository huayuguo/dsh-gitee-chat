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

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { McpDocs } from './mcpDocs.ts'
import type {
  DocAttachmentResponse,
  DocDetailResponse,
  DocListResponse,
  DocNodeRow,
  DocPageResponse,
  DocPageRow,
  DocPageStateView,
  DocRow,
  DocSearchResponse,
  DocSyncResponse,
  DocTreeResponse,
} from '../types.ts'
import {
  attachFileExists,
  classifyAttachState,
  cacheStats,
  classifyDocument,
  documentDir,
  enterpriseLayer,
  extOf,
  findDocument,
  nowStamp,
  planPull,
  readAttachManifest,
  readIndex,
  readLocalPage,
  readManifest,
  readTextFile,
  rememberDocument,
  removeDocument,
  rollupDocState,
  scopeDir,
  sha256Hex,
  TEXT_PREVIEW_EXT,
  writeAttachManifest,
  writeLocalPage,
  writeManifest,
  type AttachManifest,
  type AttachState,
  type DocManifest,
  type DocsIndex,
} from './docCache.ts'

/** 编排层依赖。 */
export interface DocServiceDeps {
  readonly docs: McpDocs
  /** 缓存根（默认 `$DSH_HOME/gitee/docs`）。 */
  readonly cacheRoot: string
  /** 单页正文落盘上限（字符）。 */
  readonly maxPageChars?: number
  /**
   * 读取**附件内容**的实现（可选）。
   *
   * 本企业知识库的真实内容是 `AttachFile`（上传的 .md/.docx/.pdf…），
   * 读它需要 MCP 侧的下载工具。**这个依赖在不在，就是"内容可读"的开关** ——
   * 不在时界面会**明确标注"只能看结构与文件名"**，而不是给一个点了没反应的入口。
   */
  readonly readAttachmentContent?: (input: {
    sessionId: string
    nodeId: number
    fileName: string
    /** 附件内容 id（`list_doc_nodes` 的 `file_id`），**不是**节点 id。 */
    fileId: number
    programId: number | null
    /** 该节点应落的缓存目录（由编排层算好）。 */
    cacheDir: string
  }) => Promise<{
    savedPath: string
    bytes: number
    contentType: string
    ext: string
    /** 文本类返回正文；二进制类返回 null（不假装能预览）。 */
    content: string | null
    truncated: boolean
  }>
  /**
   * 按会话取工作目录（读不到返回空串）。
   *
   * 存在的唯一理由：侧边栏的文件围栏按**会话 cwd**判定，而缓存根在工作区之外。
   * 把 `<cwd>/.dsh/gitee-docs` 这条软链接交给侧边栏，它才读得到缓存里的文件。
   */
  readonly cwdOf?: (sessionId: string) => string
  /** 工作区软链接路径解析（在缓存根与工作区之间换算）。 */
  readonly workspaceLink?: (cwd: string) => Promise<string | null>
  /** 缓存根 → 工作区可见路径的换算（纯函数）。 */
  readonly toWorkspacePath?: (link: string, absolute: string) => string | null
}

/** 文档整体状态 → 界面用的词。 */
const STATE_LABEL: Record<DocPageStateView, string> = {
  'not-cached': '未缓存',
  missing: '本地缺失',
  synced: '已同步',
  'remote-ahead': '远程已更新',
  'local-dirty': '本地已改',
  conflict: '冲突',
}

/**
 * 创建文档编排服务。
 * @param deps - 委派客户端、缓存根、上限。
 */
export function createDocService(deps: DocServiceDeps) {
  const { docs, cacheRoot } = deps
  const maxPageChars = deps.maxPageChars ?? 200_000
  /**
   * 当前生效的企业 id —— **每次用到时现取**，不在装配时快照。
   *
   * 这里曾经写成 `const enterpriseId = docs.enterpriseId`（装配期取一次）。两个问题：
   * 一是那个值默认就是"钉住值 0"（MCP 侧的 401 与它同源，见 host/enterpriseId.ts）；
   * 二是设置页切了企业它也不会变 —— 缓存分层会继续按旧企业分家。
   * 现取的成本只是读一个三行 JSON。
   */
  const enterpriseId = (): number => docs.resolveEnterpriseId()

  /**
   * 把一条缓存路径换算成**会话工作区里可见**的路径。
   *
   * 为什么需要：侧边栏（`dsh-better-sidebar`）的文件围栏按**会话 cwd 的 realpath**
   * 判定，而缓存根在会话工作区之外 —— 直接把缓存路径交给它会被 403 拒绝。
   * 插件在 `<cwd>/.dsh/gitee-docs` 建一条指向缓存根的软链接，这里返回软链接下的路径。
   *
   * 任何一环缺失（没有 cwd、没有软链接能力）都返回 null，界面据此回落成
   * "只给绝对路径"，而不是给一个点了必然失败的错误路径。
   * @param sessionId - 会话 id。
   * @param absolute - 缓存里的绝对路径。
   */
  async function workspacePathOf(sessionId: string, absolute: string): Promise<string | null> {
    if (deps.cwdOf === undefined || deps.workspaceLink === undefined || deps.toWorkspacePath === undefined) return null
    const cwd = deps.cwdOf(sessionId)
    if (cwd === '') return null
    const link = await deps.workspaceLink(cwd)
    if (link === null) return null
    return deps.toWorkspacePath(link, absolute)
  }

  /** 当前索引快照（每次即时读，避免缓存与磁盘不一致）。 */
  function index(): DocsIndex {
    return readIndex(cacheRoot)
  }

  /**
   * 一个文档的缓存目录。
   * @param input - 文档定位信息。
   */
  function dirOf(input: { documentId: number; programId: number | null; name: string }): string {
    const idx = index()
    return documentDir({
      cacheRoot,
      enterpriseLayerPath: enterpriseLayer(cacheRoot, enterpriseId(), idx),
      programId: input.programId,
      documentId: input.documentId,
      name: input.name,
    })
  }

  /** 用索引里记的定位信息取目录（没缓存过返回 undefined）。 */
  function cachedDirOf(documentId: number): string | undefined {
    const found = findDocument(cacheRoot, documentId)
    if (found === undefined) return undefined
    return dirOf({ documentId, programId: found.programId, name: found.name })
  }

  /** 记下定位信息并返回目录（用于首次落盘）。 */
  function ensureDir(input: { documentId: number; programId: number | null; name: string }): string {
    rememberDocument(cacheRoot, input.documentId, {
      enterpriseId: enterpriseId(),
      programId: input.programId,
      name: input.name,
    })
    return dirOf(input)
  }

  /**
   * 一个节点**当前**的本地缓存状态（只读本地，不发任何请求）。
   *
   * 列表要给每个节点标"已缓存 / 远端已更新"，所以它必须足够便宜：
   * 一次 `readJson` + 一次 `existsSync`，不碰网络、不算哈希。
   *
   * ⚠️ `enterpriseLayerPath` 由调用方**算一次传进来**：`dirOf` 内部会读根索引，
   * 逐节点调它等于对着一棵 100 个节点的树做 100 次文件读取 —— 纯浪费。
   * @param node - MCP 给的节点事实。
   * @param pid - 该节点归属的项目（已兜底）。
   * @param layer - 已算好的企业层路径。
   */
  function stateOfLocal(
    node: { nodeId: number; name: string; updatedAt: string; size: number },
    pid: number | null,
    layer: string,
  ): AttachState {
    const name = node.name !== '' ? node.name : `node-${node.nodeId}`
    const dir = documentDir({ cacheRoot, enterpriseLayerPath: layer, programId: pid, documentId: node.nodeId, name })
    const manifest = readAttachManifest(dir)
    return classifyAttachState(manifest, manifest === undefined ? false : attachFileExists(dir, manifest), {
      updatedAt: node.updatedAt,
      size: node.size,
    })
  }

  /**
   * 从本地缓存读一个附件（**不调 MCP**）。读不出来返回 undefined，让调用方回落到下载。
   *
   * 落盘文件名按清单里记的那个找 —— 不用节点当前的名字：节点改名后新的文件名
   * 在本地并不存在，照它找会得到"本地缺失"的假象，然后白白重下一份。
   * @param sessionId - 会话 id。
   * @param dir - 附件缓存目录。
   * @param manifest - 本地清单。
   * @param state - 已判定的状态（`synced` / `remote-ahead`）。
   */
  async function readCachedAttachment(
    sessionId: string,
    dir: string,
    manifest: AttachManifest,
    state: AttachState,
  ): Promise<DocAttachmentResponse | undefined> {
    const savedPath = join(dir, manifest.fileName)
    try {
      if (!existsSync(savedPath)) return undefined
      const bytes = statSync(savedPath).size
      const ext = extOf(manifest.fileName)
      const text = TEXT_PREVIEW_EXT.has(ext) ? readTextFile(savedPath, maxPageChars) : undefined
      const workspacePath = await workspacePathOf(sessionId, savedPath)
      return {
        ok: true,
        nodeId: manifest.nodeId,
        fileId: manifest.fileId,
        name: manifest.name,
        savedPath,
        bytes,
        // 命中缓存时不去问 Content-Type（那要发请求）—— 按扩展名给一个够用的值。
        contentType: text === undefined ? 'application/octet-stream' : 'text/plain; charset=utf-8',
        ext,
        content: text === undefined ? null : text.content,
        truncated: text?.truncated ?? false,
        previewable: text !== undefined,
        cacheDir: dir,
        state,
        fromCache: true,
        generatedAt: nowStamp(),
      }
    } catch {
      return undefined
    }
  }

  // 注意：`sync` 需要调用 `detail`。这里先命名对象再返回，是为了让内部调用
  // 走 `service.detail(...)` 而不是 `this.detail(...)` —— 后者在调用方把方法
  // 解构出来用（`const { sync } = service`）时会丢 `this` 而炸。
  const service = {
    /** 缓存根（诊断/界面展示用）。 */
    cacheRoot,

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
    async attachment(sessionId: string, input: {
      nodeId: number
      fileId: number
      name: string
      programId: number | null
      /** 当前节点上的 `updated_at`（用于判定远端有没有变；可缺）。 */
      updatedAt?: string
      /** 当前节点上的 `attach_file.size`（0 = 未知）。 */
      size?: number
      /** 忽略本地缓存，强制重下。 */
      refresh?: boolean
    }): Promise<DocAttachmentResponse> {
      const reader = deps.readAttachmentContent
      if (reader === undefined) {
        throw new Error('本部署还没有附件读取能力（MCP 未提供 download_attach_file）。')
      }
      const found = findDocument(cacheRoot, input.nodeId)
      const programId = found?.programId ?? input.programId
      const name = input.name !== '' ? input.name : `node-${input.nodeId}`
      const dir = dirOf({ documentId: input.nodeId, programId, name })
      const remote = { updatedAt: input.updatedAt ?? '', size: input.size ?? 0 }

      // ── 先看本地：能命中就不调 MCP ─────────────────────────────────────
      const manifest = readAttachManifest(dir)
      const cachedState = manifest === undefined
        ? 'not-cached' as const
        : classifyAttachState(manifest, attachFileExists(dir, manifest), remote)

      if (input.refresh !== true && manifest !== undefined && (cachedState === 'synced' || cachedState === 'remote-ahead')) {
        const cached = await readCachedAttachment(sessionId, dir, manifest, cachedState)
        if (cached !== undefined) return cached
        // 读不出来（比如落盘文件损坏）→ 落到下面重新下载，而不是报错。
      }

      // 🔴 **必须先建目录**，否则 MCP 侧会直接拒绝。
      //
      // `ResolveWritableDirectory`（utils/file_access.go）对 output_directory 做的是
      // `EvalSymlinks` + `Stat`：**目录不存在就报**
      // "cannot resolve …: lstat /home/…/.dsh/gitee: no such file or directory"。
      // `workspace` 参数同理（它也要存在）。
      // 缓存根是我们自己管的目录，建它是我们的责任 ——
      // 不能指望调用方每次都保证路径已存在。
      mkdirSync(dir, { recursive: true })
      const result = await reader({
        sessionId,
        nodeId: input.nodeId,
        fileName: name,
        fileId: input.fileId,
        programId,
        cacheDir: dir,
      })
      // 记下"下载那一刻的远端事实" —— 下次就是靠它判"远端有没有变"。
      writeAttachManifest(dir, {
        schema: 1,
        enterpriseId: enterpriseId(),
        nodeId: input.nodeId,
        fileId: input.fileId,
        name,
        updatedAt: remote.updatedAt,
        size: remote.size,
        bytes: result.bytes,
        fileName: result.savedPath.startsWith(dir) ? result.savedPath.slice(dir.length + 1) : basename(result.savedPath),
        fetchedAt: nowStamp(),
      })
      // 工作区可见路径：侧边栏的文件围栏按会话 cwd 判定，缓存根在工作区之外，
      // 所以要把软链接下的路径一并带出去（拿不到 cwd 时为 null，界面回落）。
      const workspacePath = await workspacePathOf(sessionId, result.savedPath)
      return {
        ok: true,
        nodeId: input.nodeId,
        fileId: input.fileId,
        name,
        savedPath: result.savedPath,
        bytes: result.bytes,
        contentType: result.contentType,
        ext: result.ext,
        content: result.content,
        truncated: result.truncated,
        previewable: result.content !== null,
        cacheDir: dir,
        state: 'synced',
        fromCache: false,
        workspacePath,
        generatedAt: nowStamp(),
      }
    },
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
    async listNodes(sessionId: string, programId: number | null, parentId = 0): Promise<DocTreeResponse> {
      const nodes = await docs.listNodes(sessionId, {
        parentId,
        ...(programId === null || programId <= 0 ? {} : { programId }),
      })
      const contentReadable = deps.readAttachmentContent !== undefined
      // 企业层路径**只算一次**（每算一次都要读根索引），逐节点复用。
      const layer = enterpriseLayer(cacheRoot, enterpriseId(), index())
      const rows: DocNodeRow[] = nodes.map((node) => {
        const directory = node.fileType === 'DocDirectory'
        const readable = directory || contentReadable
        const pid = node.programId ?? programId
        return {
          nodeId: node.nodeId,
          parentId: node.parentId,
          name: node.name,
          fileType: node.fileType,
          fileId: node.fileId,
          filePath: node.filePath,
          size: node.size,
          // 缓存状态在这里**本地算**（读一个 JSON + 一次 stat），不额外调 MCP ——
          // 于是列表上就能显示"已缓存 / 远端已更新"，而不是点开才知道。
          state: directory ? 'not-cached' as const : stateOfLocal(node, pid, layer),
          programId: pid,
          createdAt: node.createdAt,
          updatedAt: node.updatedAt,
          ext: node.ext,
          directory,
          readable,
          ...(readable ? {} : {
            unreadableReason: '内容读取需要 MCP 的 download_attach_file 工具（尚未随包提供）：当前只能看到结构与文件名。',
          }),
        }
      })
      return {
        ok: true,
        enterpriseId: enterpriseId(),
        roots: [{ programId, programName: '', nodes: rows }],
        total: rows.length,
        cacheRoot,
        generatedAt: nowStamp(),
        contentReadable,
        ...(contentReadable ? {} : {
          notice: '本企业知识库是「文件夹 + 上传附件」的形态（DocDirectory / AttachFile），没有 WikiInfo 文档。'
            + '当前插件只能列出结构与文件名；附件内容需要 MCP 增加一个读取工具后才会开放。',
        }),
      }
    },

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
    async list(sessionId: string, scope: 'common' | 'program', programId?: number): Promise<DocListResponse> {
      const wanted = scope === 'program' && programId !== undefined ? programId : undefined
      const result = await docs.listDocuments(sessionId, wanted === undefined ? {} : { programId: wanted })

      const rows: DocRow[] = result.documents.map((doc) => {
        const found = findDocument(cacheRoot, doc.documentId)
        const dir = found === undefined ? undefined : cachedDirOf(doc.documentId)
        const manifest = dir === undefined ? undefined : readManifest(dir)
        return {
          documentId: doc.documentId,
          documentNodeId: doc.documentNodeId,
          name: doc.name,
          filePath: doc.filePath,
          programId: doc.programId,
          programName: doc.programName,
          updatedAt: doc.updatedAt,
          // 列表上的状态取"上次核对"的结论，不为每篇文档多跑一次 MCP 调用。
          state: manifest?.lastState ?? 'not-cached',
          cached: manifest !== undefined,
        }
      })

      return {
        ok: true,
        enterpriseId: enterpriseId(),
        scope: wanted === undefined ? 'common' : 'program',
        programId: wanted ?? null,
        total: result.total,
        documents: rows,
        cacheRoot,
        generatedAt: nowStamp(),
      }
    },

    /**
     * 企业级关键词搜索。
     *
     * ⚠️ **不能按项目过滤** —— MCP 的 `search` 与 `program_id` 互斥。
     * 响应里带 `enterpriseWide: true`，界面据此明确提示。
     *
     * @param sessionId - 会话 id。
     * @param query - 关键词。
     */
    async search(sessionId: string, query: string): Promise<DocSearchResponse> {
      const hits = await docs.searchDocuments(sessionId, query)
      return { ok: true, query, enterpriseWide: true, hits, generatedAt: nowStamp() }
    },

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
    async detail(sessionId: string, documentId: number, hint?: { programId: number | null; name: string }): Promise<DocDetailResponse> {
      const pages = await docs.listPages(sessionId, documentId)
      const found = findDocument(cacheRoot, documentId)
      const programId = found?.programId ?? hint?.programId ?? null
      const name = found?.name ?? hint?.name ?? `document-${documentId}`
      const dir = found === undefined && hint === undefined ? undefined : cachedDirOf(documentId) ?? dirOf({ documentId, programId, name })
      const manifest = dir === undefined ? undefined : readManifest(dir)

      const classified = classifyDocument(
        pages.map((p) => ({ pageId: p.pageId, name: p.name, type: p.type, version: p.version })),
        manifest,
        dir ?? '',
      )
      // 页树要带上 MCP 给的其余字段（时间/类型），按 pageId 合并回去。
      const byId = new Map(pages.map((p) => [p.pageId, p]))
      const rows: DocPageRow[] = classified.map((c) => {
        const meta = byId.get(c.pageId)
        return {
          pageId: c.pageId,
          parentPageId: meta?.parentPageId ?? 0,
          name: c.name,
          type: c.type,
          version: c.version,
          lastEditTime: meta?.lastEditTime ?? '',
          contentType: meta?.contentType ?? '',
          state: c.state,
          path: c.relPath,
        }
      })

      const state = rollupDocState(rows.map((r) => r.state))
      const pending = planPull(rows.map((r) => ({ pageId: r.pageId, state: r.state })))

      // 核对时间写回清单（只有真缓存过才写；不缓存就不建目录）。
      if (dir !== undefined && manifest !== undefined) {
        writeManifest(dir, { ...manifest, checkedAt: nowStamp(), lastState: state })
      }

      return {
        ok: true,
        documentId,
        documentNodeId: 0,
        name,
        programId,
        localDir: dir ?? '',
        cached: manifest !== undefined,
        checkedAt: manifest?.checkedAt ?? '',
        state,
        pages: rows,
        pending,
        generatedAt: nowStamp(),
      }
    },

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
    async page(
      sessionId: string,
      documentId: number,
      pageId: number,
      hint?: { programId: number | null; name: string },
    ): Promise<DocPageResponse> {
      const pages = await docs.listPages(sessionId, documentId)
      const meta = pages.find((p) => p.pageId === pageId)
      if (meta === undefined) {
        throw new Error(`文档 ${documentId} 里没有 page_id=${pageId}（可能已被移动或删除）`)
      }
      const found = findDocument(cacheRoot, documentId)
      const programId = found?.programId ?? hint?.programId ?? null
      const name = found?.name ?? hint?.name ?? `document-${documentId}`
      const dir = cachedDirOf(documentId) ?? dirOf({ documentId, programId, name })
      const manifest = readManifest(dir)

      const [classified] = classifyDocument(
        [{ pageId: meta.pageId, name: meta.name, type: meta.type, version: meta.version }],
        manifest,
        dir,
      )
      const state = classified?.state ?? 'not-cached'
      const relPath = classified?.relPath ?? `${meta.name}.md`

      const useLocal = state === 'synced' || state === 'local-dirty' || state === 'conflict'
      if (useLocal) {
        const local = readLocalPage(dir, relPath)
        if (local !== undefined) {
          const truncated = local.length > maxPageChars
          return {
            ok: true,
            documentId,
            pageId,
            name: meta.name,
            version: state === 'synced' ? meta.version : (manifest?.pages[String(pageId)]?.version ?? meta.version),
            lastEditTime: meta.lastEditTime,
            contentType: meta.contentType,
            content: truncated ? local.slice(0, maxPageChars) : local,
            truncated,
            source: 'local',
            state,
          }
        }
      }

      // 需要（或只能）从 MCP 取。
      const remote = await docs.getPage(sessionId, documentId, pageId, undefined, maxPageChars)
      const content = remote.content
      ensureDir({ documentId, programId, name })
      writeLocalPage(dir, relPath, content)
      const next: DocManifest = {
        schema: 1,
        enterpriseId: enterpriseId(),
        programId,
        documentId,
        documentNodeId: 0,
        name,
        documentUpdatedAt: '',
        checkedAt: nowStamp(),
        lastState: 'synced',
        pages: { ...(manifest?.pages ?? {}) },
      }
      next.pages[String(pageId)] = {
        name: meta.name,
        path: relPath,
        version: remote.version,
        lastEditTime: remote.lastEditTime,
        contentType: remote.contentType,
        sha256: sha256Hex(content),
        bytes: remote.bytes,
        fetchedAt: nowStamp(),
      }
      writeManifest(dir, next)

      return {
        ok: true,
        documentId,
        pageId,
        name: meta.name,
        version: remote.version,
        lastEditTime: remote.lastEditTime,
        contentType: remote.contentType,
        content,
        truncated: remote.truncated,
        source: 'remote',
        state: 'synced',
      }
    },

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
    async sync(
      sessionId: string,
      documentId: number,
      mode: 'check' | 'pull',
      hint?: { programId: number | null; name: string },
    ): Promise<DocSyncResponse> {
      const detail = await service.detail(sessionId, documentId, hint)
      const dir = detail.localDir
      const manifest = dir === '' ? undefined : readManifest(dir)
      const found = findDocument(cacheRoot, documentId)
      const programId = found?.programId ?? hint?.programId ?? null
      const name = found?.name ?? hint?.name ?? `document-${documentId}`

      const pending = detail.pending
      const skippedDirty = detail.pages.filter((p) => p.state === 'local-dirty' || p.state === 'conflict').map((p) => p.pageId)

      if (mode === 'check' || pending.length === 0) {
        return {
          ok: true, documentId, mode, state: detail.state,
          pending, pulled: [], skippedDirty,
          checkedAt: detail.checkedAt, generatedAt: nowStamp(),
        }
      }

      // pull：逐页取，逐页落盘（失败不整批回滚 —— 已拉的留着，报出失败项）。
      //
      // 注意：落盘目录在 ensureDir **之后**重算。detail 在"既没缓存、调用方也没给
      // 定位提示"时会返回 localDir=''，拿空串去 join 会把文件写到进程 cwd 下 ——
      // 那是最难查的一类 bug，所以这里必须重取。
      ensureDir({ documentId, programId, name })
      const targetDir = cachedDirOf(documentId) ?? dir
      const next: DocManifest = {
        schema: 1,
        enterpriseId: enterpriseId(),
        programId,
        documentId,
        documentNodeId: 0,
        name,
        documentUpdatedAt: '',
        checkedAt: nowStamp(),
        lastState: detail.state,
        pages: { ...(manifest?.pages ?? {}) },
      }
      const pulled: number[] = []
      const failed: number[] = []
      for (const pageId of pending) {
        const row = detail.pages.find((p) => p.pageId === pageId)
        if (row === undefined) continue
        try {
          const remote = await docs.getPage(sessionId, documentId, pageId, undefined, maxPageChars)
          writeLocalPage(targetDir, row.path, remote.content)
          next.pages[String(pageId)] = {
            name: row.name,
            path: row.path,
            version: remote.version,
            lastEditTime: remote.lastEditTime,
            contentType: remote.contentType,
            sha256: sha256Hex(remote.content),
            bytes: remote.bytes,
            fetchedAt: nowStamp(),
          }
          pulled.push(pageId)
        } catch {
          failed.push(pageId)
        }
      }

      // 拉完再算一次整体状态（只根据清单能算的那部分）。
      const states = detail.pages.map((p) => {
        if (pulled.includes(p.pageId)) return 'synced' as const
        return p.state
      })
      const state = rollupDocState(states)
      writeManifest(targetDir, { ...next, lastState: state })

      return {
        ok: true,
        documentId,
        mode,
        state,
        pending,
        pulled,
        skippedDirty,
        checkedAt: next.checkedAt,
        generatedAt: nowStamp(),
      }
    },

    /**
     * 清掉**一个附件/文档节点**的本地缓存（界面上的「清缓存」）。
     *
     * 语义是安全的：缓存本来就是"读过才在"的副本，删掉只是让下一次点击重新下载，
     * 不会动 Gitee 上任何东西 —— 所以这里**不需要二次确认**。
     *
     * @param input - 节点 id、名字、归属项目（用它算缓存目录）。
     */
    forgetAttachment(input: { nodeId: number; name: string; programId: number | null }): { removed: boolean; dir: string } {
      const found = findDocument(cacheRoot, input.nodeId)
      const programId = found?.programId ?? input.programId
      const name = input.name !== '' ? input.name : `node-${input.nodeId}`
      const dir = dirOf({ documentId: input.nodeId, programId, name })
      // 目录不在就是"本来没缓存"，不是错误 —— 界面据此把徽标刷回"未缓存"即可。
      if (!existsSync(dir)) return { removed: false, dir }
      removeDocument(dir)
      return { removed: true, dir }
    },

    /**
     * 清掉**一个项目（或企业级公共）**的全部附件缓存。
     *
     * 走的是 `scopePath`（`pj-<id>/` 或 `_common/`）—— 整个目录一次删掉，
     * 而不是逐条点名。**不碰 `wiki/`**：仓库 WIKI 是 git 克隆、另一套语义，
     * 要清它有单独的入口。
     *
     * @param programId - null = 企业级公共。
     */
    forgetScope(programId: number | null): { removed: boolean; dir: string } {
      const dir = service.scopePath(programId)
      if (!existsSync(dir)) return { removed: false, dir }
      removeDocument(dir)
      return { removed: true, dir }
    },

    /** 某个项目/公共文档集合的本地目录（界面显示与批量清理都用它）。 */
    scopePath(programId: number | null): string {
      const idx = index()
      return scopeDir(cacheRoot, enterpriseLayer(cacheRoot, enterpriseId(), idx), programId)
    },

    /**
     * 缓存用量（A2 的"看"那一半）：附件与仓库 WIKI 分开报。
     *
     * 分开是有理由的：附件是"读过的副本"，WIKI 是**整个 git 克隆**（通常大得多）。
     * 合成一个数字会让人以为清附件就能腾出空间。
     */
    cacheInfo(): { cacheRoot: string; attachments: { count: number; bytes: number }; wikis: { count: number; bytes: number }; truncated: boolean } {
      const stats = cacheStats(cacheRoot)
      return { cacheRoot, ...stats }
    },

    /** 状态名（界面文案，集中一处避免各处自己写）。 */
    label(state: DocPageStateView): string {
      return STATE_LABEL[state]
    },

    /** 供 /ping 诊断：本地缓存根与已缓存文档数。 */
    snapshot(): { cacheRoot: string; documents: number; enterpriseId: number } {
      const idx = index()
      return { cacheRoot, documents: Object.keys(idx.documents ?? {}).length, enterpriseId: enterpriseId() }
    },
  }
  return service
}

/** 编排服务类型。 */
export type DocService = ReturnType<typeof createDocService>

/** 默认缓存根：`$DSH_HOME/gitee/docs`（需求指定，不带点）。 */
export function defaultDocsRoot(dshHome: string): string {
  return join(dshHome, 'gitee', 'docs')
}
