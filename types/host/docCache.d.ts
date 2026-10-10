/**
 * 知识库文档的**按需缓存**与**页级版本核对**（host 平面）。
 *
 * 设计口径：两条最容易搞错、所以在这里写死的事：
 *
 *   1. 缓存**不是镜像** —— 只有"读过的那几篇、那几页"在本地。
 *      全量拉取被明确否掉（浪费空间 + 同步不及时）。
 *   2. **变更的单位是「页」，不是「文档」** —— 所以版本清单是**页级**的，
 *      而文档级的 `updated_at` 只配当"粗筛"。
 *
 * 判定逻辑全部是**纯函数**（`classifyPageState` / `rollupDocState` / `planPull`），
 * 因此可以被冒烟测试逐条断言 —— 这是「能用规则算的就别让模型算」
 * 在本功能上的落点。
 *
 * @module dsh-gitee-chat/host/doc-cache
 */
/** 清单文件名（放在每个文档目录下）。 */
export declare const MANIFEST_NAME = ".gitee-doc.json";
/** 根索引文件名。 */
export declare const INDEX_NAME = ".index.json";
/** 一页在本地的状态。 */
export type DocPageState = 
/** 本地没有这一页（或整篇没缓存过）。 */
'not-cached'
/** 清单里有，但本地文件不见了。 */
 | 'missing'
/** 本地与远程一致 —— 可以直接读。 */
 | 'synced'
/** 远程更新了，本地还是旧的 —— 该拉。 */
 | 'remote-ahead'
/** 本地改过、远程没动 —— 未推送的编辑，不能丢。 */
 | 'local-dirty'
/** 两边都动了 —— 停下交人决策，绝不自动合并。 */
 | 'conflict';
/** 文档整体状态（页状态的汇总）。 */
export type DocState = DocPageState;
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
export declare function classifyPageState(input: {
    remoteVersion: string;
    manifestVersion?: string | undefined;
    manifestSha?: string | undefined;
    localSha?: string | undefined;
}): DocPageState;
/**
 * 把页状态汇总成文档状态（取最严重的一个）。
 *
 * 取最大值而不是"多数票"：一个冲突页不能因为另外 20 页都同步就被淹没。
 * @param states - 各页状态。
 * @returns 文档状态；空数组按 `not-cached`。
 */
export declare function rollupDocState(states: readonly DocPageState[]): DocState;
/**
 * 计划一次拉取：**只拉需要拉的页**。
 *
 * 这是"按需、不预拉"的执行点：`synced` 的页一次网络调用都不花。
 * @param pages - 页 id 与它的状态。
 * @returns 需要拉取的页 id 列表（保持输入顺序）。
 */
