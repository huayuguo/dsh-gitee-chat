/**
 * 知识库文档的**按需缓存**与**页级版本核对**（host 平面）。
 *
 * 设计口径见 `DOCS.md` §3–§5。两条最容易搞错、所以在这里写死的事：
 *
 *   1. 缓存**不是镜像** —— 只有"读过的那几篇、那几页"在本地。
 *      全量拉取被明确否掉（浪费空间 + 同步不及时）。
 *   2. **变更的单位是「页」，不是「文档」** —— 所以版本清单是**页级**的，
 *      而文档级的 `updated_at` 只配当"粗筛"。
 *
 * 判定逻辑全部是**纯函数**（`classifyPageState` / `rollupDocState` / `planPull`），
 * 因此可以被冒烟测试逐条断言 —— 这是 `DESIGN.md` §13「能用规则算的就别让模型算」
 * 在本功能上的落点。
 *
 * @module dsh-gitee-chat/host/doc-cache
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 清单文件名（放在每个文档目录下）。 */
export const MANIFEST_NAME = '.gitee-doc.json'

/** 根索引文件名。 */
export const INDEX_NAME = '.index.json'

/** 一页在本地的状态。 */
export type DocPageState =
  /** 本地没有这一页（或整篇没缓存过）。 */
  | 'not-cached'
  /** 清单里有，但本地文件不见了。 */
  | 'missing'
  /** 本地与远程一致 —— 可以直接读。 */
  | 'synced'
  /** 远程更新了，本地还是旧的 —— 该拉。 */
  | 'remote-ahead'
  /** 本地改过、远程没动 —— 未推送的编辑，不能丢。 */
  | 'local-dirty'
  /** 两边都动了 —— 停下交人决策，绝不自动合并。 */
  | 'conflict'

/** 文档整体状态（页状态的汇总）。 */
export type DocState = DocPageState

/**
 * 单页四态判定 —— **本模块的核心**。
 *
 * 两个正交的信号：
 *   - `remoteVersion` vs `manifestVersion` → **远程**动没动
 *   - `localSha` vs `manifestSha`         → **本地**动没动
 *
 * @param input - 远程版本、清单记录的版本与指纹、本地文件当前指纹。
 * @returns 四态之一。
 */
export function classifyPageState(input: {
  remoteVersion: string
  manifestVersion?: string | undefined
  manifestSha?: string | undefined
  localSha?: string | undefined
}): DocPageState {
  const { remoteVersion, manifestVersion, manifestSha, localSha } = input

  // 没有任何清单记录 = 从没缓存过。远程版本缺失也算"没得比"。
  if (manifestVersion === undefined || remoteVersion === '') return 'not-cached'
  // 清单说有、磁盘没有 —— 被手工删了或被清理过。
  if (localSha === undefined) return 'missing'

  const remoteChanged = remoteVersion !== manifestVersion
  const localChanged = manifestSha === undefined ? true : localSha !== manifestSha

  if (!remoteChanged && !localChanged) return 'synced'
  if (remoteChanged && !localChanged) return 'remote-ahead'
  if (!remoteChanged && localChanged) return 'local-dirty'
  return 'conflict'
}

/** 状态严重度：取最大者作为文档整体状态。 */
const STATE_SEVERITY: Record<DocPageState, number> = {
  synced: 0,
  'not-cached': 1,
  missing: 2,
  'remote-ahead': 3,
  'local-dirty': 4,
  conflict: 5,
}

/**
 * 把页状态汇总成文档状态（取最严重的一个）。
 *
 * 取最大值而不是"多数票"：一个冲突页不能因为另外 20 页都同步就被淹没。
 * @param states - 各页状态。
 * @returns 文档状态；空数组按 `not-cached`。
 */
export function rollupDocState(states: readonly DocPageState[]): DocState {
  if (states.length === 0) return 'not-cached'
  let worst: DocPageState = 'synced'
  for (const state of states) {
    if (STATE_SEVERITY[state] > STATE_SEVERITY[worst]) worst = state
  }
  return worst
}

