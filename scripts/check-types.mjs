#!/usr/bin/env node
/**
 * 对外类型声明生成（按 DSH 官方包约定：声明产物落在 `lib/types/`，随 `lib` 一起发）。
 *
 *   node scripts/check-types.mjs           # 生成到 lib/types/（build 与 prepare 会调用）
 *   node scripts/check-types.mjs --check   # 生成后自检：入口齐全、没有泄漏 src/ 相对路径
 *
 * 为什么不再「生成结果与 git 比对」：`lib/` 本来就是不入库的构建产物（与官方包一致，
 * `files` 只发 `lib`），类型声明跟着 lib 走，没必要在仓库里另存一份。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'lib', 'types')
const check = process.argv.includes('--check')

/** 定位 tsc：走包解析，不依赖 PATH，也不依赖平台上的 .bin 后缀。 */
const require = createRequire(join(root, 'package.json'))
let tsc
try {
  tsc = require.resolve('typescript/bin/tsc')
} catch {
  console.error('找不到 typescript —— 先 `npm install`（devDependencies 里有 typescript）')
  process.exit(1)
}

rmSync(outDir, { recursive: true, force: true })

const run = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.types.json'], {
  cwd: root,
  stdio: 'inherit',
})
if (run.status !== 0) {
  console.error('类型声明生成失败（tsc 非 0 退出）')
  process.exit(run.status ?? 1)
}

// ① 对外入口必须齐：exports 里声明了 types 的，就得真产出这个文件
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const declared = []
for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
  if (typeof target === 'object' && target !== null && target.types) {
    declared.push([sub, target.types])
  }
}
for (const [sub, rel] of declared) {
  if (!existsSync(join(root, rel))) {
    console.error(`✗ exports["${sub}"].types 指向 ${rel}，但 tsc 没产出它`)
    process.exit(1)
  }
}

// ② 声明文件里不能出现指回 src/ 的相对路径（那说明产物依赖了未发布的源码）
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? walk(p) : [p]
  })
const files = existsSync(outDir) ? walk(outDir) : []
const leaked = files.filter((f) => /from\s+['"][^'"]*\/src\//.test(readFileSync(f, 'utf8')))
if (leaked.length > 0) {
  console.error(
    `✗ 以下声明文件引用了 src/ 路径（发布后不存在）：\n${leaked
      .map((f) => `  ${f.slice(root.length + 1)}`)
      .join('\n')}`,
  )
  process.exit(1)
}

const bytes = files.reduce((n, f) => n + statSync(f).size, 0)
const label = `lib/types：${files.length} 个 .d.ts · ${(bytes / 1024).toFixed(0)} KB`
console.log(
  check ? `类型声明自检通过 ✅（${label}；入口 ${declared.length} 个）` : `类型声明已生成 ✅（${label}）`,
)
