#!/usr/bin/env node
/**
 * 类型声明**生成 + 一致性**守卫。
 *
 * 为什么要有它：对外类型声明不再手写，而是由 `tsc -p tsconfig.types.json`（`--emitDeclarationOnly`）
 * 从 `src/` 生成到 `types/`。tsc 的产物是确定的，所以「生成后工作区仍然干净」就等于
 * 「types/ 与 src/ 同步」——改了源码却忘了重新生成，这里就会红。
 *
 * 用法：
 *   node scripts/check-types.mjs          重新生成 types/，不校验（= pnpm run types:gen）
 *   node scripts/check-types.mjs --check  重新生成后再要求 git 干净，否则非 0 退出（挂进 pnpm run check / prepublishOnly）
 */

import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const check = process.argv.includes('--check')

/** 定位 tsc：走包解析，不依赖 PATH，也不依赖平台上的 .bin 后缀。 */
const require = createRequire(import.meta.url)
const tsc = require.resolve('typescript/bin/tsc')

const typesDir = join(root, 'types')
rmSync(typesDir, { recursive: true, force: true })

const run = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.types.json'], {
  cwd: root,
  stdio: 'inherit',
})
if (run.status !== 0) {
  console.error('类型声明生成失败（tsc 非 0 退出）')
  process.exit(run.status ?? 1)
}

if (!check) {
  console.log('类型声明已重新生成到 types/ ✅')
  process.exit(0)
}

// 与「暂存内容」比对：重新生成后工作区应与 index 一致、且没有未跟踪文件。
// （用 git diff 而不是 git status：后者会把尚未提交的暂存改动也算脏，本地开发会误报。）
const diff = spawnSync('git', ['diff', '--quiet', '--', 'types'], { cwd: root })
if (diff.status !== 0) {
  console.error('types/ 与暂存内容不一致 —— 源码改了就要重新生成并提交：')
  spawnSync('git', ['--no-pager', 'diff', '--stat', '--', 'types'], { cwd: root, stdio: 'inherit' })
  console.error('跑 `npm run types:gen` 重新生成，再 git add types 后一并提交。')
  process.exit(1)
}
const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'types'], {
  cwd: root,
  encoding: 'utf8',
})
if (untracked.status !== 0 || untracked.stdout.trim() !== '') {
  console.error('types/ 有未跟踪的生成文件 —— 生成后要 git add：')
  console.error(untracked.stdout)
  process.exit(1)
}
console.log('类型声明与源码一致（tsc 生成结果无 diff）✅')
