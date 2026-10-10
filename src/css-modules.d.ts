/**
 * 构建期由 build.mjs 的 CSS-inline 插件把 *.module.css 变成 { 类名映射, CSS_TEXT }；
 * 这份环境声明让 tsc 在生成类型时能解析这类导入。
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
  export const CSS_TEXT: string
}