export declare function planPull(pages: readonly {
    pageId: number;
    state: DocPageState;
}[]): number[];
/** 把文件名清洗成安全的单段名（保留中文，去掉路径分隔与非法字符）。 */
export declare function safeFileSegment(name: string): string;
/** 目录名用的 slug（比文件名更保守：只留中英文数字与连字符）。 */
export declare function safeSlug(name: string): string;
/** 一页的落盘路径（相对文档目录）。文件夹页返回它的目录名。 */
export declare function pageRelPath(page: {
    name: string;
    type: string;
}): string;
/** 文本的 sha256 十六进制指纹。 */
export declare function sha256Hex(text: string): string;
/** 清单里的一页。 */
export interface ManifestPage {
    name: string;
    path: string;
    /** 远程权威版本。 */
    version: string;
    lastEditTime: string;
    contentType: string;
    /** 本地文件内容的指纹（检测"本地被改过"）。 */
    sha256: string;
    bytes: number;
    fetchedAt: string;
}
/** 一个文档的版本清单。 */
export interface DocManifest {
    schema: 1;
    enterpriseId: number;
    /** null = 企业级公共文档。 */
    programId: number | null;
    documentId: number;
    documentNodeId: number;
    name: string;
    /** 文档级粗筛信号（MCP 的 updated_at）。 */
    documentUpdatedAt: string;
    checkedAt: string;
    /**
     * 上次核对得到的**整体状态**。
     *
     * 存它是为了列表页**零额外调用**：列 20 篇文档时为每篇都跑一次
     * `list_enterprise_document_pages` 是不可接受的。列表显示的是
     * "截至上次核对"的状态，界面会把 `checkedAt` 一起显示出来，不假装是实时的。
     */
    lastState?: DocPageState;
    pages: Record<string, ManifestPage>;
}
/** 索引里一个文档的定位信息（决定它的缓存目录）。 */
export interface IndexedDocument {
    enterpriseId: number;
    programId: number | null;
    name: string;
}
/** 根索引（记录见过哪些企业 + 每个文档的定位）。 */
export interface DocsIndex {
    schema: 1;
    enterprises: number[];
    documents?: Record<string, IndexedDocument>;
}
/** 当前时间戳（本地口径，与 Gitee 的字符串格式保持一致风格）。 */
export declare function nowStamp(): string;
/** 读 JSON 文件；不存在或坏了都返回 undefined（缓存坏了不该让功能挂掉）。 */
export declare function readJson<T>(path: string): T | undefined;
/** 原子感地写一个 JSON 文件（先确保目录存在）。 */
export declare function writeJson(path: string, value: unknown): void;
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
export declare function enterpriseLayer(root: string, enterpriseId: number, index: DocsIndex): string;
/** 项目/公共文档的层目录名。`_common` = 企业级公共文档。 */
export declare function scopeDirName(programId: number | null): string;
/**
 * 去掉结尾的扩展名（目录名用；`设备参数文档-矫正版.md` → `设备参数文档-矫正版`）。
 *
 * 只用于**目录名**：附件的名字自带扩展名，直接 slug 会得到
 * `设备参数文档-矫正版-md`（点被换成连字符）—— 难看且难搜。
 * 文件本身仍按原名落盘（`pageRelPath` 负责），所以这里只影响目录。
 */
export declare function stripExtension(name: string): string;
/**
 * 一个文档的本地目录。
 * @param input - 缓存根、企业层、项目 id、文档 id 与名字。
 */
export declare function documentDir(input: {
    cacheRoot: string;
    enterpriseLayerPath: string;
    programId: number | null;
    documentId: number;
    name: string;
}): string;
/** 文档集合（`pj-xxx` 或 `_common`）的目录 —— 清缓存/列目录用。 */
export declare function scopeDir(cacheRoot: string, enterpriseLayerPath: string, programId: number | null): string;
/** 相对缓存根展示用的路径（给界面看）。 */
export declare function displayPath(cacheRoot: string, absolute: string): string;
/** 读一个文档的清单。 */
export declare function readManifest(dir: string): DocManifest | undefined;
/** 写一个文档的清单。 */
export declare function writeManifest(dir: string, manifest: DocManifest): void;
/** 读一个文档目录下某一页的正文（不存在返回 undefined）。 */
export declare function readLocalPage(dir: string, relPath: string): string | undefined;
/** 写一页到本地（自动建父目录）。 */
export declare function writeLocalPage(dir: string, relPath: string, content: string): void;
/** 删除一个文档的本地缓存（"清缓存"用）。 */
export declare function removeDocument(dir: string): void;
/**
 * 可当**文本**读回来的扩展名（白名单，保守）。
 *
 * ⚠️ 这里的"可读"只决定**宿主能不能把字节变成字符串**，与"界面要不要内联预览"是两回事：
 * 预览分工由 `client/*.tsx` 的 `INLINE_PREVIEW_EXT` 决定（只有 `.md`）。
 * 混为一谈会让 `.png` 也被塞进正文里。
 */
export declare const TEXT_PREVIEW_EXT: Set<string>;
/** 取小写扩展名（无扩展名返回空串）。 */
export declare function extOf(name: string): string;
/**
 * 读本地文本文件（带上限）。
 *
 * 读的是**由 MCP 写进缓存的文件**。读不到返回 undefined（二进制、权限问题、不存在），
 * 调用方据此按"不可预览"处理 —— 不假装读到了空内容。
 * @param path - 文件绝对路径。
 * @param maxBytes - 截断上限（字节）。
 */
export declare function readTextFile(path: string, maxBytes: number): {
    content: string;
    truncated: boolean;
} | undefined;
/** 附件清单文件名（与文档清单分开，免得两种形状互相覆盖）。 */
export declare const ATTACH_MANIFEST_NAME = ".gitee-attach.json";
/**
 * 一个已缓存附件的清单。
 *
 * 记的都是**下载那一刻**从节点上看到的远端事实 —— 于是下次点开时，
 * 把当前的节点与它一比，就知道远端有没有变，**不需要重新下载**。
 */
