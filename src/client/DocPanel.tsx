/**
 * 「知识库」面板 —— 整屏 Gitee 项目视图的第三个分段。
 *
 * ## 为什么这一版是"树"，而不是"文档列表"
 *
 * 实测（2026-09-15）发现：本企业的知识库**不是** `WikiInfo` 文档
 * （`list_enterprise_documents` 恒返回 0），而是
 * **`DocDirectory`（文件夹）+ `AttachFile`（上传的 .md/.docx/.pdf/.png…）组成的节点树**，
 * 只能从 `doc_nodes/level` 走。上一版把列表绑到 `list_enterprise_documents`，
 * 于是永远空白 —— 这个文件就是按真实形态重写的。
 *
 * ## 三条刻意的设计
 *
 * 1. **按需**：一次只列**一层**；展开哪个文件夹才拉哪个。不做全量遍历。
 * 2. **诚实**：附件内容目前**读不了**（MCP 还没有读取工具）。界面明确标注，
 *    而不是给一个点了没反应的入口 —— 空白界面比"看起来能用"更好排查。
 * 3. **不做假的缓存状态**：附件没有页级 version，硬套四态徽标就是骗人。
 *    等 P1′ 接上内容读取后，再按"节点 id + updated_at + size + 本地 sha256"做一致性。
 *
 * @module dsh-gitee-chat/client/DocPanel
 */

import { createElement as h, useCallback, useEffect, useState } from 'react'
import css from './board.module.css'
import { fetchCacheInfo, fetchDocAttachment, fetchDocNodes, forgetCache } from './api.ts'
import { sidebarAvailable, sidebarOpenFile } from './sidebar.ts'
import { Card, CardTitle, Empty, ErrorState, Markdown, Note, Pill, Segmented, Stat, StatGrid, day } from './ui.tsx'
import type { CacheInfoResponse } from './api.ts'
import type { AttachStateView, DocAttachmentResponse, DocNodeRow, DocTreeResponse } from '../types.ts'

/** 面板入参。 */
export interface DocPanelProps {
  /** 当前会话 id（host 靠它解析 agent 作用域）。 */
  sessionId: string
  /** 当前选中的项目（null = 只看公共知识库）。 */
  programId: number | null
  /** 项目名。 */
  programName: string
}

/** 文件类型 → 中文名。 */
function typeLabel(fileType: string): string {
  if (fileType === 'DocDirectory') return '文件夹'
  if (fileType === 'AttachFile') return '附件'
  if (fileType === 'WikiInfo') return '文档'
  return fileType || '未知'
}

/** 附件扩展名 → 图标（纯文本，不引图标库）。 */
function extIcon(ext: string): string {
  if (ext === 'md' || ext === 'txt') return '📄'
  if (ext === 'docx' || ext === 'doc') return '📝'
  if (ext === 'pdf') return '📕'
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'bmp' || ext === 'gif') return '🖼'
  if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') return '📊'
  if (ext === 'zip' || ext === 'rar' || ext === '7z') return '🗜'
  return '📎'
}

/**
 * 本插件**自己**内联预览的扩展名。
 *
 * 只有 Markdown。其余类型（图片 / PDF / Office / 代码…）**不做预览器** ——
 * 装了 `dsh-better-sidebar` 就点开交给它（支持哪些类型是它的能力，见
 * `client/sidebar.ts`），没装就只给落盘路径。这样插件的预览面积恒定，
 * 不会随着 Gitee 上出现什么文件类型而膨胀。
 */
const INLINE_PREVIEW_EXT = new Set(['md', 'markdown'])

/**
 * 附件缓存状态 → 界面文案与色调。
 *
 * 附件**不可变**，所以只有这四态（没有"本地已改"/"冲突"）——
 * 界面也就不该出现那两个词，否则使用者会去找一个不存在的操作。
 */
const ATTACH_STATE: Record<AttachStateView, { label: string; tone?: 'warn' | 'ok' } | null> = {
  'not-cached': null,
  missing: { label: '本地缺失', tone: 'warn' },
  synced: { label: '已缓存', tone: 'ok' },
  'remote-ahead': { label: '远端已更新', tone: 'warn' },
}

