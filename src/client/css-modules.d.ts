/**
 * CSS Modules 的类型声明（仅类型检查用，不影响构建）。
 *
 * 构建时由 `build.mjs` 的 css-inline 插件把 `*.module.css` 换成
 * `{ 默认导出: 类名映射, CSS_TEXT: 打包后的样式文本 }`；TypeScript 看不到那层
 * 代码，所以在这里声明一次，`tsc --noEmit` 才不会把 CSS 导入报成"模块不存在"。
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
  /** 打包后的样式文本（由 `index.tsx` 注入 `<style>`）。 */
  export const CSS_TEXT: string
}
