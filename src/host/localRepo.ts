/**
 * 本地仓库比对（AI 起草 PR 的**快路径**）。
 *
 * 为什么要有它：起草的输入是「源分支 vs 目标分支的提交与文件差异」。走远端要
 * 一来一回 HTTP（实测 0.6–1.2 s，还要传 `--patches`），而这段差异在**用户本机
 * 的克隆里本来就有**。所以先看会话工作目录里有没有这个仓库的克隆：
 *
 * - 有 → `git merge-base` + `git log` + `git diff`，纯本地、毫秒级，且能拿到完整
 *   diff（远端 compare 为了省流量会截断 patch）。
 * - 没有（或分支在本地不存在，比如刚 push 完还没 fetch）→ 回落远端 `compare`。
 *
 * 边界：**只读本地已有的 ref，绝不 `git fetch`**。取数是面板点按钮的同步路径，
 * 联网拉取会让「点一下」变成不可控的长等待；远端兜底已经覆盖了「本地没有」的情况。
 *
 * @module dsh-gitee-chat/host/localRepo
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 一次本地比对的结果（字段与远端 `compare` 对齐，调用方可直接替换）。 */
export interface LocalCompare {
  commits: Array<{ shortId: string; title: string; author: string }>
  diffs: Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }>
  tooManyCommits: boolean
}

/** git 调用上限：本地命令正常都在 100 ms 内，超时说明仓库异常，直接放弃快路径。 */
const GIT_TIMEOUT_MS = 4000
/** 单个文件 patch 最多塞多少字符（避免超长自动生成文件把 prompt 撑爆）。 */
const PATCH_LIMIT = 4000
/** 最多给几个文件附 diff（与远端路径保持一致）。 */
const PATCH_FILES = 8

/** 跑一条 git 命令，失败返回 `undefined`（快路径失败要静默回落，不能抛）。 */
function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }
}

/** 判断某个目录是不是 git 仓库工作区根。 */
function isRepoRoot(dir: string): boolean {
  try {
    return existsSync(join(dir, '.git')) && statSync(join(dir, '.git')).isDirectory()
  } catch {
    return false
  }
}

/** 该仓库的 origin 地址（没有 remote 返回空串）。 */
function originOf(root: string): string {
  return (git(root, ['config', '--get', 'remote.origin.url']) ?? '').trim()
}

/**
 * 在会话工作目录里找这个仓库的本地克隆。
 *
 * 查找顺序：目录本身 → 一级子目录 → 二级子目录。够了：使用者的仓库通常就是
 * 会话目录，或在 `~/…/项目/仓库名` 这种一层结构下。深挖会拖慢每次点按钮。
 *
 * @param cwd - 会话工作目录（宿主给的真实路径）。
 * @param repoPath - Gitee 的 `path_with_namespace`（如 `group/repo`）。
 * @returns 命中的仓库根目录；没命中返回 `undefined`。
 */
