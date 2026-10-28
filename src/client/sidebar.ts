/**
 * 侧边栏（`dsh-better-sidebar`）桥接 —— client 半。
 *
 * ## 这一层的职责只有一句话
 *
 * **把"打开一个本地文件"这件事交给侧边栏去做，而不是自己做预览器。**
 *
 * 需求原话：「当前的开发的插件只预览 .md 即可，如果检测到侧边栏就调用侧边栏，
 * 如果没有就只提供 .md 预览」。也就是：
 *
 *   - 检测到侧边栏 → 一律交给它（它内置 image / pdf / markdown / html / code /
 *     binary-download 六个 viewer，且允许别的插件再注册 —— 支持哪些类型是**它的能力**，
 *     不是我们要复制一遍的东西）；
 *   - 检测不到 → 本插件自己内联预览 `.md`，其余只给落盘路径。
 *
 * ## 为什么不直接 import 它的类型/模块
 *
 * 它是**可选**依赖：没装侧边栏时这个插件必须照常工作。所以：
 *   - 只从 client 上下文里**取服务**（`ctx.get('betterSidebar')`），不做 value import；
 *   - 用能力位 `features.includes('openFile')` 判可用性（v0.12.0+ 的单调能力清单），
 *     而不是比版本号字符串 —— 老版本没有这个方法时优雅降级成"只能 .md"。
 *
 * 另有一个实测约束（DOCS.md §14.2）：侧边栏的文件围栏按**会话 cwd** 判定，
 * 缓存根在工作区之外，所以这里必须传**工作区软链接下**的路径
 * （host 在响应里给的 `workspacePath`），传缓存绝对路径会被 403 拒。
 *
 * @module dsh-gitee-chat/client/sidebar
 */

/** 侧边栏服务里我们用到的那一小块（duck type，不 import 它的类型）。 */
interface BetterSidebarLike {
  readonly features?: readonly string[]
  openFile?: (scope: { sessionId: string; cwd?: string }, path: string, title?: string) => void
}

/** client 上下文的取服务那一小块。 */
interface GetterLike {
  get?: (name: string) => unknown
}

/**
 * 保存的是 **ctx 本身**，不是当时取到的服务。
 *
 * ⚠️ 这是踩过的坑：早先在 `apply` 里取一次 `ctx.get('betterSidebar')` 存下来。
 * 而客户端插件是**各自独立加载**的（不保证按 profile 里 bundles 的顺序求值），
 * 我们完全可能先于侧边栏注册 —— 那一次取到 `undefined`，于是整个会话生命周期里
 * 都认定"没有侧边栏"，点文件全部回落到只预览 `.md`。
 *
 * 服务是**活**的：每次要用时现取。谁先加载都能拿到，侧边栏后装/禁用/换提供方
 * 也自动跟着变。
 */
let context: GetterLike | undefined

/**
 * 在 client `apply` 里绑定上下文。
 *
 * 只存引用、**不解析服务** —— 理由见上面关于加载顺序的说明。
 * @param ctx - 浏览器侧 cordis 上下文。
 */
export function bindSidebar(ctx: GetterLike): void {
  context = ctx
}

/** 现取侧边栏服务（没装 / 还没注册 / 被别的提供方接管时返回 undefined）。 */
function service(): BetterSidebarLike | undefined {
  try {
    const found = context?.get?.('betterSidebar')
    return typeof found === 'object' && found !== null ? (found as BetterSidebarLike) : undefined
  } catch {
    return undefined
  }
}

/** 侧边栏是否可用（装了 **且** 支持 `openFile`）。 */
export function sidebarAvailable(): boolean {
  const s = service()
  if (s === undefined || typeof s.openFile !== 'function') return false
  // features 缺失时按"支持"处理：v0.12.0 之前没有这个数组，但也没有 openFile。
  // 上面那行已经挡住了没有 openFile 的情况，所以这里只在有数组时才检查。
  return s.features === undefined ? true : s.features.includes('openFile')
}

/**
 * 在侧边栏里打开一个文件。
 *
 * @param sessionId - 当前会话 id（侧边栏按会话存 tab 状态）。
 * @param path - 绝对路径。**优先传工作区软链接下的路径**：缓存根在会话工作区之外，
 *   而侧边栏的文件围栏按会话 cwd 判定，传缓存真实路径在围栏开着时会被 403 拒。
 * @param title - 可选标题（缺省用文件名）。
 * @returns 是否真的交给了侧边栏（false = 调用方该走自己的 .md 预览）。
 */
export function sidebarOpenFile(sessionId: string, path: string, title?: string): boolean {
  const s = service()
  if (path === '' || s === undefined || typeof s.openFile !== 'function') return false
  try {
    s.openFile({ sessionId }, path, title)
    return true
  } catch {
    return false
  }
}
