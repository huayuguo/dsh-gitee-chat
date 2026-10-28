#!/usr/bin/env node
// 双线对等检查（parity）+ 对外发布必须能力检查（--pack）。
//
// 为什么需要它：本仓维护两条线——内部开发线（dev/win）与对外发布线（release/*）。
// 两条线**不是** merge/cherry-pick 关系，而是按文件重放；历史上一旦有人只改一边，
// 就会出现「npm 上的包和内部跑的不是一份东西」。这个脚本把「只允许在哪里分叉」写成断言：
//
//   1) 文件集必须相同（`scripts/` 尤其必须逐字节相同）；
//   2) README.md / README.en.md 只允许 `<!-- parity:install:begin/end -->` 之间不同；
//   3) package.json 只允许 repository / homepage / bugs 三个字段不同；
//   4) release-manifest.json 只允许 line / ref / tag 不同；
//   5) 其余文件逐字节相同。
//
// 用法：
//   node scripts/check-parity.mjs                       # 当前分支 vs 内部线
//   node scripts/check-parity.mjs --base dev/win --other release/0.5.4
//   node scripts/check-parity.mjs --pack                # 再校验 npm 包内容（必须项/禁止项/元数据）
//   --allow-missing-other   另一条线不可用（例如 CI 只 checkout 了发布线）时跳过对等检查
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const ALLOW_MISSING = has('--allow-missing-other')
const OTHER = opt('--other', 'release/0.5.4')
const BASE = opt('--base', 'dev/win')

const problems = []
const notes = []
const fail = (msg) => problems.push(msg)
const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()
const gitOk = (...a) => {
  try {
    return git(...a)
  } catch {
    return null
  }
}

// ---- 工具 -------------------------------------------------------------------
function refExists(ref) {
  return gitOk('rev-parse', '--verify', '--quiet', `${ref}^{commit}`) !== null
}
function listFiles(ref) {
  return git('ls-tree', '-r', '--name-only', ref).split('\n').filter(Boolean)
}
function readAt(ref, path) {
  return execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}
function sameBlob(refA, refB, path) {
  return gitOk('rev-parse', `${refA}:${path}`) === gitOk('rev-parse', `${refB}:${path}`)
}
function stripInstall(text) {
  const begin = text.indexOf('<!-- parity:install:begin')
  if (begin < 0) return text
  const end = text.indexOf('<!-- parity:install:end -->', begin)
  if (end < 0) return text
  return text.slice(0, begin) + '<!-- parity:install -->\n' + text.slice(end + '<!-- parity:install:end -->'.length)
}
function jsonOf(text, label) {
  try {
    return JSON.parse(text)
  } catch (e) {
    fail(`${label} 不是合法 JSON：${e.message}`)
    return null
  }
}
const lineNo = (text, marker) => text.split('\n').findIndex((l) => l.includes(marker)) + 1

// ---- 1) 文件集 --------------------------------------------------------------
if (!refExists(BASE) || !refExists(OTHER)) {
  const missing = [!refExists(BASE) && BASE, !refExists(OTHER) && OTHER].filter(Boolean)
  if (ALLOW_MISSING) {
    notes.push(`另一条线不可用（${missing.join(' / ')}），跳过对等检查（--allow-missing-other）`)
  } else {
    fail(`找不到分支：${missing.join(' / ')}（本机需同时有内部线与发布线；CI 可用 --allow-missing-other 跳过）`)
  }
}

