/**
 * dsh-gitee-chat · client 半。
 *
 * 唯一职责：把 `gitee_board` 这个工具的调用卡片，替换成会话内的看板渲染器。
 *
 * 为什么用 `tool.call.toolview`：它的 key 就是**线上工具名**，key 域是开放的
 * （已占用的只有 15 个内置工具），所以为自定义工具注册卡片是增量行为，
 * 不会影响任何既有 UI；而不注册时该工具自动回落到通用卡片。
 *
 * 注意（与官方配方一致）：本文件被 esbuild 打成 CJS + ModuleLoader 包装，
 * 不能用 JSX 之外的全局，React 必须从 require('react') 取。
 *
 * @module dsh-gitee-chat/client
 */
/**
 * 本行依赖的 client 行（**服务依赖声明**，不是 npm 依赖）。
 *
 * `slots` 服务由 `@deepseek-ai/dsh-client-ui-renderer` 提供；声明在这里，
 * 装载器才会先把它物化出来 —— 否则我们只会在下面 `ctx.get('slots')` 拿到
 * `undefined` 然后静默消失（卡片不渲染、还没有日志）。
 */
export declare const inject: string[];
/**
 * 客户端插件主体：注册看板卡片渲染器。
 * @param ctx - 浏览器侧 cordis 上下文。
 */
export declare function apply(ctx: any): void;