/**
 * 计划一次拉取：**只拉需要拉的页**。
 *
 * 这是"按需、不预拉"的执行点：`synced` 的页一次网络调用都不花。
 * @param pages - 页 id 与它的状态。
 * @returns 需要拉取的页 id 列表（保持输入顺序）。
 */
export function planPull(pages: readonly { pageId: number; state: DocPageState }[]): number[] {
  return pages.filter((p) => p.state === 'remote-ahead' || p.state === 'missing').map((p) => p.pageId)
}

/** 把文件名清洗成安全的单段名（保留中文，去掉路径分隔与非法字符）。 */
export function safeFileSegment(name: string): string {
  const cleaned = name
    .replace(/[\\/]/g, '-')
    .replace(/[<>:"|?*\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned === '' ? 'untitled' : cleaned.slice(0, 120)
}

/** 目录名用的 slug（比文件名更保守：只留中英文数字与连字符）。 */
export function safeSlug(name: string): string {
  const cleaned = name
    .replace(/[^\p{Script=Han}\p{L}\p{N}-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned === '' ? 'doc' : cleaned.slice(0, 60)
}

/** 一页的落盘路径（相对文档目录）。文件夹页返回它的目录名。 */
export function pageRelPath(page: { name: string; type: string }): string {
  const base = safeFileSegment(page.name)
  return page.type === 'folder' ? base : `${base}.md`
}

/** 文本的 sha256 十六进制指纹。 */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** 清单里的一页。 */
export interface ManifestPage {
  name: string
  path: string
  /** 远程权威版本。 */
  version: string
  lastEditTime: string
  contentType: string
  /** 本地文件内容的指纹（检测"本地被改过"）。 */
  sha256: string
  bytes: number
  fetchedAt: string
}

/** 一个文档的版本清单。 */
export interface DocManifest {
  schema: 1
  enterpriseId: number
  /** null = 企业级公共文档。 */
  programId: number | null
  documentId: number
  documentNodeId: number
  name: string
  /** 文档级粗筛信号（MCP 的 updated_at）。 */
  documentUpdatedAt: string
  checkedAt: string
  /**
   * 上次核对得到的**整体状态**。
   *
   * 存它是为了列表页**零额外调用**：列 20 篇文档时为每篇都跑一次
   * `list_enterprise_document_pages` 是不可接受的。列表显示的是
   * "截至上次核对"的状态，界面会把 `checkedAt` 一起显示出来，不假装是实时的。
   */
  lastState?: DocPageState
  pages: Record<string, ManifestPage>
}

/** 索引里一个文档的定位信息（决定它的缓存目录）。 */
export interface IndexedDocument {
  enterpriseId: number
  programId: number | null
  name: string
}

/** 根索引（记录见过哪些企业 + 每个文档的定位）。 */
export interface DocsIndex {
  schema: 1
  enterprises: number[]
  documents?: Record<string, IndexedDocument>
}

/** 当前时间戳（本地口径，与 Gitee 的字符串格式保持一致风格）。 */
export function nowStamp(): string {
  return stampOf(new Date())
}

/**
 * 把时刻格式化成**本机时间**的字符串：`2026-10-27 13:02:11`。
 *
 * 为什么不是 `toISOString().slice(0,19)`：那是 UTC，界面上会印出「04:57」而
 * 使用者手表是 12:57 —— 用户 2026-10-27 先指出「时间不对」，改成带 `+08:00`
 * 偏移后又说「这个 +08:00 不用显示」。所以：**用本机时间，不打印时区段**。
 * 单时区场景下这是最干净的显示；机器读的老数据由 `parseStamp()` 兜住。
 *
 * @param date - 要格式化的时刻。
 * @returns 形如 `YYYY-MM-DD HH:mm:ss` 的字符串。
 */
export function stampOf(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 解析时间戳，**新旧两种格式都认**。
 *
 * - 本机时间：`2026-10-27 12:57:40`（无偏移，按本机时区解释）
 * - 带偏移：`2026-10-27 12:57:40 +08:00`（过渡期写出去过的串，仍要能读）
 *
 * @param raw - 时间戳字符串。
 * @returns 毫秒时间戳；解析不出来时返回 `NaN`。
 */
export function parseStamp(raw: string): number {
  const trimmed = raw.trim()
  // 「日期 时间 偏移」→ ISO 的「日期T时间+偏移」（偏移前的空格是 Date.parse 的克星）
  const isoish = trimmed.replace(' ', 'T').replace(/ ([+-]\d{2}:?\d{2})$/, '$1')
  const at = Date.parse(isoish)
  if (Number.isFinite(at)) return at
  return Date.parse(trimmed)
}

/** 读 JSON 文件；不存在或坏了都返回 undefined（缓存坏了不该让功能挂掉）。 */
export function readJson<T>(path: string): T | undefined {
  try {
    if (!existsSync(path)) return undefined
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** 原子感地写一个 JSON 文件（先确保目录存在）。 */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * 解析缓存根下的**企业层**。
 *
 * 只见过一个企业时直接用根目录（保持 `~/.dsh/gitee/docs/pj-xxx` 这个直觉路径）；
 * 一旦缓存里已经有过**别的**企业的文档，就 nest 一层 `e<eid>/`，
 * 避免两家公司的同名文档撞在一起。
 *
 * 判据用"已缓存文档里有没有别家"，而不是"索引里有几个企业 id"：
 * 后者在第一次切换到第二家企业时会先给出扁平路径、下一次才变嵌套，
 * 同一篇文档会落在两个位置 —— 那是最难查的一类 bug。
 *
 * @param root - 缓存根。
 * @param enterpriseId - 当前企业 id。
 * @param index - 根索引（看已缓存文档属于哪些企业）。
 */
export function enterpriseLayer(root: string, enterpriseId: number, index: DocsIndex): string {
  const others = new Set<number>()
  for (const doc of Object.values(index.documents ?? {})) {
    if (doc.enterpriseId !== enterpriseId) others.add(doc.enterpriseId)
  }
  return others.size > 0 ? join(root, `e${enterpriseId}`) : root
}

/** 项目/公共文档的层目录名。`_common` = 企业级公共文档。 */
export function scopeDirName(programId: number | null): string {
  return programId === null || programId <= 0 ? '_common' : `pj-${programId}`}

/**
 * 去掉结尾的扩展名（目录名用；`设备参数文档-矫正版.md` → `设备参数文档-矫正版`）。
 *
 * 只用于**目录名**：附件的名字自带扩展名，直接 slug 会得到
 * `设备参数文档-矫正版-md`（点被换成连字符）—— 难看且难搜。
 * 文件本身仍按原名落盘（`pageRelPath` 负责），所以这里只影响目录。
 */
export function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return name
  return name.slice(0, dot)
}

/**
 * 一个文档的本地目录。
 * @param input - 缓存根、企业层、项目 id、文档 id 与名字。
 */
export function documentDir(input: {
  cacheRoot: string
  enterpriseLayerPath: string
  programId: number | null
  documentId: number
  name: string
}): string {
  const scope = scopeDirName(input.programId)
  const leaf = `${input.documentId}-${safeSlug(stripExtension(input.name))}`
  return join(input.enterpriseLayerPath, scope, leaf)
}

/** 文档集合（`pj-xxx` 或 `_common`）的目录 —— 清缓存/列目录用。 */
export function scopeDir(cacheRoot: string, enterpriseLayerPath: string, programId: number | null): string {
  return join(enterpriseLayerPath, scopeDirName(programId))
}

/** 相对缓存根展示用的路径（给界面看）。 */
export function displayPath(cacheRoot: string, absolute: string): string {
  return absolute.startsWith(cacheRoot) ? `…${absolute.slice(cacheRoot.length)}` : absolute
}

/** 读一个文档的清单。 */
export function readManifest(dir: string): DocManifest | undefined {
  return readJson<DocManifest>(join(dir, MANIFEST_NAME))
}

/** 写一个文档的清单。 */
export function writeManifest(dir: string, manifest: DocManifest): void {
  writeJson(join(dir, MANIFEST_NAME), manifest)
}

/** 读一个文档目录下某一页的正文（不存在返回 undefined）。 */
export function readLocalPage(dir: string, relPath: string): string | undefined {
  const path = join(dir, relPath)
  try {
    if (!existsSync(path)) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 写一页到本地（自动建父目录）。 */
export function writeLocalPage(dir: string, relPath: string, content: string): void {
  const path = join(dir, relPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

/** 删除一个文档的本地缓存（"清缓存"用）。 */
export function removeDocument(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

// ── 附件的一致性清单（A1：缓存变更感知）──────────────────────────────────
//
// 附件**不是** WikiInfo 文档：它没有"页"、没有 `version`，而且**不可变**
// （在 Gitee 上改一个附件 = 重新上传成一个新节点）。所以四态模型里
// `local-dirty` / `conflict` 这两态**根本不存在** —— 我们从不改本地附件。
//
// 剩下来的问题只有一个：**远端那份还是不是我下载的那一份？**
// 唯一可靠的信号是节点上的 `updated_at` 与 `attach_file.size`：
//   · `updated_at` 变 → 内容变了（或节点被改过名/挪过位置 —— 见 DOCS.md §13.2 #1）
//   · `size` 变      → 内容一定变了
//
// ⚠️ **不做 sha256**：那一列本来是为"本地被改过"准备的，而附件永远不被本地改。
// 对一个几十 MiB 的二进制每次点击都算一遍哈希，是纯粹的浪费。
// 真要校验落盘完整性，`size` 与清单里的记录不符就已经够了。

/**
 * 可当**文本**读回来的扩展名（白名单，保守）。
 *
 * ⚠️ 这里的"可读"只决定**宿主能不能把字节变成字符串**，与"界面要不要内联预览"是两回事：
 * 预览分工由 `client/*.tsx` 的 `INLINE_PREVIEW_EXT` 决定（只有 `.md`）。
 * 混为一谈会让 `.png` 也被塞进正文里。
 */
export const TEXT_PREVIEW_EXT = new Set([
  'md', 'markdown', 'txt', 'json', 'yaml', 'yml', 'csv', 'tsv', 'log', 'html', 'htm', 'xml', 'js', 'ts', 'py', 'go', 'sh', 'sql',
])

/** 取小写扩展名（无扩展名返回空串）。 */
export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * 读本地文本文件（带上限）。
 *
 * 读的是**由 MCP 写进缓存的文件**。读不到返回 undefined（二进制、权限问题、不存在），
 * 调用方据此按"不可预览"处理 —— 不假装读到了空内容。
 * @param path - 文件绝对路径。
 * @param maxBytes - 截断上限（字节）。
 */
export function readTextFile(path: string, maxBytes: number): { content: string; truncated: boolean } | undefined {
  try {
    const buffer = readFileSync(path)
    const truncated = buffer.byteLength > maxBytes
    const slice = truncated ? buffer.subarray(0, maxBytes) : buffer
    return { content: slice.toString('utf8'), truncated }
  } catch {
    return undefined
  }
}

/** 附件清单文件名（与文档清单分开，免得两种形状互相覆盖）。 */
export const ATTACH_MANIFEST_NAME = '.gitee-attach.json'

/**
 * 一个已缓存附件的清单。
 *
 * 记的都是**下载那一刻**从节点上看到的远端事实 —— 于是下次点开时，
 * 把当前的节点与它一比，就知道远端有没有变，**不需要重新下载**。
 */
export interface AttachManifest {
  schema: 1
  enterpriseId: number
  /** 节点 id（**不是** file_id）。 */
  nodeId: number
  /** 附件内容 id（`download_attach_file` 用它）。 */
  fileId: number
  name: string
  /** 下载时节点上的 `updated_at`。 */
  updatedAt: string
  /** 下载时节点上的 `attach_file.size`（拿不到时为 0，此时只比 `updatedAt`）。 */
  size: number
  /** 落盘后的实际字节数。 */
  bytes: number
  /** 落盘文件名（相对目录）。 */
  fileName: string
  fetchedAt: string
}

/** 附件缓存的一个状态。比文档少两态 —— 附件不会被本地改。 */
export type AttachState =
  /** 本地什么都没有。 */
  | 'not-cached'
  /** 清单在，但落盘的文件不见了。 */
  | 'missing'
  /** 本地与远端一致 —— 可以直接读，不必再调 MCP。 */
  | 'synced'
  /** 远端变了（`updated_at` 或 `size` 不同）—— 提示，但**不自动覆盖**。 */
  | 'remote-ahead'

/** 读一个附件目录的清单。 */
export function readAttachManifest(dir: string): AttachManifest | undefined {
  return readJson<AttachManifest>(join(dir, ATTACH_MANIFEST_NAME))
}

/** 写一个附件目录的清单。 */
export function writeAttachManifest(dir: string, manifest: AttachManifest): void {
  writeJson(join(dir, ATTACH_MANIFEST_NAME), manifest)
}

/**
 * 判定一个附件的本地状态（纯函数的第一半：给定清单、落盘事实与远端事实）。
 *
 * @param manifest - 本地清单（没缓存过为 undefined）。
 * @param exists - 落盘文件是否还在。
 * @param remote - 当前从节点上看到的远端事实。
 */
export function classifyAttachState(
  manifest: AttachManifest | undefined,
  exists: boolean,
  remote: { updatedAt: string; size: number },
): AttachState {
  if (manifest === undefined) return 'not-cached'
  if (!exists) return 'missing'
  // `updatedAt` 为空（接口没给）时不要据此判"变了" —— 那会导致永远重下。
  const timeChanged = manifest.updatedAt !== '' && remote.updatedAt !== '' && manifest.updatedAt !== remote.updatedAt
  // `size` 只有两边都拿到（>0）时才比，理由同上。
  const sizeChanged = manifest.size > 0 && remote.size > 0 && manifest.size !== remote.size
  return timeChanged || sizeChanged ? 'remote-ahead' : 'synced'
}

/** 一个附件目录的落盘文件是否还在（按清单记的文件名找）。 */
export function attachFileExists(dir: string, manifest: AttachManifest): boolean {
  if (manifest.fileName === '') return false
  try {
    return existsSync(join(dir, manifest.fileName))
  } catch {
    return false
  }
}

// ── 缓存用量（A2：缓存管理入口）─────────────────────────────────────────

/** 一次缓存用量统计。 */
export interface CacheStats {
  /** 附件缓存（`pj-<id>/` 与 `_common/` 下的东西）。 */
  attachments: { count: number; bytes: number }
  /** 仓库 WIKI 克隆（`wiki/` 下）。 */
  wikis: { count: number; bytes: number }
  /** 命中上限被截断（缓存特别大时不再往下数）。 */
  truncated: boolean
}

/** 一次统计最多走多少个条目 —— 缓存管理是给人看的，不值得为它遍历十万个文件。 */
const STATS_MAX_ENTRIES = 20_000

/**
 * 统计本地缓存的用量（**有界**遍历，不调 git、不发请求）。
 *
 * 为什么分"附件"与"仓库 WIKI"两类：它们的清理语义不同 ——
 * 附件是"读过的副本"，WIKI 是"整个 git 克隆"（通常大得多）。
 * 合成一个数字会让人以为清掉附件就能腾出空间。
 *
 * @param root - 缓存根。
 */
export function cacheStats(root: string): CacheStats {
  const stats: CacheStats = { attachments: { count: 0, bytes: 0 }, wikis: { count: 0, bytes: 0 }, truncated: false }
  let seen = 0
  const walk = (dir: string, bucket: 'attachments' | 'wikis', skipGit: boolean): void => {
    if (seen >= STATS_MAX_ENTRIES) {
      stats.truncated = true
      return
    }
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (seen >= STATS_MAX_ENTRIES) {
        stats.truncated = true
        return
      }
      // WIKI 是 git 克隆 —— `.git` 占绝大多数体积，但统计"页"的数量时不该算进去。
      if (skipGit && entry === '.git') continue
      const abs = join(dir, entry)
      let st
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      seen += 1
      if (st.isDirectory()) {
        walk(abs, bucket, skipGit)
      } else if (st.isFile()) {
        stats[bucket].count += 1
        stats[bucket].bytes += st.size
      }
    }
  }
  walk(join(root, 'wiki'), 'wikis', true)
  // 其余一切（pj-*/、_common/、索引、清单）都算附件侧。
  let top: string[]
  try {
    top = readdirSync(root)
  } catch {
    return stats
  }
  for (const entry of top) {
    if (entry === 'wiki' || entry === INDEX_NAME) continue
    const abs = join(root, entry)
    try {
      if (statSync(abs).isDirectory()) walk(abs, 'attachments', false)
    } catch {
      // 不是目录就跳过。
    }
  }
  return stats
}

/** 人类可读的体积（缓存管理界面上直接显示）。 */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 读根索引（企业列表）。 */
export function readIndex(cacheRoot: string): DocsIndex {
  return readJson<DocsIndex>(join(cacheRoot, INDEX_NAME)) ?? { schema: 1, enterprises: [] }
}

/** 把一个企业 id 记进根索引（幂等）。 */
export function rememberEnterprise(cacheRoot: string, enterpriseId: number): DocsIndex {
  const index = readIndex(cacheRoot)
  if (!index.enterprises.includes(enterpriseId)) index.enterprises.push(enterpriseId)
  writeJson(join(cacheRoot, INDEX_NAME), index)
  return index
}

/** 记下一个文档的定位信息（幂等；改名会更新 name）。 */
export function rememberDocument(cacheRoot: string, documentId: number, info: IndexedDocument): DocsIndex {
  const index = readIndex(cacheRoot)
  index.documents = index.documents ?? {}
  index.documents[String(documentId)] = info
  if (!index.enterprises.includes(info.enterpriseId)) index.enterprises.push(info.enterpriseId)
  writeJson(join(cacheRoot, INDEX_NAME), index)
  return index
}

/** 查一个文档的定位信息（没缓存过返回 undefined）。 */
export function findDocument(cacheRoot: string, documentId: number): IndexedDocument | undefined {
  return readIndex(cacheRoot).documents?.[String(documentId)]
}

/**
 * 由"页 + 清单 + 本地"算出每页的状态。
 *
 * 这是把 §4 的四态判定接到真实数据上的那一步；判定本身在
 * `classifyPageState` 里（纯函数、可断言）。
 *
 * @param pages - 远程页清单（含 version）。
 * @param manifest - 本地清单（可能没有）。
 * @param dir - 文档本地目录。
 * @param readPage - 读本地页正文（注入以便测试）。
 */
export function classifyDocument(
  pages: readonly { pageId: number; name: string; type: string; version: string }[],
  manifest: DocManifest | undefined,
  dir: string,
  readPage: (dir: string, relPath: string) => string | undefined = readLocalPage,
): { pageId: number; name: string; type: string; version: string; state: DocPageState; relPath: string }[] {
  return pages.map((page) => {
    const relPath = pageRelPath(page)
    const recorded = manifest?.pages[String(page.pageId)]
    const local = readPage(dir, relPath)
    const state = classifyPageState({
      remoteVersion: page.version,
      manifestVersion: recorded?.version,
      manifestSha: recorded?.sha256,
      localSha: local === undefined ? undefined : sha256Hex(local),
    })
    return { pageId: page.pageId, name: page.name, type: page.type, version: page.version, state, relPath }
  })
}