if (problems.length === 0) {
  const a = new Set(listFiles(BASE))
  const b = new Set(listFiles(OTHER))
  const onlyA = [...a].filter((f) => !b.has(f))
  const onlyB = [...b].filter((f) => !a.has(f))
  if (onlyA.length) fail(`${BASE} 独有 ${onlyA.length} 个文件：\n    ${onlyA.join('\n    ')}`)
  if (onlyB.length) fail(`${OTHER} 独有 ${onlyB.length} 个文件：\n    ${onlyB.join('\n    ')}`)

  // 两条线都不该再出现 .cmd 安装脚本（由 dsh plugin add 取代）
  const cmdFiles = [...a, ...b].filter((f) => f.endsWith('.cmd'))
  if (cmdFiles.length) fail(`.cmd 脚本应当删除：${[...new Set(cmdFiles)].join(', ')}`)

  // ---- 2) 逐文件比对，白名单外必须逐字节相同 ----
  const READMES = new Set(['README.md', 'README.en.md'])
  const differ = []
  for (const f of [...a].filter((f) => b.has(f))) {
    if (sameBlob(BASE, OTHER, f)) continue
    if (READMES.has(f)) {
      const x = stripInstall(readAt(BASE, f))
      const y = stripInstall(readAt(OTHER, f))
      if (x !== y) {
        const xl = x.split('\n')
        const yl = y.split('\n')
        const i = xl.findIndex((l, k) => l !== yl[k])
        fail(`${f} 在安装段之外也不一致（第 ${i + 1} 行起）：\n    ${BASE}: ${String(xl[i]).slice(0, 120)}\n    ${OTHER}: ${String(yl[i]).slice(0, 120)}`)
      }
      continue
    }
    if (f === 'package.json') {
      const x = jsonOf(readAt(BASE, f), `${BASE}:package.json`)
      const y = jsonOf(readAt(OTHER, f), `${OTHER}:package.json`)
      if (x && y) {
        for (const k of ['repository', 'homepage', 'bugs']) {
          delete x[k]
          delete y[k]
        }
        const xs = JSON.stringify(x, null, 2)
        const ys = JSON.stringify(y, null, 2)
        if (xs !== ys) {
          const xl = xs.split('\n')
          const yl = ys.split('\n')
          const i = xl.findIndex((l, k) => l !== yl[k])
          fail(`package.json 除 repository/homepage/bugs 外不一致（第 ${i + 1} 行）：\n    ${BASE}: ${String(xl[i]).slice(0, 120)}\n    ${OTHER}: ${String(yl[i]).slice(0, 120)}`)
        }
      }
      continue
    }
    if (f === 'release-manifest.json') {
      const x = jsonOf(readAt(BASE, f), `${BASE}:release-manifest.json`)
      const y = jsonOf(readAt(OTHER, f), `${OTHER}:release-manifest.json`)
      if (x && y) {
        for (const m of [x, y]) {
          if (m.internal) Object.assign(m.internal, { ref: '*', tag: '*' })
          if (m.external) Object.assign(m.external, { ref: '*', tag: '*' })
        }
        if (JSON.stringify(x) !== JSON.stringify(y)) fail('release-manifest.json 除 internal/external 的 ref/tag 外不一致')
      }
      continue
    }
    differ.push(f)
  }
  if (differ.length) fail(`以下文件应当逐字节相同却不同：\n    ${differ.join('\n    ')}`)

  // ---- 3) scripts/ 必须完全一致（单独再断言一次，失败信息更直白）----
  const scriptsA = [...a].filter((f) => f.startsWith('scripts/'))
  const scriptsB = [...b].filter((f) => f.startsWith('scripts/'))
  const sd = [...new Set(scriptsA)].filter((f) => sameBlob(BASE, OTHER, f) === false)
  if (sd.length) fail(`scripts/ 必须逐字节一致，以下不同：${sd.join(', ')}`)
  if (scriptsA.length !== scriptsB.length) fail(`scripts/ 文件数不同：${BASE}=${scriptsA.length}，${OTHER}=${scriptsB.length}`)
}