/** 一层子节点的加载状态。 */
type ChildrenState = { kind: 'loading' } | { kind: 'ready'; nodes: DocNodeRow[] } | { kind: 'error'; message: string }

/** 人类可读的体积（与宿主侧 `humanBytes` 同口径，界面用）。 */
function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * 一个节点右侧的缓存状态徽标。
 *
 * 目录节点不参与缓存（`state` 恒为 `not-cached`），所以不给徽标 ——
 * 给文件夹标"未缓存"只会让人以为那是个可操作的状态。
 * @param node - 节点行。
 */
function badgeOf(node: DocNodeRow) {
  if (node.directory) return null
  const meta = ATTACH_STATE[node.state]
  if (meta === null) return null
  return h(Pill, { tone: meta.tone, title: `本地缓存状态：${meta.label}` }, meta.label)
}

/**
 * 知识库面板（节点树 + 按需展开）。
 * @param props - 会话与当前项目。
 */
export function DocPanel(props: DocPanelProps) {
  const { sessionId, programId, programName } = props

  const [scope, setScope] = useState<'project' | 'common'>(programId === null ? 'common' : 'project')
  const [tree, setTree] = useState<DocTreeResponse | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  /** 已展开节点 → 其子层。key 是 `${scope}:${nodeId}`。 */
  const [children, setChildren] = useState<Record<string, ChildrenState>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<DocNodeRow | null>(null)
  /** 已读取的附件内容（本企业知识库真正能读的那条路）。 */
  const [attachment, setAttachment] = useState<DocAttachmentResponse | null>(null)
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState('')
  /**
   * 节点名过滤词。
   *
   * **纯前端**：只过滤**已经拉下来的层**。子层是点开才拉的（按需），
   * 所以这里不会为了找东西把整棵树拉下来 —— 界面也如实写明这一点。
   * 文件夹恒显示（里面可能有没展开的命中项），只过滤文件。
   */
  const [filter, setFilter] = useState('')
  /** 缓存用量（A2）。与树一起拉：清缓存后要重新拉一次才能刷新徽标。 */
  const [cache, setCache] = useState<CacheInfoResponse | null>(null)
  const [cacheBusy, setCacheBusy] = useState(false)
  /** 缓存操作的结果提示（成功/失败都显示，不静默）。 */
  const [cacheNote, setCacheNote] = useState('')
  /** 本次点击是否已经**交给侧边栏**打开（true 时本面板不再自己渲染预览）。 */
  const [delegated, setDelegated] = useState(false)
  /** 交给侧边栏时用的那条路径（显示出来，排障时一眼看到用的是哪条）。 */
  const [delegatedPath, setDelegatedPath] = useState('')

  const effectiveProgram = scope === 'common' ? null : programId

  /** 拉某个范围某层的节点。 */
  const loadLevel = useCallback(async (pid: number | null, parentId: number, signal?: AbortSignal): Promise<DocTreeResponse> => {
    return await fetchDocNodes(sessionId, pid, parentId, signal)
  }, [sessionId])

  /** 拉顶层（切范围/刷新时）。 */
  const loadRoot = useCallback(async (signal?: AbortSignal) => {
    setPhase('loading')
    setSelected(null)
    setChildren({})
    setExpanded({})
    try {
      const data = await loadLevel(effectiveProgram, 0, signal)
      if (signal?.aborted === true) return
      setTree(data)
      setPhase('ready')
      // 缓存用量是**本地**统计（不发请求、不调 MCP），所以与树一起拉不心疼。
      void fetchCacheInfo(sessionId, effectiveProgram, signal)
        .then((info) => { if (signal?.aborted !== true) setCache(info) })
        .catch(() => { /* 统计失败不影响主流程 */ })
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }, [effectiveProgram, loadLevel])

  useEffect(() => {
    const controller = new AbortController()
    void loadRoot(controller.signal)
    return () => controller.abort()
  }, [loadRoot])

  /** 展开/收起一个文件夹（**展开才拉这一层**）。 */
  const toggle = useCallback(async (node: DocNodeRow) => {
    const key = `${scope}:${node.nodeId}`
    if (expanded[key] === true) {
      setExpanded((prev) => ({ ...prev, [key]: false }))
      return
    }
    setExpanded((prev) => ({ ...prev, [key]: true }))
    if (children[key] !== undefined) return
    setChildren((prev) => ({ ...prev, [key]: { kind: 'loading' } }))
    try {
      const data = await loadLevel(node.programId ?? effectiveProgram, node.nodeId)
      const first = data.roots[0]
      setChildren((prev) => ({ ...prev, [key]: { kind: 'ready', nodes: first?.nodes ?? [] } }))
    } catch (err) {
      setChildren((prev) => ({ ...prev, [key]: { kind: 'error', message: err instanceof Error ? err.message : String(err) } }))
    }
  }, [children, effectiveProgram, expanded, loadLevel, scope])

  /**
   * 读一个附件的内容（落到缓存目录）。
   * @returns 读到的内容；失败返回 null（错误已经写进 readError）。
   */
  const readAttachment = useCallback(async (node: DocNodeRow, refresh = false): Promise<DocAttachmentResponse | null> => {
    setReading(true)
    setReadError('')
    setAttachment(null)
    try {
      const data = await fetchDocAttachment(sessionId, {
        nodeId: node.nodeId,
        fileId: node.fileId,
        name: node.name,
        programId: node.programId ?? effectiveProgram,
        // 把节点当前的远端事实带过去 —— 宿主据此判"本地这份还新不新"，
        // 新就直接读本地，一次 MCP 都不发。
        updatedAt: node.updatedAt,
        size: node.size,
        refresh,
      })
      setAttachment(data)
      return data
    } catch (err) {
      setReadError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setReading(false)
    }
  }, [effectiveProgram, sessionId])

  /**
   * 点一个文件：**先落到缓存，再决定谁来显示**。
   *
   * 顺序是有意的 —— 侧边栏要打开的是一个**已存在的本地文件**，所以必须
   * 先经 host 把附件下载到缓存根（那一步同时算出工作区可见路径）。
   *
   * 分工（需求原话「有侧边栏就以侧边栏打开，没有侧边栏就只在本插件渲染 .md，
   * 其他一概不预览」）：
   *
   *   1. **有侧边栏 → 一律交给它**，本面板不渲染预览。目标路径优先用
   *      `workspacePath`（工作区软链接下）；拿不到就退回缓存真实路径 ——
   *      围栏开着时后者会被侧边栏自己拦下并给出"关闭围栏"的按钮，
   *      但那仍然叫"调用了侧边栏"，不该悄悄改成我们自己渲染。
   *   2. **没有侧边栏** → 内联预览 `.md`，其它类型只给落盘路径。
   */
  const openNode = useCallback(async (node: DocNodeRow) => {
    setSelected(node)
    setAttachment(null)
    setReadError('')
    setDelegated(false)
    setDelegatedPath('')
    if (node.directory) {
      void toggle(node)
      return
    }
    if (!node.readable) return
    const data = await readAttachment(node)
    if (data === null) return
    const target = data.workspacePath ?? data.savedPath
    if (sidebarOpenFile(sessionId, target, node.name)) {
      setDelegatedPath(target)
      setDelegated(true)
    }
  }, [readAttachment, sessionId, toggle])

  /**
   * 清缓存（A2）。
   *
   * 两个入口共用：`attachment` 清一个节点，`scope` 清当前范围的全部附件。
   * 清完**重新拉一次树** —— 徽标是宿主按清单算的，缓存没了它才会变回"未缓存"。
   * 不做二次确认：缓存是副本，删了只是下次重新下载。
   * @param target - 清哪个。
   */
  const clearCache = useCallback(async (target: { kind: 'attachment'; node: DocNodeRow } | { kind: 'scope' }) => {
    setCacheBusy(true)
    setCacheNote('')
    try {
      const out = target.kind === 'attachment'
        ? await forgetCache(sessionId, {
          kind: 'attachment', nodeId: target.node.nodeId, name: target.node.name, programId: target.node.programId ?? effectiveProgram,
        })
        : await forgetCache(sessionId, { kind: 'scope', programId: effectiveProgram })
      setCacheNote(out.removed ? `已清掉 ${out.dir}` : '本来就没有缓存，无需清理')
      await loadRoot()
    } catch (err) {
      setCacheNote(`清缓存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCacheBusy(false)
    }
  }, [effectiveProgram, loadRoot, sessionId])

  /** 递归渲染一层。 */
  const renderNodes = useCallback((nodes: DocNodeRow[], depth: number): unknown[] => {
    const out: unknown[] = []
    const q = filter.trim().toLowerCase()
    for (const node of nodes) {
      // 过滤只作用于**文件**：文件夹里可能藏着没展开的命中项，藏掉它等于让人搜不到。
      if (q !== '' && !node.directory
        && !node.name.toLowerCase().includes(q) && !node.filePath.toLowerCase().includes(q)) continue
      const key = `${scope}:${node.nodeId}`
      const isOpen = expanded[key] === true
      const child = children[key]
      out.push(h('div', {
        key: `n-${node.nodeId}`,
        className: css.gqVNavItem,
        role: 'button',
        tabIndex: 0,
        style: { paddingLeft: 8 + depth * 14, opacity: node.readable ? 1 : 0.8 },
        title: `${node.filePath}\n${node.readable ? '可读' : (node.unreadableReason ?? '内容暂不可读')}`,
        onClick: () => { void openNode(node) },
      },
        h('div', { className: css.gqVNavName },
          node.directory ? (isOpen ? '▾ ' : '▸ ') : `${extIcon(node.ext)} `,
          node.name),
        h('div', { className: css.gqVNavSub },
          h('span', { className: css.gqVDim }, typeLabel(node.fileType)),
          node.ext !== '' ? h('span', { className: css.gqVDim }, `.${node.ext}`) : null,
          h('span', { className: css.gqVDim }, node.updatedAt === '' ? '' : day(node.updatedAt)),
          badgeOf(node),
          node.readable ? null : h(Pill, { tone: 'warn', title: node.unreadableReason }, '内容待接入'),
        ),
      ))
      if (!isOpen) continue
      if (child === undefined || child.kind === 'loading') {
        out.push(h('div', { key: `l-${node.nodeId}`, className: css.gqVDim, style: { paddingLeft: 22 + depth * 14, fontSize: 12 } }, '正在拉取…'))
      } else if (child.kind === 'error') {
        out.push(h('div', { key: `e-${node.nodeId}`, className: css.gqVErr, style: { paddingLeft: 22 + depth * 14, fontSize: 12 } }, child.message))
      } else if (child.nodes.length === 0) {
        out.push(h('div', { key: `z-${node.nodeId}`, className: css.gqVDim, style: { paddingLeft: 22 + depth * 14, fontSize: 12 } }, '（空文件夹）'))
      } else {
        out.push(...renderNodes(child.nodes, depth + 1))
      }
    }
    return out
  }, [children, expanded, filter, openNode, scope, toggle])

  const top = tree?.roots[0]?.nodes ?? []
  /** 过滤后的顶层（`renderNodes` 内部对每一层应用同一条规则）。 */
  const shown = renderNodes(top, 0)
  const totalFiles = top.filter((n) => !n.directory).length
  const totalDirs = top.filter((n) => n.directory).length

  const listCard = h(Card, null,
    h(CardTitle, {
      title: '知识库',
      note: tree === null ? '按需展开：点文件夹才拉它的下一层'
        : `顶层 ${tree.total} 项（文件夹 ${totalDirs} / 文件 ${totalFiles}）· 缓存根 ${tree.cacheRoot}`,
      right: h('span', { style: { marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' } },
        h('input', {
          type: 'search',
          value: filter,
          placeholder: '按文件名过滤（只过滤已展开的层）',
          'aria-label': '知识库节点过滤',
          style: { width: 200, padding: '2px 6px', borderRadius: 5, border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'inherit', fontSize: 12 },
          onChange: (e: { target?: { value?: string } }) => setFilter(e?.target?.value ?? ''),
        }),
        h(Segmented, {
          options: [
            { key: 'project', label: '本项目' },
            { key: 'common', label: '公共知识库' },
          ],
          value: scope,
          onChange: (key) => setScope(key === 'common' ? 'common' : 'project'),
          disabled: programId === null,
        }),
        h('button', {
          type: 'button',
          className: css.gqVSegBtn,
          style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 5 },
          disabled: cacheBusy,
          title: '清掉当前范围的全部附件缓存（不动 Gitee 上的东西，下次点击会重新下载）',
          onClick: () => void clearCache({ kind: 'scope' }),
        }, '清本范围缓存'),
        h('button', {
          type: 'button',
          className: css.gqVSegBtn,
          style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 5 },
          onClick: () => void loadRoot(),
        }, '刷新'),
      ),
    }),
    // 缓存用量：附件与仓库 WIKI **分开报** —— 两套语义，合起来会误导
    // （清掉附件腾不出仓库 WIKI 那份空间）。
    cache === null
      ? null
      : h(Note, null,
          `缓存：附件 ${cache.attachments.count} 个 / ${human(cache.attachments.bytes)}`
          + ` · 仓库 WIKI ${cache.wikis.count} 个文件 / ${human(cache.wikis.bytes)}`
          + ` · 根目录 ${cache.cacheRoot}`
          + (cache.truncated ? '（数量太大，统计已截断）' : '')),
    cacheNote !== ''
      ? h(Note, null, h('span', { className: css.gqVDim }, cacheNote))
      : null,
    programId === null && scope === 'project'
      ? h(Note, null, '当前没有选中项目，已切到「公共知识库」。')
      : null,
    tree !== null && tree.notice !== undefined
      ? h(Note, null, h('span', { className: css.gqVWarn }, tree.notice))
      : null,
    phase === 'loading'
      ? h(Empty, null, '正在拉取知识库结构…')
      : phase === 'error'
        ? h(ErrorState, { message: '知识库结构加载失败', detail: error, onRetry: () => void loadRoot() })
        : top.length === 0
          ? h(Empty, null, scope === 'common' ? '企业级公共知识库暂无内容' : '本项目知识库暂无内容')
          : shown.length === 0
            // 与"真没有内容"分开说 —— 否则使用者会以为库里是空的
            ? h(Empty, null, `没有匹配「${filter}」的文件（本层共 ${top.length} 项）。过滤只作用于已展开的层。`)
            : h('div', { className: css.gqVNavScroll, style: { maxHeight: 460 } }, shown),
  )

  const detailCard = h(Card, null,
    h(CardTitle, { title: selected === null ? '节点信息' : selected.name, note: selected === null ? '左侧点选一个节点' : typeLabel(selected.fileType) }),
    selected === null
      ? h(Empty, null, '左侧选择文件或文件夹')
      : h('div', null,
          h(StatGrid, null,
            h(Stat, { label: '节点 id', value: selected.nodeId }),
            h(Stat, { label: '类型', value: typeLabel(selected.fileType) }),
            h(Stat, { label: '扩展名', value: selected.ext === '' ? '—' : `.${selected.ext}` }),
            h(Stat, { label: '所属项目', value: selected.programId === null ? '企业级' : String(selected.programId) }),
          ),
          h('div', { className: css.gqVFields },
            h('div', { className: css.gqVFieldLabel }, '知识库路径'),
            h('div', { className: css.gqVFieldValue }, selected.filePath || '—'),
            h('div', { className: css.gqVFieldLabel }, '更新时间'),
            h('div', { className: css.gqVFieldValue }, selected.updatedAt || '—'),
          ),
          selected.directory
            ? h(Note, null, '这是文件夹。点它展开下一层（只拉这一层，不做全量遍历）。')
            : selected.readable
              ? h('div', null,
                  reading ? h(Empty, null, '正在读取并缓存到本地…') : null,
                  readError !== '' ? h(ErrorState, { message: '读取失败', detail: readError, onRetry: () => void readAttachment(selected) }) : null,
                  delegated
                    ? h(Note, null,
                        '已在**侧边栏**打开：',
                        h('code', null, delegatedPath),
                        h('br'),
                        '本插件不再自己渲染预览 —— 用什么方式显示由侧边栏的预览器决定。',
                        attachment === null ? null : h('br'),
                        attachment === null ? null : `本地缓存：${attachment.savedPath}（${(attachment.bytes / 1024).toFixed(1)} KB）`,
                        h('br'),
                        h('span', { className: css.gqVDim },
                          '若侧边栏提示"路径在工作区之外"，那是它的**文件围栏**（默认开）在拦 —— 按它给的按钮关掉即可。'))
                    : attachment === null
                      ? (reading ? null : h(Note, null,
                          sidebarAvailable()
                            ? '点这一行即可读取：文件会缓存到本地，然后**在侧边栏打开**。'
                            : '点这一行即可读取内容，文件会缓存到本地知识库目录（本插件只内联预览 .md）。'))
                      : h('div', null,
                          h(Note, null,
                            `已缓存到 ${attachment.savedPath}（${(attachment.bytes / 1024).toFixed(1)} KB）`,
                            h('br'),
                            attachment.fromCache
                              ? h('span', { className: css.gqVDim }, '本次**直接读的本地缓存**，没有重新下载。')
                              : h('span', { className: css.gqVDim }, '本次是新下载并写入缓存的。')),
                          // 远端已更新：**只提示，不自动覆盖** —— 附件不可变，
                          // 要不要用新版由人决定。
                          attachment.state === 'remote-ahead'
                            ? h(Note, null,
                                h('span', { className: css.gqVWarn }, '⚠ 远端这份已更新（本地还是旧的）。'),
                                h('button', {
                                  type: 'button',
                                  className: css.gqVSegBtn,
                                  style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 5, marginLeft: 8 },
                                  onClick: () => { if (selected !== null) void readAttachment(selected, true) },
                                }, '重新拉取'),
                              )
                            : null,
                          h(Note, null,
                            h('button', {
                              type: 'button',
                              className: css.gqVSegBtn,
                              style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 5 },
                              disabled: cacheBusy,
                              title: '删掉这一份的本地缓存（不动 Gitee 上的东西，下次点击会重新下载）',
                              onClick: () => { if (selected !== null) void clearCache({ kind: 'attachment', node: selected }) },
                            }, '清缓存')),
                          // 没交给侧边栏时**必须说明是哪一种**：没装 vs 调用了但被拒。
                          // 这两种的处置完全不同，含糊其辞会让下一个人白查半天。
                          sidebarAvailable()
                            ? h(Note, null, h('span', { className: css.gqVWarn },
                                '已检测到侧边栏，但这次没能把文件交给它（见下面的缓存路径，可直接用别的工具打开）。'))
                            : null,
                          INLINE_PREVIEW_EXT.has(attachment.ext)
                            ? h('div', { className: css.gqVMd, style: { maxHeight: 420, overflow: 'auto', marginTop: 6 } },
                                h(Markdown, { text: attachment.content ?? '' }))
                            : h(Note, null, h('span', { className: css.gqVWarn },
                                `本插件不预览 .${attachment.ext || '未知'} 类型。`
                                + (sidebarAvailable()
                                  ? ''
                                  : '装 `dsh-better-sidebar` 后，点击即由侧边栏的预览器打开。'))),
                          attachment.truncated ? h(Note, null, h('span', { className: css.gqVWarn }, '⚠ 正文超长已截断显示。')) : null,
                        ),
                )
              : h(Note, null, h('span', { className: css.gqVWarn },
                  '⚠ 内容暂不可读。',
                  selected.unreadableReason ?? '',
                )),
        ),
  )

  return h('div', null,
    h(Note, null,
      `本企业知识库是「文件夹 + 上传附件」的形态（DocDirectory / AttachFile），不是 WikiInfo 文档 —— `
      + `所以这里列的是**节点树**，按需展开。当前范围：${scope === 'common' ? '企业级公共知识库' : `项目「${programName || programId}」`}。`,
      h('br'),
      sidebarAvailable()
        ? '预览分工：点文件 → 交给**侧边栏**（dsh-better-sidebar）打开，用什么方式显示取决于它的预览器。'
        : '预览分工：本插件只内联预览 **.md**；装 `dsh-better-sidebar` 后，其它类型（图片 / PDF / Office…）由它打开。',
    ),
    h('div', { className: css.gqVCols },
      h('div', { className: css.gqVCol, style: { flex: '0 1 420px' } }, listCard),
      h('div', { className: css.gqVCol }, detailCard),
    ),
  )
}