export function findLocalRepo(cwd: string, repoPath: string): string | undefined {
  const want = repoPath.trim().toLowerCase()
  if (cwd === '' || want === '') return undefined
  const candidates: string[] = []
  const push = (dir: string): void => {
    if (isRepoRoot(dir)) candidates.push(dir)
  }
  push(cwd)
  let level1: string[] = []
  try {
    level1 = readdirSync(cwd, { withFileTypes: true })
      .filter((item) => item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules')
      .map((item) => join(cwd, item.name))
  } catch {
    level1 = []
  }
  for (const dir of level1) {
    push(dir)
    if (candidates.length === 0) continue
  }
  // 一级没命中才扫二级（多一层遍历，只在需要时付代价）
  if (candidates.length === 0) {
    for (const dir of level1) {
      let level2: string[] = []
      try {
        level2 = readdirSync(dir, { withFileTypes: true })
          .filter((item) => item.isDirectory() && !item.name.startsWith('.') && item.name !== 'node_modules')
          .map((item) => join(dir, item.name))
      } catch {
        level2 = []
      }
      for (const sub of level2) push(sub)
    }
  }
  for (const root of candidates) {
    if (originOf(root).toLowerCase().includes(want)) return root
  }
  return undefined
}

/** 解析一个分支名到可用 ref（本地没有就试 `origin/<name>`）。 */
function resolveRef(root: string, branch: string): string | undefined {
  const local = git(root, ['rev-parse', '--verify', '--quiet', `${branch}^{commit}`])
  if (local !== undefined && local.trim() !== '') return branch
  const remote = git(root, ['rev-parse', '--verify', '--quiet', `origin/${branch}^{commit}`])
  if (remote !== undefined && remote.trim() !== '') return `origin/${branch}`
  return undefined
}

/**
 * 用本地 git 比对两个分支（等价于远端 compare 的三点语义）。
 *
 * @param root - 仓库根目录。
 * @param targetBranch - 目标分支（合入方）。
 * @param sourceBranch - 源分支（开发分支）。
 * @returns 比对结果；任何一步失败（分支不存在、仓库损坏）返回 `undefined`，由调用方回落远端。
 */
export function localCompare(root: string, targetBranch: string, sourceBranch: string): LocalCompare | undefined {
  const target = resolveRef(root, targetBranch)
  const source = resolveRef(root, sourceBranch)
  if (target === undefined || source === undefined) return undefined
  const base = git(root, ['merge-base', target, source])
  if (base === undefined || base.trim() === '') return undefined
  const baseRef = base.trim()

  // 提交：与远端一致的 `短 id · 作者 · 标题`，最多 30 条（超出标记 tooManyCommits）
  const logText = git(root, ['log', '--format=%h%x1f%an%x1f%s', `${baseRef}..${source}`, '-n', '51'])
  if (logText === undefined) return undefined
  const commitRows = logText.split('\n').filter((line) => line.trim() !== '')
  const tooManyCommits = commitRows.length > 30
  const commits = commitRows.slice(0, 30).map((line) => {
    const [shortId = '', author = '', title = ''] = line.split('\x1f')
    return { shortId, title, author }
  })

  // 文件清单：name-status 给状态，numstat 给增删行数（两次输出行序一致，按文件名对齐更稳）
  const statusText = git(root, ['diff', '--name-status', `${baseRef}..${source}`]) ?? ''
  const numstatText = git(root, ['diff', '--numstat', `${baseRef}..${source}`]) ?? ''
  const numByFile = new Map<string, { additions: number; deletions: number }>()
  for (const line of numstatText.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const additions = Number(parts[0])
    const deletions = Number(parts[1])
    numByFile.set(parts[2] ?? '', {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    })
  }
  const statusName: Record<string, string> = { A: 'added', M: 'modified', D: 'removed', R: 'renamed', C: 'copied' }
  const files: Array<{ filename: string; status: string; additions: number; deletions: number }> = []
  for (const line of statusText.split('\n')) {
    if (line.trim() === '') continue
    const parts = line.split('\t')
    const code = (parts[0] ?? '').charAt(0).toUpperCase()
    const filename = parts[parts.length - 1] ?? ''
    if (filename === '') continue
    const num = numByFile.get(filename) ?? { additions: 0, deletions: 0 }
    files.push({ filename, status: statusName[code] ?? 'modified', ...num })
  }

  // 只给前 8 个文件附 diff，每个截断（与远端 compare 的策略一致）
  const diffs = files.map((file) => ({ ...file, patch: '' }))
  for (let index = 0; index < Math.min(PATCH_FILES, diffs.length); index += 1) {
    const file = diffs[index]
    if (file === undefined) continue
    const patch = git(root, ['diff', '--unified=3', `${baseRef}..${source}`, '--', file.filename])
    if (patch === undefined) continue
    file.patch = patch.length > PATCH_LIMIT ? `${patch.slice(0, PATCH_LIMIT)}\n…（截断）` : patch
  }

  return { commits, diffs, tooManyCommits }
}