export interface AttachManifest {
    schema: 1;
    enterpriseId: number;
    /** 节点 id（**不是** file_id）。 */
    nodeId: number;
    /** 附件内容 id（`download_attach_file` 用它）。 */
    fileId: number;
    name: string;
    /** 下载时节点上的 `updated_at`。 */
    updatedAt: string;
    /** 下载时节点上的 `attach_file.size`（拿不到时为 0，此时只比 `updatedAt`）。 */
    size: number;
    /** 落盘后的实际字节数。 */
    bytes: number;
    /** 落盘文件名（相对目录）。 */
    fileName: string;
    fetchedAt: string;
}
/** 附件缓存的一个状态。比文档少两态 —— 附件不会被本地改。 */
export type AttachState = 
/** 本地什么都没有。 */
'not-cached'
/** 清单在，但落盘的文件不见了。 */
 | 'missing'
/** 本地与远端一致 —— 可以直接读，不必再调 MCP。 */
 | 'synced'
/** 远端变了（`updated_at` 或 `size` 不同）—— 提示，但**不自动覆盖**。 */
 | 'remote-ahead';
/** 读一个附件目录的清单。 */
export declare function readAttachManifest(dir: string): AttachManifest | undefined;
/** 写一个附件目录的清单。 */
export declare function writeAttachManifest(dir: string, manifest: AttachManifest): void;
/**
 * 判定一个附件的本地状态（纯函数的第一半：给定清单、落盘事实与远端事实）。
 *
 * @param manifest - 本地清单（没缓存过为 undefined）。
 * @param exists - 落盘文件是否还在。
 * @param remote - 当前从节点上看到的远端事实。
 */
export declare function classifyAttachState(manifest: AttachManifest | undefined, exists: boolean, remote: {
    updatedAt: string;
    size: number;
}): AttachState;
/** 一个附件目录的落盘文件是否还在（按清单记的文件名找）。 */
export declare function attachFileExists(dir: string, manifest: AttachManifest): boolean;
/** 一次缓存用量统计。 */
export interface CacheStats {
    /** 附件缓存（`pj-<id>/` 与 `_common/` 下的东西）。 */
    attachments: {
        count: number;
        bytes: number;
    };
    /** 仓库 WIKI 克隆（`wiki/` 下）。 */
    wikis: {
        count: number;
        bytes: number;
    };
    /** 命中上限被截断（缓存特别大时不再往下数）。 */
    truncated: boolean;
}
/**
 * 统计本地缓存的用量（**有界**遍历，不调 git、不发请求）。
 *
 * 为什么分"附件"与"仓库 WIKI"两类：它们的清理语义不同 ——
 * 附件是"读过的副本"，WIKI 是"整个 git 克隆"（通常大得多）。
 * 合成一个数字会让人以为清掉附件就能腾出空间。
 *
 * @param root - 缓存根。
 */
export declare function cacheStats(root: string): CacheStats;
/** 人类可读的体积（缓存管理界面上直接显示）。 */
export declare function humanBytes(bytes: number): string;
/** 读根索引（企业列表）。 */
export declare function readIndex(cacheRoot: string): DocsIndex;
/** 把一个企业 id 记进根索引（幂等）。 */
export declare function rememberEnterprise(cacheRoot: string, enterpriseId: number): DocsIndex;
/** 记下一个文档的定位信息（幂等；改名会更新 name）。 */
export declare function rememberDocument(cacheRoot: string, documentId: number, info: IndexedDocument): DocsIndex;
/** 查一个文档的定位信息（没缓存过返回 undefined）。 */
export declare function findDocument(cacheRoot: string, documentId: number): IndexedDocument | undefined;
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
export declare function classifyDocument(pages: readonly {
    pageId: number;
    name: string;
    type: string;
    version: string;
}[], manifest: DocManifest | undefined, dir: string, readPage?: (dir: string, relPath: string) => string | undefined): {
    pageId: number;
    name: string;
    type: string;
    version: string;
    state: DocPageState;
    relPath: string;
}[];