// ---- 4) --pack：对外发布必须能力 --------------------------------------------
if (has('--pack') && problems.length === 0) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

  const MUST = [
    'package.json', 'README.md', 'README.en.md', 'USAGE.md', 'LICENSE', 'icon.svg', 'assets/overview.png',
    'lib/index.js', 'lib/agent.js', 'lib/client.js', 'lib/types/index.d.ts',
    'vendor/mcp-gitee-ent/manifest.json',
    'vendor/mcp-gitee-ent/mcp-gitee-ent-linux-amd64',
    'vendor/mcp-gitee-ent/mcp-gitee-ent-windows-amd64.exe',
    'skills/dsh-gitee-chat/SKILL.md', 'skills/dsh-gitee-chat/references/mcp.md',
    'skills/dsh-gitee-chat/templates/pr.md',
    'presets/gitee.patch.yml', 'cordis.patch.yml', 'cordis.skills.patch.yml',
    'scripts/setup.mjs', 'scripts/check-presets.mjs', 'scripts/gitee/gq.mjs'
  ]
  const tmp = mkdtempSync(join(tmpdir(), 'gitee-chat-pack-'))
  try {
    execFileSync('npm', ['pack', '--pack-destination', tmp], { stdio: 'ignore' })
    const tgz = execFileSync('ls', [tmp], { encoding: 'utf8' }).trim().split('\n').find((f) => f.endsWith('.tgz'))
    const list = execFileSync('tar', ['tzf', join(tmp, tgz)], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map((p) => p.replace(/^package\//, ''))
    const set = new Set(list)
    for (const f of MUST) if (!set.has(f)) fail(`包里缺必须文件：${f}`)
    const FORBIDDEN = (f) =>
      f.startsWith('src/') || f.startsWith('docs/') || f.startsWith('.github/') ||
      ['DESIGN.md', 'DOCS.md', 'FUNCTIONS.md', 'CAPABILITIES.md', 'package-lock.json', 'pnpm-lock.yaml'].includes(f) ||
      f.startsWith('tsconfig')
    const bad = list.filter(FORBIDDEN)
    if (bad.length) fail(`包里不该出现：${bad.join(', ')}`)
    notes.push(`包内容：${list.length} 个文件`)

    // 元数据
    const must = { name: 'dsh-gitee-chat', license: 'MIT' }
    for (const [k, v] of Object.entries(must)) if (pkg[k] !== v) fail(`package.json ${k} 应为 ${v}，实际 ${pkg[k]}`)
    if (!pkg.engines?.dsh || !pkg.engines?.node) fail('package.json 缺 engines.dsh / engines.node')
    if (pkg.types !== './lib/types/index.d.ts') fail(`package.json types 应指向 lib/types/index.d.ts，实际 ${pkg.types}`)
    for (const k of ['.', './client', './agent']) if (!pkg.exports?.[k]?.types) fail(`package.json exports["${k}"] 缺 types`)
    const patches = pkg.dsh?.bundle?.patch ?? []
    if (patches.length !== 3) fail(`dsh.bundle.patch 应有 3 个补丁，实际 ${patches.length}`)
    if (!pkg.files?.includes('icon.svg')) fail('package.json files 缺 icon.svg')
    if (pkg.publishConfig?.registry !== 'https://registry.npmjs.org/') fail('publishConfig.registry 必须钉官方源')
    if (!pkg.packageManager?.startsWith('pnpm@')) fail('package.json 缺 packageManager（CI 靠它装 pnpm）')

    // 二进制与 MCP 清单
    const manifest = JSON.parse(readFileSync('vendor/mcp-gitee-ent/manifest.json', 'utf8'))
    if (manifest.binaryVersion !== pkg.version && !manifest.binaryVersion) fail('vendor manifest 缺 binaryVersion')
    if (!Array.isArray(manifest.tools) || manifest.tools.length < 40) fail(`vendor manifest 工具数异常：${manifest.tools?.length}`)
    for (const f of ['vendor/mcp-gitee-ent/mcp-gitee-ent-linux-amd64', 'vendor/mcp-gitee-ent/mcp-gitee-ent-windows-amd64.exe']) {
      const size = statSync(f).size
      if (size < 5 * 1024 * 1024) fail(`${f} 体积异常（${size} 字节），可能没重新打包`)
    }
    notes.push(`MCP：${manifest.binaryVersion} · ${manifest.tools.length} 个工具`)

    // 版本一致性：package.json ↔ CHANGELOG
    const changelog = readFileSync('CHANGELOG.md', 'utf8')
    if (!changelog.includes(`## [${pkg.version}]`)) fail(`CHANGELOG.md 缺 ## [${pkg.version}] 小节`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ---- 输出 -------------------------------------------------------------------
if (problems.length) {
  console.error(`\n✗ 双线对等检查未通过（${problems.length} 项）\n`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error('')
  process.exit(1)
}
for (const n of notes) console.log(`  · ${n}`)
console.log(`\n✓ 双线对等${has('--pack') ? ' + 发布包必须能力' : ''}检查通过（${BASE} ↔ ${OTHER}）\n`)
