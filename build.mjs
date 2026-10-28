// dsh-gitee-chat 构建脚本：host 半 + client 半。
//
//   lib/index.js   ← src/index.ts          host（profile）：执行器 + 路由 + 发布 giteeChat 服务
//   lib/agent.js   ← src/agent.ts          agent（preset）：工具 + 人格注入 + 门禁
//   lib/client.js  ← src/client/index.tsx  client：ModuleLoader 格式看板卡片
//
// ⚠️ host 与 agent 必须分开打包：它们的挂载平面不同，混在一起会让
//    host 半的注册泄漏到所有 preset（曾导致 PTC 会话被注入 Gitee 人格）。
//
// 关键坑（沿用已验证的 dsh-gitee-pj 配方，勿改）：
//  1. client 必须 `format: 'cjs'` + esbuild **原生** external（react / react-dom /
//     react/jsx-runtime / @deepseek-ai/*）。自定义 namespace 插件会把 require 再包一层，
//     生成循环引用，导致 __ModuleLoader__ 解析失败。
//  2. client 必须 `jsx: 'automatic'`：宿主前端不暴露全局 React，
//     classic runtime 会在渲染时抛 `React is not defined`。
//  3. CSS Modules 内联为「类名映射 + 样式文本」，类名加前缀隔离；
//     样式文本由 client 代码注入 <style>。
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile, unlink } from 'node:fs/promises'

const PKG_ID = 'dsh-gitee-chat'
const PREFIX = 'GiteeChat_'

/** CSS Modules 内联插件：`.module.css` → { 类名映射, CSS_TEXT }。 */
const cssInlinePlugin = {
  name: 'css-inline',
  setup(build) {
    build.onLoad({ filter: /\.module\.css$/ }, async (args) => {
      const css = await readFile(args.path, 'utf8')
      const keys = [...new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))]
      const map = Object.fromEntries(keys.map((k) => [k, `${PREFIX}${k}`]))
      const prefixed = css.replace(/\.([a-zA-Z][\w-]*)/g, (_m, name) => `.${PREFIX}${name}`)
      return {
        contents: `export default ${JSON.stringify(map)}\nexport const CSS_TEXT = ${JSON.stringify(prefixed)}\n`,
        loader: 'js',
      }
    })
  },
}

// 1) host 半与 agent 半（同一套 external 规则；两者不共享运行时模块）
for (const [entry, outfile] of [['src/index.ts', 'lib/index.js'], ['src/agent.ts', 'lib/agent.js']]) {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    outfile,
    external: ['@deepseek-ai/*', 'node:*'],
    sourcemap: true,
    logLevel: 'info',
  })
}

// 2) client 半（先出裸模块体，再包 ModuleLoader 注册）
await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  outfile: 'lib/client.tmp.js',
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
  plugins: [cssInlinePlugin],
  write: true,
  sourcemap: false,
  minify: false,
  logLevel: 'info',
})

const body = await readFile('lib/client.tmp.js', 'utf8')
const wrapped = `window.__ModuleLoader__.load({
  id: "${PKG_ID}",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
    return module.exports;
  }
});
`
await writeFile('lib/client.js', wrapped)
await unlink('lib/client.tmp.js')

// 对外类型声明：按 DSH 官方包约定落在 lib/types/，随 lib 一起发布（files 只发 lib）。
const types = spawnSync(process.execPath, ['scripts/check-types.mjs'], { stdio: 'inherit' })
if (types.status !== 0) process.exit(types.status ?? 1)

console.log(`[${PKG_ID}] built: lib/index.js + lib/client.js + lib/types/`)
