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
 * 另有一个实测约束：侧边栏的文件围栏按**会话 cwd** 判定，
 * 缓存根在工作区之外，所以这里必须传**工作区软链接下**的路径
 * （host 在响应里给的 `workspacePath`），传缓存绝对路径会被 403 拒。
 *
 * @module dsh-gitee-chat/client/sidebar
 */
/** client 上下文的取服务那一小块。 */
interface GetterLike {
    get?: (name: string) => unknown;
}
/**
 * 在 client `apply` 里绑定上下文。
 *
 * 只存引用、**不解析服务** —— 理由见上面关于加载顺序的说明。
 * @param ctx - 浏览器侧 cordis 上下文。
 */
export declare function bindSidebar(ctx: GetterLike): void;
/** 侧边栏是否可用（装了 **且** 支持 `openFile`）。 */
export declare function sidebarAvailable(): boolean;
/**
 * 在侧边栏里打开一个文件。
 *
 * @param sessionId - 当前会话 id（侧边栏按会话存 tab 状态）。
 * @param path - 绝对路径。**优先传工作区软链接下的路径**：缓存根在会话工作区之外，
 *   而侧边栏的文件围栏按会话 cwd 判定，传缓存真实路径在围栏开着时会被 403 拒。
 * @param title - 可选标题（缺省用文件名）。
 * @returns 是否真的交给了侧边栏（false = 调用方该走自己的 .md 预览）。
 */
export declare function sidebarOpenFile(sessionId: string, path: string, title?: string): boolean;
export {};
