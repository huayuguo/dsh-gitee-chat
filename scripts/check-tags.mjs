#!/usr/bin/env node
/**
 * 两条发布线的「等位」断言。
 *
 * 背景（AGENTS.md §3）：内部线（Gitee）与外部线（GitHub）没有共同祖先，
 * 发布物只能靠**内容对齐**，不靠 merge。这个脚本把「对齐」变成可执行断言：
 *
 *   1. 白名单里的每个路径，两边 git blob 必须逐字节相同；
 *   2. `package.json` 允许不同，但**归一化之后**必须相同——
 *      只允许这几个字段有差异：repository / homepage / bugs / publishConfig /
 *      packageManager / icon / devDependencies / files / version 之外的发布目标信息；
 *   3. `release-manifest.json` 里记录的内部提交必须真的存在于内部线。
 *
 * 用法：
 *   node scripts/check-tags.mjs                  # 用 manifest 里的 ref
 *   node scripts/check-tags.mjs dev/win HEAD     # 指定两边 ref
 * 退出码：0 = 等位；1 = 不等位（逐条打印差异）。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifestPath = join(root, 'release-manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

const internalRef = process.argv[2] ?? manifest.internal.ref
const externalRef = process.argv[3] ?? 'HEAD'

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
const blobOf = (ref, path) => {
  try {
    return git('rev-parse', `${ref}:${path}`).trim()
  } catch {
    return null
  }
}

// 必须逐字节相同的路径（发布物里两边一样的部分）
const SAME_PATHS = manifest.samePaths
// package.json 允许不同的顶层字段（对外仓库地址、发布目标、锁的包管理器等）
const PKG_ALLOWED = new Set(manifest.packageJsonAllowedDifferences)

const problems = []

// ① 白名单文件逐字节比对
let checked = 0
for (const path of SAME_PATHS) {
  const isDir = path.endsWith('/')
  if (isDir) {
    const list = (ref) =>
      git('ls-tree', '-r', '--name-only', `${ref}:${path.replace(/\/$/, '')}`)
        .split('\n')
        .filter(Boolean)
    let left
    let right
    try {
      left = list(internalRef)
    } catch {
      problems.push(`${path} 在 ${internalRef} 不存在`)
      continue
    }
    try {
      right = list(externalRef)
    } catch {
      problems.push(`${path} 在 ${externalRef} 不存在`)
      continue
    }
    const leftSet = new Set(left)
    const rightSet = new Set(right)
    for (const f of leftSet) {
      if (!rightSet.has(f)) problems.push(`${path}${f}：只在 ${internalRef} 有`)
      else if (blobOf(internalRef, `${path}${f}`) !== blobOf(externalRef, `${path}${f}`)) {
        problems.push(`${path}${f}：两边内容不同`)
      }
      checked++
    }
    for (const f of rightSet) {
      if (!leftSet.has(f)) problems.push(`${path}${f}：只在 ${externalRef} 有`)
    }
  } else {
    const l = blobOf(internalRef, path)
    const r = blobOf(externalRef, path)
    if (l === null) problems.push(`${path} 在 ${internalRef} 不存在`)
    else if (r === null) problems.push(`${path} 在 ${externalRef} 不存在`)
    else if (l !== r) problems.push(`${path}：两边内容不同`)
    checked++
  }
}

// ② package.json 归一化比对
const readPkg = (ref) => JSON.parse(git('show', `${ref}:package.json`))
const norm = (pkg) =>
  Object.fromEntries(Object.entries(pkg).filter(([k]) => !PKG_ALLOWED.has(k)))
const li = norm(readPkg(internalRef))
const le = norm(readPkg(externalRef))
for (const key of new Set([...Object.keys(li), ...Object.keys(le)])) {
  const a = JSON.stringify(li[key] ?? null)
  const b = JSON.stringify(le[key] ?? null)
  if (a !== b) problems.push(`package.json 的 ${key}：${a} ≠ ${b}`)
}

// ③ manifest 里的内部提交确实存在
try {
  git('cat-file', '-e', `${manifest.internal.commit}^{commit}`)
} catch {
  problems.push(`manifest 记录的内部提交 ${manifest.internal.commit} 不存在于本仓`)
}

if (problems.length) {
  console.error(`两条线不等位（${internalRef} vs ${externalRef}）：`)
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}
console.log(`等位 ✓（${internalRef} vs ${externalRef}：${checked} 个路径逐字节相同，package.json 归一化后相同）`)
