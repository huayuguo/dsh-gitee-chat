#!/usr/bin/env node
/**
 * dsh-gitee-chat 安装/配置器 —— **让 AI 问、AI 写，使用者不动手**。
 *
 * 设计前提：使用者不该被要求打开任何文件。所以这个脚本把「安装」拆成
 * AI 能一步一步驱动的四个动词：
 *
 *   env         协作环境体检：git / Obsidian(+skill) / Gitee 企业 MCP / 企业 token /
 *               Apifox（软件开发成员）/ 测试协作工具（预留）；`--install <id>` 装单项
 *   detect      探测环境事实（JSON）——token 在哪、有几个企业、MCP 在不在、装到哪
 *   questions   输出**该问用户的问题**（JSON，带推荐默认值与「不问也能跑」的兜底）
 *   apply       按 answers 写配置：profile 的 cordis.patch.yml + 本地配置 + preset + skill
 *   verify      装配后自检，给出人类可读结论
 *
 * 四者都是纯 JSON in / JSON out，AI 不必解析人话输出。
 *
 * 写文件的三条纪律：
 *   1. **只改自己的那一块**：profile 的 cordis.patch.yml 用哨兵注释圈出本插件的
 *      段落，重跑只替换这一段，其余字节原样保留（那里可能有别人的手写配置）。
 *   2. **先备份再写**，且 `--dry-run` 可以只看 diff 不落盘。
 *   3. **绝不打印 token**：只报"在哪找到的"，值永远不出现在输出里。
 *
 * 用法：
 *   node scripts/setup.mjs detect [--json]
 *   node scripts/setup.mjs questions [--json]
 *   node scripts/setup.mjs apply --answers answers.json [--dry-run]
 *   node scripts/setup.mjs apply --answers -            # 从 stdin 读
 *   node scripts/setup.mjs verify
 *
 * @module dsh-gitee-chat/scripts/setup
 */

import { execFile } from 'node:child_process'
import {
  chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** 本插件在 profile 补丁里的行 id。 */
const ROW_ID = 'gitee-chat'
/** 哨兵：圈出「本脚本管理的那一段」，重跑只换这一段。 */
const BEGIN = `# >>> ${ROW_ID} (managed by scripts/setup.mjs — 重新运行可覆盖本段) >>>`
const END = `# <<< ${ROW_ID} <<<`
/** 本包内的 skill 目录（插件标准：随包分发，由本包补丁挂 provider 指向它）。 */
const SKILL_NAME = 'dsh-gitee-chat'
/** 挂载 skill 的那一行在补丁里的 id。 */
const SKILL_ROW_ID = 'gitee-chat-skills'

/** token 环境变量名（与 gq.mjs 保持一致）。 */
const TOKEN_ENVS = ['GITEE_ENT_MCP_ACCESS_TOKEN', 'GITEE_ACCESS_TOKEN', 'GITEE_TOKEN']

// ── 小工具 ──────────────────────────────────────────────────────────────────

/** token 文件候选位置（与 gq.mjs 保持一致）。 */
function tokenFileCandidates() {
  return [
    join(dshHome, '.gitee-chat', 'token'),
    join(dshHome, 'gitee-chat-token'),
    join(homedir(), '.gitee-token'),
  ]
}

/** 找到 token 的**来源**（永不返回值本身）。 */
function locateToken() {
  for (const name of TOKEN_ENVS) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return { found: true, source: `env:${name}` }
  }
  for (const path of tokenFileCandidates()) {
    if (!existsSync(path)) continue
    try {
      if (readFileSync(path, 'utf8').trim() !== '') return { found: true, source: `file:${path}` }
    } catch { /* 读不到就当没有 */ }
  }
  return { found: false, source: null }
}

/**
 * 在 PATH 里找可执行文件。
 *
 * ⚠️ 分隔符与后缀都**不能写死**（真机实测的 Windows bug）：
 *   · Windows 的 PATH 是 `;` 分隔，而盘符里本身带 `:` —— 按 `:` 切会把
 *     `C:\Program Files\...` 切成三段，于是**永远找不到任何东西**。后果是 env/detect
 *     在 Windows 上稳定误报 git / obsidian / mcp 都没装（还会顺着劝你去 go install MCP）。
 *   · Windows 的可执行文件带后缀（`git.exe`、`obsidian.com`），要按 PATHEXT 逐个试。
 * `env` / `platform` 可注入：这样 Windows 用例能在 Linux 上跑，不必等真机。
 */
function which(cmd, env = process.env, platform = process.platform) {
  const win = platform === 'win32'
  const exts = win
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e !== '')
    : ['']
  for (const raw of (env.PATH ?? '').split(win ? ';' : ':')) {
    const dir = raw.replace(/^"(.*)"$/, '$1') // PATH 里带引号的条目
    if (dir === '') continue
    for (const ext of ['', ...exts]) {
      try {
        const full = join(dir, cmd + ext)
        if (statSync(full).isFile()) return full
      } catch { /* 不存在 */ }
    }
  }
  return null
}

/** 读 JSON 文件（失败返回 null）。 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** 极简 YAML 标量：够用且不会把用户的字符串解释坏。 */
function yamlScalar(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0'
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${value.map((v) => yamlScalar(v)).join(', ')}]`
  }
  if (value === null || value === undefined) return "''"
  const text = String(value)
  if (text === '') return "''"
  // 加引号最省心：URL、路径、含 / 的模块名、看起来像数字的字符串都不会被 YAML 误解
  return `'${text.replace(/'/g, "''")}'`
}

// ── detect ──────────────────────────────────────────────────────────────────

/** 列出 $DSH_HOME/profiles/*，并读出各自的补丁现状。 */
function listProfiles() {
  const rootDir = join(dshHome, 'profiles')
  if (!existsSync(rootDir)) return []
  return readdirSync(rootDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    // 只认真正的 profile 目录：dsh 早期写 cordis.yml，0.1.5+ 改为只写
    // cordis.patch.yml + package.json。三者任一存在即视为 profile，否则
    // 新版 dsh 创建的 profile 会被滤掉，apply 报"找不到 profile"。
    .filter((e) =>
      existsSync(join(rootDir, e.name, 'cordis.yml')) ||
      existsSync(join(rootDir, e.name, 'cordis.patch.yml')) ||
      existsSync(join(rootDir, e.name, 'package.json'))
    )
    // 备份/损坏目录（web.bak_broken 之类）不是可用 profile
    .filter((e) => !/\.bak|\.old|\.broken/.test(e.name))
    .map((e) => {
      const dir = join(rootDir, e.name)
      const patchPath = join(dir, 'cordis.patch.yml')
      const patchText = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
      const pkg = readJson(join(dir, 'package.json'))
      const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : []
      return {
        name: e.name,
        dir,
        patchPath,
        patchExists: existsSync(patchPath),
        /** 装了本插件（bundle 列表里有它）——那就是该写补丁的 profile。 */
        hasBundle: bundles.includes('dsh-gitee-chat'),
        bundles,
        /** 补丁里本插件那一段的现值（没写就是 null）。 */
        currentConfig: patchPath === '' ? null : readManagedConfig(patchPath),
        /** 插件市场留在托管段之外的 `disabled: true` 行（半状态残留，见 repairMarketHalfState）。 */
        disabledRows: foreignDisabledRows(patchText),
      }
    })
}

// ── agent 半的可解析性：`link:` 安装的死穴 ────────────────────────────────────
//
// 事实（2026-09-21 在同事机上定位并实测复现）：
//
//   agent 半（`lib/agent.js`）有一个**运行时裸导入** `@deepseek-ai/dsh-tools`
//   （来自 `src/host/tools.ts` 的 `defineTool`）。它只在「起会话时组装 preset」
//   这一步被加载 —— 安装与 `dsh web` 启动都不预加载 preset，所以是典型的
//   **装完一切正常、一用就炸**，而且前端是静默的（`console.warn("new session
//   failed:")`），症状表现为「选了工作区没反应」（会话建不起来，退回 hero 态）。
//
//   裸导入能否解析，取决于**安装形态**：
//     · 真目录装（`file:` / 正常 pnpm 装）：Node 的父目录回溯会走到
//       `$DSH_HOME/profiles/node_modules` —— 那是 DSH 的依赖闭包，里面是指向
//       harness 自身安装的符号链接 → 命中 ✅（`dsh-better-sidebar` 5 个、
//       `dsh-context` 2 个裸导入都靠这条活着）
//     · `link:` 装：模块 realpath 落在 `profiles/**` 之外，回溯永远够不到闭包 ❌
//
// 所以这里做两件事：**探针**（装完就验，别等到起会话）+ **自愈**（给 `link:`
// 安装补一跳，就是同事手工打的那个 junction/symlink，指向同一份闭包，不会出现
// 第二份实例）。

/**
 * profile 里 `dsh-gitee-chat` 的依赖写法（`link:` / `file:` / 版本号）。
 * @param {string} profileDir
 * @returns {string|null}
 */
function dependencySpec(profileDir) {
  const pkg = readJson(join(profileDir, 'package.json'))
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }
  const spec = deps['dsh-gitee-chat']
  return typeof spec === 'string' && spec.trim() !== '' ? spec.trim() : null
}

/**
 * 在 profile 目录里**真跑一次** `import('dsh-gitee-chat/agent')`。
 *
 * 用子进程而不是 `import()`：探针要验的正是「Node 在**那个目录**里能不能解析」，
 * 在宿主进程里 import 只会验证宿主自己的解析路径，等于没验。
 *
 * @param {string} profileDir
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function probeAgentImport(profileDir) {
  // 包都没装进来时，探针失败没有信息量（不是解析问题，是"还没 add"）——
  // 那种情况由既有检查负责报，别在这里刷假警报。
  const entry = join(profileDir, 'node_modules', 'dsh-gitee-chat')
  if (!existsSync(entry)) {
    return { present: false, ok: false, error: `profile 里没有 ${entry}（本插件还没 add 进来）` }
  }
  try {
    await run(process.execPath, ['--input-type=module', '-e', "await import('dsh-gitee-chat/agent')"], {
      cwd: profileDir, timeout: 30_000, maxBuffer: 1024 * 1024,
    })
    return { present: true, ok: true, error: null }
  } catch (error) {
    const text = String(error?.stderr || error?.message || error)
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    // Node 的报错里上面是 import 链、最后一行才是根因；指名 `Cannot find package` 那行最有用
    const root = lines.find((l) => l.includes('Cannot find package')) ?? lines[lines.length - 1] ?? text
    return { present: true, ok: false, error: root.replace(/^Error:\s*/, '').slice(0, 300) }
  }
}

/**
 * DSH 的依赖闭包根 —— `$DSH_HOME/profiles/node_modules`。
 * @returns {string}
 */
function defaultClosureRoot() {
  return join(dshHome, 'profiles', 'node_modules')
}

/**
 * 给 `link:` 装的插件补一跳父目录回溯（= 同事手工那步的自动化）。
 *
 * 只在**确实需要**时动手：依赖写法必须是 `link:`、目标包与闭包都在、且包内还
 * 没有这一跳。已存在就绝不覆盖 —— 那说明失败另有原因，覆盖只会掩盖它。
 *
 * @param {string} profileDir
 * @param {{ closureRoot?: string }} [opts]
 * @returns {{ action: 'linked'|'skipped'|'failed', dest: string|null, source: string|null, note: string|null }}
 */
function repairAgentResolution(profileDir, opts = {}) {
  const closureRoot = opts.closureRoot ?? defaultClosureRoot()
  const spec = dependencySpec(profileDir)
  if (spec === null || !spec.startsWith('link:')) {
    return {
      action: 'skipped', dest: null, source: null,
      note: `不是 link: 安装（package.json 里是 ${spec ?? '未声明'}）—— 真目录装法本来就解析得到，不该补链`,
    }
  }
  const entry = join(profileDir, 'node_modules', 'dsh-gitee-chat')
  if (!existsSync(entry)) {
    return { action: 'skipped', dest: null, source: null, note: `profile 里找不到 ${entry}` }
  }
  const source = join(closureRoot, '@deepseek-ai')
  if (!existsSync(source)) {
    return { action: 'skipped', dest: null, source: null, note: `没找到 DSH 依赖闭包 ${source}` }
  }
  let real
  try {
    real = realpathSync(entry)
  } catch (error) {
    return { action: 'skipped', dest: null, source, note: `解析 ${entry} 失败：${String(error?.message ?? error)}` }
  }
  const dest = join(real, 'node_modules', '@deepseek-ai')
  if (existsSync(dest)) {
    return { action: 'skipped', dest, source, note: `${dest} 已存在但仍解析失败 —— 不覆盖，请手工排查` }
  }
  try {
    mkdirSync(dirname(dest), { recursive: true })
    // Windows 用 junction：普通用户即可创建（symlink 要开发者模式或管理员）
    symlinkSync(source, dest, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    return { action: 'failed', dest, source, note: `建链失败：${String(error?.message ?? error)}` }
  }
  return { action: 'linked', dest, source, note: null }
}

/**
 * 目标 profile 是不是**桌面应用自己管的那个**（`profiles/desktop`）。
 *
 * 为什么要这个判断：桌面版把 DSH 的 `@deepseek-ai/*` 依赖闭包放在 app.asar 里，
 * 解析由**宿主**提供 —— 任何"在 profile 目录里裸 import"的探针在桌面机上都必然
 * 失败，**跟插件能不能跑没关系**。生态先例（本机实测）：profile 里装的
 * dsh-context（`lib/index.js` 裸导入 `@deepseek-ai/dsh-session`）与
 * dsh-cost-meter（`@deepseek-ai/dsh-credentials`）的依赖都不在
 * `profiles/desktop/node_modules/@deepseek-ai`（那里只有 cosmokit/schemastery），
 * 但它们照常加载。桌面 profile 也只能由应用自己（或应用自带 CLI）管。
 *
 * @param {string} profileDir
 * @returns {boolean}
 */
function isDesktopManagedProfile(profileDir) {
  return basename(profileDir).toLowerCase() === 'desktop'
}

/**
 * 探针 +（可选）自愈，一步到位。
 * @param {string} profileDir
 * @param {{ closureRoot?: string, repair?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, probe: { ok: boolean, error: string|null },
 *   repair: object|null, probeAfter: { ok: boolean, error: string|null }|null }>}
 */
async function ensureAgentHalf(profileDir, opts = {}) {
  const probe = await probeAgentImport(profileDir)
  // 没装进来 = 无从探测，也不算这一项的失败（既有检查已在管"没装 bundle"）
  if (!probe.present) return { ok: true, present: false, probe, repair: null, probeAfter: null }
  if (probe.ok) return { ok: true, present: true, probe, repair: null, probeAfter: null }
  const repair = repairAgentResolution(profileDir, opts)
  if (repair.action !== 'linked') {
    return {
      ok: false, present: true, probe, repair, probeAfter: null,
      // 桌面版宿主自带闭包 ⇒ 这里的失败是假阴性，调用方别当故障（见 isDesktopManagedProfile）
      hostSuppliesClosure: isDesktopManagedProfile(profileDir),
    }
  }
  const probeAfter = await probeAgentImport(profileDir)
  return { ok: probeAfter.ok, present: true, probe, repair, probeAfter, hostSuppliesClosure: false }
}

/**
 * 从补丁文本里读回本插件那一段的 id 与 config。
 * @param {string} patchPath
 * @returns {{ present: boolean, managed: boolean, config: Record<string, unknown> | null, text: string }}
 */
function readManagedConfig(patchPath) {
  if (!existsSync(patchPath)) return { present: false, managed: false, config: null, text: '' }
  const text = readFileSync(patchPath, 'utf8')
  const block = extractBlock(text)
  if (block === null) return { present: false, managed: false, config: null, text }
  return { present: true, managed: block.managed, config: parseConfigBlock(block.lines), text }
}

/**
 * 定位补丁文件里本插件的那一段。
 * @returns {{ start: number, end: number, managed: boolean, lines: string[] } | null}
 */
function extractBlock(text) {
  const lines = text.split('\n')

  // ① 有哨兵：直接取哨兵之间（最可靠，重跑幂等）
  const beginAt = lines.findIndex((l) => l.trim() === BEGIN)
  if (beginAt >= 0) {
    const endAt = lines.findIndex((l, i) => i > beginAt && l.trim() === END)
    if (endAt > beginAt) return { start: beginAt, end: endAt + 1, managed: true, lines: lines.slice(beginAt, endAt + 1) }
  }

  // ② 没有哨兵：找顶层的 `- id: gitee-chat`，连它上面紧贴的注释一起吞掉，
  //    这样手工写过的注释不会变成孤儿留在上面。
  let rowAt = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^-\s+id:\s*['"]?gitee-chat['"]?\s*$/.test(lines[i])) { rowAt = i; break }
  }
  if (rowAt < 0) return null
  let start = rowAt
  while (start > 0 && lines[start - 1].trim().startsWith('#')) start--
  let end = rowAt + 1
  while (end < lines.length && !/^-\s/.test(lines[end])) end++
  // 吃掉块尾的空行，避免越改越空
  while (end > rowAt + 1 && lines[end - 1].trim() === '') end--
  return { start, end, managed: false, lines: lines.slice(start, end) }
}

/**
 * 剥掉 YAML 行尾的**行内注释**（`key: 3   # 说明` → `3`）。
 *
 * 为什么必须做：`renderBlock` 写出来的每一行几乎都带行内注释（人读的），
 * 不剥的话 `requiredLabels` 会被解析成字符串 `"3      # 规范要求的标签数（0 = 关闭）"`，
 * 于是 detect 报给 AI 的现状是垃圾值，"阈值不对"这类问题就答不准。
 *
 * 只按 YAML 的规则剥：`#` 必须在**空白之后**（或行首）才算注释开始，
 * 且引号内的 `#` 一律是内容。`''` 是单引号里的转义单引号，要跳过一个。
 */
function stripInlineComment(raw) {
  let quote = null
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (quote !== null) {
      if (ch === quote) {
        if (quote === "'" && raw[i + 1] === "'") { i++; continue }
        quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i)
  }
  return raw
}

/**
 * 解析一段 YAML 里的 `config:` 子块（只认本脚本自己写出的形状：标量 + 一层嵌套）。
 * 这不是通用 YAML 解析器 —— 够用即可，且解析失败只意味着 detect 报 null。
 */
function parseConfigBlock(lines) {
  const start = lines.findIndex((l) => /^\s+config:\s*$/.test(l))
  if (start < 0) return null
  const out = {}
  let nested = null
  let nestedIndent = 0
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent <= 2) break // 回到 `- id:` 那一层
    const m = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (m === null) continue
    const value = stripInlineComment(m[3]).trim()
    // 一层嵌套（thresholds:）
    if (value === '' ) {
      nested = {}
      nestedIndent = indent
      out[m[2]] = nested
      continue
    }
    let parsed = value
    if (value === '[]') parsed = []
    else if (value === 'true') parsed = true
    else if (value === 'false') parsed = false
    else if (/^'.*'$/.test(value)) parsed = value.slice(1, -1).replace(/''/g, "'")
    else if (/^-?\d+(\.\d+)?$/.test(value)) parsed = Number(value)
    if (nested !== null && indent > nestedIndent) nested[m[2]] = parsed
    else { out[m[2]] = parsed; nested = null }
  }
  return out
}

/**
 * MCP 后端能不能用 —— 必须按 preset 真正的三级回落判，**不能只看 PATH**。
 *
 * ⚠️ 0.5.1 起随包二进制落在**用户级 bin**（`~/.local/bin`；Windows
 * `%USERPROFILE%\.local\bin`）—— Linux 上通常已在 PATH 里，Windows 上默认不在。
 * 旧代码（0.5.0）把 `which('mcp-gitee-ent')` 的结果当成"可用与否"，
 * 而那时的落地位置 `$DSH_HOME/.gitee-chat/bin/` **本来就不在 PATH 上**，
 * 后果比误报更糟：
 *   · 生成的补丁里留下一条自相矛盾的注释「MCP 可执行 : 未找到（MCP 工具会挂不上）」，
 *     而**同一轮 `apply` 刚刚把 51 个工具的随包二进制落地了**；
 *   · `problems` 直接劝人去 `go install` —— 与 SKILL 里「随包分发、别让使用者装 Go」
 *     那条硬规则正面冲突。
 * 优先级与 `src/host/mcpBinary.ts` 的 `ensureMaterialized()` 保持一致。
 */
function resolveMcpBinary() {
  const override = process.env.MCP_GITEE_ENT_BIN
  if (typeof override === 'string' && override.trim() !== '') {
    return { found: true, source: 'env', path: override.trim(), detail: `MCP_GITEE_ENT_BIN 指定：${override.trim()}` }
  }
  const vendored = inspectVendoredMcp()
  if (vendored.bundled && vendored.vendoredFileExists) {
    return {
      found: true,
      source: 'bundled',
      path: vendored.target,
      detail: `随包分发（${vendored.key} · ${vendored.toolCount ?? '?'} 个工具）`
        + (vendored.installed
          ? (vendored.onPath ? '' : `，落地在 ${vendored.target}（不在 PATH 上）`)
          : (vendored.legacyPresent
            ? `，尚未迁到 ${vendored.target} —— 暂用 0.5.0 的旧副本，跑一次 apply 或重启宿主会迁移`
            : '，尚未落地 —— 跑一次 apply 或重启宿主会自动补上')),
    }
  }
  const onPath = which('mcp-gitee-ent')
  if (onPath !== null) return { found: true, source: 'path', path: onPath, detail: `PATH 上的 ${onPath}` }
  return {
    found: false,
    source: 'none',
    path: null,
    detail: vendored.bundled
      ? `随包二进制 ${vendored.entry?.file ?? ''} 在包里但没有落地文件`
      : `本平台（${vendored.key}）未随包`,
  }
}

/** 探测环境事实。 */
async function detect() {
  const token = locateToken()
  const mcp = resolveMcpBinary()
  const profiles = listProfiles()
  const withBundle = profiles.filter((p) => p.hasBundle)
  // agent 半能否被 import（`link:` 安装的死穴，见上文那段）。只探装了本插件的那个 profile。
  const agentHalf = withBundle[0] === undefined
    ? null
    : await (async () => {
      const dir = withBundle[0].dir
      const probe = await probeAgentImport(dir)
      return {
        dir,
        spec: dependencySpec(dir),
        ...probe,
        // 这里只探不修（detect 不许有副作用）；桌面版宿主自带 @deepseek-ai 闭包 ⇒ 失败是假阴性
        hostSuppliesClosure: !probe.ok && probe.present && isDesktopManagedProfile(dir),
      }
    })()
  const configPath = join(dshHome, '.gitee-chat', 'config.json')
  const localConfig = readJson(configPath) ?? {}

  // preset 的交付方式在 DSH 0.1.7 变了：不再是"拷到 `$DSH_HOME/.agent-presets/` 的文件"，
  // 而是本包 bundle patch 列表里的 `presets/*.patch.yml`（照 `dsh-web-app/presets/*` 的做法）。
  // 所以"就位"= 补丁文件在仓库里 **且**列进了 package.json 的 `dsh.bundle.patch` ——
  // 没列进去的文件装到别人机器上根本不会被组合。见 DESIGN.md §29。
  const installedPresets = deliveredPresets()

  // 企业列表：只在有 token 时试一次；失败不影响其它结论
  let enterprises = null
  let enterprisesError = null
  if (token.found) {
    try {
      const { stdout } = await run(process.execPath, [join(root, 'scripts/gitee/gq.mjs'), 'enterprises', '--json'], {
        env: tokenEnv(), cwd: root, timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      })
      const parsed = JSON.parse(String(stdout).trim().split('\n').pop())
      if (parsed.ok === true) enterprises = parsed.enterprises
      else enterprisesError = parsed.error ?? '未知错误'
    } catch (error) {
      enterprisesError = String(error?.stderr || error?.message || error).slice(0, 300)
    }
  }

  const problems = []
  if (!token.found) {
    problems.push('没有找到 Gitee token：取数会报「未配置 token」。'
      + '**推荐在界面里填**：应用「设置 → Gitee 企业项目」（0.4.1 起；存完即时生效，不用重启）；'
      + `也可以自己放：环境变量 ${TOKEN_ENVS[0]}，或文件 ${tokenFileCandidates()[0]}`)
  }
  if (!mcp.found) {
    problems.push(`MCP 后端不可用（${mcp.detail}）：建工作项/改状态等 MCP 工具会挂不上；`
      + 'Gitee 项目标签页与固定分析仍可用。'
      + '**本平台随包提供时不需要 Go** —— 跑一次 `node scripts/setup.mjs apply` 会把随包二进制落地；'
      + '确实要替代方案再用 MCP_GITEE_ENT_BIN 指到已有二进制，或 go install gitee.com/oschina/mcp-gitee-ent@latest')
  }
  if (withBundle.length === 0) {
    problems.push('profile 的 dsh.profile.bundles 里没有 dsh-gitee-chat：host 半（路由/服务）没挂上。'
      + '先执行 `dsh plugin --profile <name> add <本包目录>`')
  }
  if (agentHalf !== null && agentHalf.present && !agentHalf.ok && agentHalf.hostSuppliesClosure !== true) {
    problems.push(`agent 半 import 不了（preset 里那行 dsh-gitee-chat/agent）：${agentHalf.error}`
      + ' —— 起会话会失败，界面表现是「选了工作区没反应」（会话建不起来，前端静默退回 hero 态）。'
      + '跑 `node scripts/setup.mjs apply` 会自动给 link: 安装补一跳；'
      + '或改用真目录装法 `dsh plugin --profile <name> add file:<本包目录>`')
  }
  if (!existsSync(join(root, 'lib/index.js'))) problems.push('缺少构建产物 lib/index.js：先跑 npm run build')

  return {
    ok: problems.length === 0,
    dshHome,
    root,
    version: readJson(join(root, 'package.json'))?.version ?? null,
    token,
    tokenFileCandidates: tokenFileCandidates(),
    /**
     * MCP 后端：`found` 是**按三级回落判的可用性**，不是"PATH 上有没有"。
     * `source`：`env` | `bundled` | `path` | `none`；`detail` 可直接展示。
     */
    mcpBinary: { ...mcp },
    profiles,
    /** 该写补丁的 profile（装了本插件的那个）。 */
    targetProfile: withBundle[0]?.name ?? profiles[0]?.name ?? null,
    skill: inspectSkill(),
    /** agent 半的可解析性（null = 没有 profile 装了本插件，无从探测）。 */
    agentHalf,
    presets: { installed: installedPresets, expected: listRepoPresets() },
    enterprise: {
      /** 本地配置文件里的值（`gq enterprises --use` 写的，**不需要重启**）。 */
      localFile: Number(localConfig.enterpriseId) > 0 ? Number(localConfig.enterpriseId) : 0,
      configPath,
      /** 企业列表（token 不可用或调用失败时为 null）。 */
      list: enterprises,
      error: enterprisesError,
    },
    problems,
    hints: [
      'apply 会写两处：profile 的 cordis.patch.yml（插件配置）、$DSH_HOME/.gitee-chat/config.json（当前企业）。'
      + 'skill 与 preset 都**随本包分发**（skill 由本包补丁挂载、preset 走 bundle patch），不往用户根写文件。',
      '只是改配置（cordis.patch.yml 里的 config）会热重载；改 `lib/` 或 patch 列表要重启 `dsh web` ——'
      + 'preset 补丁列表在装配期读。',
    ],
  }
}

/** 仓库 `presets/*.patch.yml` 的文件名（升序）。 */
function listPresetPatchFiles() {
  const dir = join(root, 'presets')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.patch.yml')).sort()
}

/** 一个 preset patch 文件里 `config.id` 的值（取不到返回 null）。 */
function presetIdOf(file) {
  const text = readFileSync(join(root, 'presets', file), 'utf8')
  return /config:[\s\S]*?^[ \t]*id:[ \t]*['"]?([A-Za-z0-9_-]+)['"]?[ \t]*$/m.exec(text)?.[1] ?? null
}

/** 仓库里的 preset id（补丁文件存在就算有，不管有没有交付出去）。 */
function listRepoPresets() {
  return listPresetPatchFiles().map((f) => presetIdOf(f)).filter((x) => x !== null)
}

/** 真正会被交付的 preset id：补丁文件存在**且**在 `dsh.bundle.patch` 列表里。 */
function deliveredPresets() {
  const declared = readJson(join(root, 'package.json'))?.dsh?.bundle?.patch
  const list = Array.isArray(declared) ? declared : typeof declared === 'string' ? [declared] : []
  const set = new Set(list)
  return listPresetPatchFiles()
    .filter((f) => set.has(`./presets/${f}`))
    .map((f) => presetIdOf(f))
    .filter((x) => x !== null)
}

/** 构造带 token 的子进程环境（只加自己认识的键）。 */
function tokenEnv() {
  const env = { ...process.env }
  if (env.GITEE_ENT_MCP_ACCESS_TOKEN === undefined) {
    for (const name of TOKEN_ENVS) {
      if (typeof env[name] === 'string' && env[name].trim() !== '') {
        env.GITEE_ENT_MCP_ACCESS_TOKEN = env[name]
        break
      }
    }
  }
  return env
}

// ── 协作环境体检（env）─────────────────────────────────────────────────────
//
// 这一节回答的是"**基本项目协作环境**齐不齐"，不只是本插件自己能不能跑：
//   git / Obsidian（含 CLI 与它的 skill 集）/ Gitee 企业版 MCP / 企业 token /
//   Apifox 协作工具（**仅当使用者在软件开发项目里**）/ 测试协作工具（预留）
//
// 两条设计原则：
//   1. **声明式注册表**：要加一个工具，只在 ENV_TOOLS 里加一条，不改检测逻辑。
//      这就是"后期加入测试协作工具的预留"——预留的是一个**位置**，不是一个 TODO。
//   2. **不误报**：检测不到 ≠ 没装。比如 Obsidian 的 CLI 在 App 没运行时也会
//      「找不到 Obsidian」，那必须记为"装了但 App 没开"，而不是"没装"。

/**
 * 协作工具注册表。
 *
 * `scope` 决定"要不要强求"：
 *   all          —— 任何使用者都要（缺了就是环境不齐）
 *   software-dev —— 只在「软件开发项目的下属成员」身上强求（Apifox）
 *   future       —— 预留位：登记了但当前不判失败，接进来时把 scope 改成 all/software-dev
 */
/**
 * 随包 MCP 后端的三个入口 —— 导出是给测试与运维用的。
 *
 * 之所以要导出：`materializeMcp()` 也需要能被单独调用（比如"只把二进制补上，
 * 别动 profile 补丁"），而走 `apply` 会顺带重写补丁里的探测快照。
 */
export { inspectVendoredMcp, materializeMcp, mcpInstallDir, mcpLegacyPath, mcpTargetPath, readMcpManifest }

// agent 半可解析性的三件套：冒烟里用**临时 fixture** 复现「link: 装法解析不到
// 依赖闭包」并验证自愈（真跑子进程，不 mock 解析行为）。
export { dependencySpec, probeAgentImport, repairAgentResolution, ensureAgentHalf }

// Windows 上的两个真机 bug 的回归面：
//  · which()：PATH 分隔符/PATHEXT 写死 → `env`/`detect` 在 Windows 上永远误报缺失。
//    env/platform 可注入，Windows 用例因此能在 Linux 上跑。
//  · inspectSkill()：把"解析结果 == 源码目录"当成效判据，只对 `link:` 成立；
//    `file:`（官方推荐）加载的是副本，于是稳定误报「未生效」。
export { which, inspectSkill, evalSkillExpr }

export const ENV_TOOLS = [
  {
    id: 'git',
    label: 'Git',
    scope: 'all',
    why: '一切协作的底座：拉代码、看 diff、提交、开 PR 都靠它。',
    binary: 'git',
    probe: ['--version'],
    install: {
      linux: 'sudo apt install -y git  # 或 dnf/pacman 对应包',
      macos: 'brew install git',
      doc: 'https://git-scm.com/downloads',
    },
  },
  {
    id: 'obsidian',
    label: 'Obsidian（桌面端 + CLI）',
    scope: 'all',
    why: '团队知识库的载体：文档、图谱、Canvas 都在这儿；它的 skill 集让 AI 能直接读写知识库。',
    binary: 'obsidian',
    probe: ['--version'],
    // CLI 在 Obsidian 没运行时也会失败 —— 那是"没在运行"，不是"没装"
    probeOptional: true,
    // 三个平台的数据目录都列上：这是"装了但不在 PATH"唯一的兜底证据
    alsoDirs: ['~/.config/obsidian', '%APPDATA%/obsidian', '~/Library/Application Support/obsidian'],
    skills: ['obsidian-cli', 'obsidian-markdown', 'json-canvas', 'obsidian-bases', 'obsidian-canvas-creator'],
    install: {
      doc: 'https://obsidian.md/download  （CLI 随桌面端提供；用它之前先把 Obsidian 打开。'
        + '装完如果 `obsidian` 命令用不了，把安装目录加进 PATH —— Windows 的安装器有 "Add to PATH" 勾选项）',
    },
  },
  {
    id: 'gitee-mcp',
    label: 'Gitee 企业版 MCP',
    scope: 'all',
    why: '项目管理的数据面：项目/工作项/PR/迭代都通过它读写。缺了它，标签页与固定分析仍可用，但 AI 不能建工作项、改状态。',
    binary: 'mcp-gitee-ent',
    probe: ['--version'],
    probeOptional: true,
    /**
     * 随包分发：linux/windows 的 amd64 二进制就在包里（vendor/mcp-gitee-ent/），
     * 安装时自动落地到**用户级 bin**（0.5.1 起：POSIX `~/.local/bin`，
     * Windows `%USERPROFILE%\.local\bin`）—— 公开 MCP 的标准位置，
     * 别的 MCP 客户端也能直接调；**同事不需要 Go 环境**。
     * 之所以不直接用上游 npm 包 `@gitee/mcp-gitee-ent`（它有平台包，
     * 也是 esbuild/sharp 那套做法）：**它没有 `create_program`（建项目）**，
     * 文档工具也换成了另一族。我们的能力矩阵依赖那 10 个工具。
     */
    vendored: true,
    install: {
      // 正常情况下什么都不用做 —— 随包二进制会自动落地
      bundled: '无需操作：随包二进制在安装时自动落地（linux / windows amd64）',
      local: '自己编（需要 Go）：cd <本插件同级的 dsh-mcp-gitee-ent> && go install .',
      remote: 'go install gitee.com/oschina/mcp-gitee-ent@latest  ← 注意上游版没有 create_program（建项目）',
      doc: '本平台未随包（如 arm64 / macOS）时走上面两条，或用 MCP_GITEE_ENT_BIN 指到已有二进制',
    },
  },
  {
    id: 'gitee-token',
    label: 'Gitee 企业版 token',
    scope: 'all',
    why: '企业版端点要求「MCP 应用 token」，与个人访问令牌不是一回事。缺了取数会明确报"未配置 token"。',
    token: true,
    install: {
      doc: '在 Gitee 企业版后台申请 MCP 应用 token，然后**在界面里填**：应用「设置 → Gitee 企业项目」'
        + '（0.4.1 起，推荐 —— 存完即时生效）。也可以二选一：'
        + `导出环境变量 ${TOKEN_ENVS[0]}（重启 dsh 生效），或写入 $DSH_HOME/.gitee-chat/token（内容为纯 token）`,
      note: '**绝不要**把 token 贴进对话或提交进仓库。',
    },
  },
  {
    id: 'apifox',
    label: 'Apifox 协作工具（CLI + 技能集）',
    scope: 'software-dev',
    why: '接口协作：接口文档、Mock、自动化测试、迭代分支。软件开发项目的下属成员需要它才能和研发对齐接口。',
    binary: 'apifox',
    probe: ['--version'],
    skills: [
      'apifox-cli', 'apifox-cli-checkup', 'apifox-import-export', 'apifox-branch',
      'apifox-workflow-api-lifecycle', 'apifox-test-case', 'apifox-test-scenario', 'apifox-test-automation',
    ],
    install: {
      auto: ['npm', ['i', '-g', 'apifox-cli@latest', '--registry=https://registry.npmmirror.com/']],
      after: 'apifox login --with-token <TOKEN>   # 令牌在 Apifox「账号设置 → API 访问令牌」创建',
      doc: 'https://apifox.com/help/  （CLI 文档）',
    },
  },
  {
    // 预留位：接测试协作工具时改这一条即可（把 scope 改成 all 或 software-dev）
    id: 'test-collab',
    label: '测试协作工具（预留）',
    scope: 'future',
    why: '后续接入测试协作（用例库 / 缺陷跟踪 / 测试报告）时在这里登记：二进制名、期望可见的 skill 名、安装方式。'
      + '检测逻辑不用改 —— 注册表就是给这件事留的位置。',
    binary: null,
    skills: [],
    install: { note: '尚未接入。接入时：① 在上面加 binary/skills；② 把 scope 改成 all 或 software-dev。' },
  },
]

/**
 * 发现 skill 根目录。
 *
 * 顺序与 `@deepseek-ai/dsh-skill-filesystem` 的 `roots()` 一致（抄自其源码）：
 *   project .dsh/skills → project .agents/skills → customSkillDirs
 *   → $DSH_HOME/skills → $DSH_AGENTS_HOME|~/.agents/skills → $DSH_BUNDLED_SKILL_DIR
 *
 * `customSkillDirs` 从「profile 补丁 + 已装 preset + 已装 bundle」里尽力抽取：
 * 支持纯字符串路径，也支持 `new URL('skills/', baseUrl)` 这种相对写法
 * （baseUrl 对该文件所在目录求值 —— 与 DSH 的语义一致）。
 */
// ── 本包 bundle 补丁的读取 + 插件市场半状态修复 ──────────────────────────────
//
// 本包的 bundle 补丁不止一个文件（0.4.5 起 host 行在 cordis.patch.yml、skill 行
// 在 cordis.skills.patch.yml、preset 在 presets/*.patch.yml），所以"某一行在不在
// 补丁里"一律看 package.json 的 dsh.bundle.patch 声明的**全部**文件。

/**
 * 本包声明的补丁文件（绝对路径，按声明顺序；声明缺失时退回根补丁）。
 * @param {string} [packageRoot]
 * @returns {string[]}
 */
function bundlePatchFiles(packageRoot = root) {
  const pkg = readJson(join(packageRoot, 'package.json'))
  const declared = pkg?.dsh?.bundle?.patch
  const list = Array.isArray(declared) ? declared : typeof declared === 'string' ? [declared] : []
  const files = (list.length > 0 ? list : ['./cordis.patch.yml']).map((rel) => join(packageRoot, String(rel)))
  return files.filter((p) => existsSync(p))
}

/** 本包 bundle 补丁文件的合并文本。 */
function bundlePatchText(packageRoot = root) {
  return bundlePatchFiles(packageRoot)
    .map((p) => `\n# ── ${p} ──\n${readFileSync(p, 'utf8')}`)
    .join('')
}

/** 本插件在组合里的行 id（插件市场会按 id 写 `disabled: true`）。 */
const OUR_ROW_IDS = [ROW_ID, SKILL_ROW_ID]

/**
 * 找出文本里本插件的行（`- id: gitee-chat` / `- id: gitee-chat-skills`）。
 *
 * ⚠️ 不排除托管段内部：实测插件市场的 appendPatchEntry 是**插在最后一个顶层
 * 列表项之后**的，而那正好落在我们的 BEGIN 与 END 哨兵之间（2026-09-30，
 * profile 补丁里 `- id: dsh-market` / `- id: ui-theme` 就是这样夹进来的）。
 * 只看"disabled: true"的那些，所以托管段里 setup.mjs 自己写的行不会被误报。
 * @returns {{ line: number, end: number, id: string, disabled: boolean }[]}
 */
function foreignRowBlocks(text) {
  const lines = text.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^-\s+id:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(lines[i])
    if (m === null || !OUR_ROW_IDS.includes(m[1])) continue
    let j = i + 1
    while (j < lines.length && /^\s+\S/.test(lines[j])) j++
    out.push({ line: i, end: j, id: m[1], disabled: lines.slice(i + 1, j).some((l) => /^\s*disabled:\s*true\s*$/.test(l)) })
    i = j - 1
  }
  return out
}

/** 市场残留（给 detect/verify 报告用）：只报被禁用的那些行 id。 */
function foreignDisabledRows(text) {
  return foreignRowBlocks(text).filter((b) => b.disabled).map((b) => b.id)
}

/**
 * 把市场残留的 `disabled: true` 行从补丁文本里去掉（幂等，其余字节不动）。
 * @returns {{ text: string, removed: string[] }}
 */
function stripForeignDisabledRows(text) {
  const blocks = foreignRowBlocks(text).filter((b) => b.disabled)
  if (blocks.length === 0) return { text, removed: [] }
  const lines = text.split('\n')
  const drop = new Set()
  for (const b of blocks) for (let i = b.line; i < b.end; i++) drop.add(i)
  return { text: lines.filter((_, i) => !drop.has(i)).join('\n').replace(/\n{3,}/g, '\n\n'), removed: blocks.map((b) => b.id) }
}

/**
 * 哨兵段里被别的工具插进来的**顶层行**要原样留下。
 *
 * 不这么做的话，整段替换会连别人的配置一起删掉 —— 实测会出现
 * `- id: ui-theme`（浅色主题）、`- id: session-log-deepseek` 这种
 * 用户/市场的行被静默吃掉。它们被挪到 END 哨兵**之后**，从此不再受影响。
 * @param {string[]} regionLines 哨兵段（含 BEGIN/END 行）
 * @returns {string[]}
 */
function preservedRowsInBlock(regionLines) {
  const out = []
  for (let i = 0; i < regionLines.length; i++) {
    const m = /^-\s+id:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(regionLines[i])
    if (m === null || OUR_ROW_IDS.includes(m[1])) continue
    let end = i + 1
    while (end < regionLines.length && !/^-\s/.test(regionLines[end]) && regionLines[end].trim() !== END) end++
    while (end > i + 1 && regionLines[end - 1].trim() === '') end--
    out.push(...regionLines.slice(i, end))
    i = end - 1
  }
  return out
}

/**
 * 修复插件市场（dshmarket）留下的半状态（2026-09-30 定位，见 DESIGN.md §35）。
 *
 * 成因：市场只认字符串形式的 `dsh.bundle.patch`，本包是数组 → 它把本包当成
 * "没有补丁"，关插件时既把包移出 `dsh.profile.bundles`、又把 `disabled: true`
 * 写进 profile 补丁；之后开插件时热挂载失败（根补丁当时含 config）→ 翻不回来，
 * 而 #696 却把包加回了 bundles → **包在、行却被禁**，表现为 Gitee preset 还在
 * 列表里但红标「加载失败」（`dsh-gitee-chat/agent` 永远等不到 `giteeChat`）。
 *
 * 只有在**本插件确实挂在这个 profile 的 `dsh.profile.bundles` 里**时才动手 ——
 * 那才叫自相矛盾。用户主动关掉插件时（bundle 不在列表里）残留的 disabled 行
 * 是关掉的正常结果，不动它。
 */
function repairMarketHalfState(profile, opts = {}) {
  const base = { profile: profile.name, action: 'skipped', removed: [], note: null, backup: null, path: profile.patchPath }
  if (!profile.patchExists) return { ...base, note: 'profile 补丁不存在（apply 会新建）' }
  if (!profile.hasBundle) {
    return { ...base, note: '本插件不在 dsh.profile.bundles 里（= 被关掉了），残留的 disabled 行不动' }
  }
  const original = readFileSync(profile.patchPath, 'utf8')
  const stripped = stripForeignDisabledRows(original)
  if (stripped.removed.length === 0) return { ...base, action: 'clean' }
  if (opts.dryRun === true) return { ...base, action: 'fixed', removed: stripped.removed, note: '（预演，未写盘）' }
  const backup = `${profile.patchPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
  writeFileSync(backup, original)
  writeFileSync(profile.patchPath, stripped.text)
  return {
    ...base, action: 'fixed', removed: stripped.removed, backup,
    note: '插件在 dsh.profile.bundles 里、行却被市场写成了 disabled: true —— '
      + '已去掉这些行（重启应用后 preset 就能起来）',
  }
}

function discoverSkillRoots(cwd = process.cwd()) {
  const roots = []
  const push = (path, source) => {
    if (typeof path !== 'string' || path === '') return
    const abs = path.startsWith('~') ? join(homedir(), path.slice(1)) : path
    if (!roots.some((r) => r.path === abs)) roots.push({ path: abs, source })
  }

  push(join(cwd, '.dsh/skills'), 'project-dsh')
  push(join(cwd, '.agents/skills'), 'project-agents')

  // customSkillDirs：从各处组合文件里抽
  const comboFiles = []
  const profiles = listProfiles()
  for (const p of profiles) comboFiles.push({ path: p.patchPath, base: p.dir })
  // preset 也是组合文件（本包的 preset 随 bundle patch 交付，不再是 $DSH_HOME/.agent-presets/）
  for (const f of listPresetPatchFiles()) {
    comboFiles.push({ path: join(root, 'presets', f), base: join(root, 'presets') })
  }
  // 本包自己的 bundle 补丁（host 行 + skill 行 + preset 行）。
  // ⚠️ base 必须是**装了本插件的 profile 目录**，不能是本包目录：补丁里的 !!js
  //    表达式按 profile 目录求值（DESIGN.md §17），拿仓库目录当锚点会算出一个
  //    不存在的兜底路径，scanSkills 就看不到本包的 skill。
  const bundleProfile = profiles.find((p) => p.hasBundle) ?? profiles[0]
  for (const path of bundlePatchFiles()) {
    comboFiles.push({ path, base: bundleProfile === undefined ? root : bundleProfile.dir })
  }
  for (const { path, base } of comboFiles) {
    if (!existsSync(path)) continue
    let text = ''
    try {
      // 先把行尾归一成 LF：补丁在 Windows 结账（core.autocrlf）里是 CRLF，
      // 下面那两个按 `\n` 写的正则就一条都匹配不上 —— custom skill 根会在
      // Windows 开发机上凭空消失（Linux/CI 上碰巧是对的）。
      text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
    } catch { continue }
    for (const m of text.matchAll(/customSkillDirs:\s*\n((?:\s*-.*\n)+)/g)) {
      for (const line of m[1].split('\n')) {
        if (!line.trim().startsWith('-')) continue
        let value = line.replace(/^\s*-\s*/, '').trim()
        if (value.startsWith('!!js')) {
          const expr = /^!!js\s*"([\s\S]*)"$/.exec(value)
          if (expr === null) continue
          value = evalSkillExprIn(expr[1], `${pathToFileURL(base).href}/`) ?? ''
        } else {
          value = value.replace(/^['"]|['"]$/g, '')
        }
        push(value, 'custom')
      }
    }
  }

  push(join(dshHome, 'skills'), 'user-dsh')
  push(join(process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'), 'skills'), 'user-agents')
  if (process.env.DSH_BUNDLED_SKILL_DIR !== undefined) push(process.env.DSH_BUNDLED_SKILL_DIR, 'bundled')

  return roots
}

/** 按 `!!js` 语义在指定 baseUrl 下求值（与 DSL 的 `with (ctx)` 一致）。 */
function evalSkillExprIn(expr, baseUrl) {
  try {
    // eslint-disable-next-line no-new-func
    return new Function('baseUrl', `with ({ baseUrl }) { return eval(${JSON.stringify(expr)}) }`)(baseUrl)
  } catch {
    return null
  }
}

/**
 * 扫出所有根里可见的 skill（名字 → 路径 + 来源根）。
 * @param {{path:string,source:string}[]} roots
 */
function scanSkills(roots) {
  const found = new Map()
  const scanned = []
  for (const r of roots) {
    const exists = existsSync(r.path)
    let names = []
    if (exists) {
      try {
        names = readdirSync(r.path, { withFileTypes: true })
          .filter((e) => (e.isDirectory() ? existsSync(join(r.path, e.name, 'SKILL.md')) : e.name.endsWith('.md')))
          .map((e) => (e.isDirectory() ? e.name : e.name.replace(/\.md$/, '')))
      } catch { /* 读不到就当空 */ }
    }
    scanned.push({ ...r, exists, count: names.length })
    for (const n of names) if (!found.has(n)) found.set(n, { name: n, root: r.path, source: r.source })
  }
  return { skills: found, roots: scanned }
}

/** 跑一个探测命令，返回 stdout 首行（失败返回 null）。 */
async function probeBinary(binary, args) {
  const full = which(binary)
  if (full === null) return { found: false, path: null, output: null, error: null }
  try {
    const { stdout, stderr } = await run(full, args ?? [], { timeout: 20_000, maxBuffer: 1024 * 1024 })
    const line = String(stdout || stderr).trim().split('\n')[0]
    return { found: true, path: full, output: line, error: null }
  } catch (error) {
    // 命令存在但退出非零（如 Obsidian 没在运行）—— 那也是"装了"
    const detail = String(error?.stdout || error?.stderr || error?.message || '').trim().split('\n')[0]
    return { found: true, path: full, output: null, error: detail.slice(0, 200) }
  }
}

/** 展开 `~`。 */
function expandHome(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

/**
 * 展开 `~` 与环境变量模板（如 `%APPDATA%`）。
 *
 * 为什么需要它：同一个应用在三个平台上的数据目录完全不同，而 `alsoDirs` 是
 * 「装了但不在 PATH」**唯一**的兜底证据。只写 Linux 的 `~/.config/...`，
 * Windows 上就永远匹配不上 —— 于是"装了却没装"照样误报（真机实测）。
 * 变量没定义时保留原样，这样不匹配的模板会因为目录不存在而被自然过滤掉。
 */
function expandToolDir(p) {
  return expandHome(p).replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => process.env[name] ?? m)
}

// ── 随包 MCP 后端（同事不需要 Go 环境）──────────────────────────────────────
//
// ⚠️ 下面这三个值与另外两处**必须一致**，改一处就要改三处：
//   1. 这里（安装期落地）
//   2. src/host/mcpBinary.ts 的 materializedPath()（装配期自愈）
//   3. presets/gitee-*.patch.yml 里 preset 的 `command: !!js …`（运行期指向）
// 三方算出来不一致时不会有报错，只会**悄悄回落到 PATH 上的旧二进制**。

/** 二进制在包内的位置。 */
const MCP_VENDOR_DIR = join(root, 'vendor', 'mcp-gitee-ent')
/** 溯源清单（scripts/build-mcp.mjs 生成）。 */
const MCP_MANIFEST = join(MCP_VENDOR_DIR, 'manifest.json')

/** 当前平台在清单里的键（与 build-mcp.mjs / mcpBinary.ts 三处一致）。 */
function mcpPlatformKey(platform = process.platform, arch = process.arch) {
  const os = platform === 'windows' ? 'win32' : platform
  const cpu = arch === 'amd64' ? 'x64' : arch
  return `${os}-${cpu}`
}

/**
 * 二进制落地的**安装目录**（0.5.1 起 = 跨平台用户级 bin）。
 *
 * 与 `src/host/mcpBinary.ts` 的 `userBinDir()`、两个 preset 的 `!!js` 三处必须一致：
 *   · Windows：`%USERPROFILE%\.local\bin`（pipx / uv 在 Windows 的默认 bin 目录）
 *   · 其它平台：`$XDG_BIN_HOME` → `~/.local/bin`
 * MCP 后端是**公开**工具，所以不落在插件私有的 `$DSH_HOME/.gitee-chat/bin/`。
 */
function mcpInstallDir(platform = process.platform) {
  const xdg = process.env.XDG_BIN_HOME
  if (platform === 'windows' || platform === 'win32') return join(homedir(), '.local', 'bin')
  return typeof xdg === 'string' && xdg.trim() !== '' ? xdg.trim() : join(homedir(), '.local', 'bin')
}

/** 二进制落地位置（preset 里写死的就是它）。 */
function mcpTargetPath(platform = process.platform) {
  const ext = platform === 'windows' || platform === 'win32' ? '.exe' : ''
  return join(mcpInstallDir(platform), `mcp-gitee-ent${ext}`)
}

/** 0.5.0 及之前的私有位置（只用于迁移清理，见 `materializeMcp()`）。 */
function mcpLegacyPath(platform = process.platform) {
  const ext = platform === 'windows' || platform === 'win32' ? '.exe' : ''
  return join(dshHome, '.gitee-chat', 'bin', `mcp-gitee-ent${ext}`)
}

/** 目录是否在 PATH 上（Windows 不区分大小写）。 */
function isDirOnPath(dir) {
  const raw = process.env.PATH ?? process.env.Path ?? ''
  const win = process.platform === 'win32'
  const norm = (value) => {
    const trimmed = String(value).trim().replace(/[\\/]+$/, '').replace(/\\/g, '/')
    return win ? trimmed.toLowerCase() : trimmed
  }
  const wanted = norm(dir)
  return raw.split(win ? ';' : ':').some((entry) => entry.trim() !== '' && norm(entry) === wanted)
}

/** 读清单；缺失/损坏返回 null。 */
function readMcpManifest() {
  try {
    return JSON.parse(readFileSync(MCP_MANIFEST, 'utf8'))
  } catch {
    return null
  }
}

/** 文件 sha256（小写十六进制）；读不到返回 null。 */
function sha256File(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/**
 * 随包 MCP 后端的**只读**状态（不落地任何文件）。
 *
 * `matches === false` 且 `installed === true` 是「二进制被换过」的信号 ——
 * 比如有人手工放了上游 npm 版，那是**没有 create_program（建项目）**的，
 * 而 preset 的 `--enabled-toolsets` 是过滤器不是校验器，不会报错，只会静默少工具。
 */
function inspectVendoredMcp() {
  const manifest = readMcpManifest()
  const key = mcpPlatformKey()
  const entry = manifest?.platforms?.[key]
  const target = mcpTargetPath()
  const legacy = mcpLegacyPath()
  const installed = existsSync(target)
  return {
    manifest,
    key,
    /** 随包清单是否覆盖本平台。 */
    bundled: entry !== undefined,
    entry,
    target,
    installed,
    /** 已落地文件是否与清单一致（清单没覆盖本平台时为 null）。 */
    matches: entry === undefined ? null : installed && sha256File(target) === entry.sha256,
    toolCount: manifest?.toolCount ?? null,
    vendoredFileExists: entry === undefined ? false : existsSync(join(MCP_VENDOR_DIR, entry.file)),
    /** 安装目录是否在 PATH 上（Windows 默认不在，要给提示）。 */
    onPath: isDirOnPath(dirname(target)),
    /** 0.5.0 的私有残留（迁移是否完成看它）。 */
    legacy,
    legacyPresent: existsSync(legacy),
  }
}

/**
 * 清理落地过程的临时文件（`<target>.tmp-<pid>`）与 0.5.0 的私有副本。
 * 绝不抛：Windows 上旧会话可能占着 `.exe`，删不掉就留着下次再清。
 * @returns {{tmp: number, legacyRemoved: boolean}}
 */
function sweepMcpArtifacts(target, legacy) {
  let tmp = 0
  const prefix = `${basename(target)}.tmp-`
  try {
    for (const name of readdirSync(dirname(target))) {
      if (!name.startsWith(prefix)) continue
      try { rmSync(join(dirname(target), name), { force: true }); tmp += 1 } catch { /* 占用中 */ }
    }
  } catch { /* 目录不在 */ }
  let legacyRemoved = false
  try {
    if (existsSync(legacy)) {
      rmSync(legacy, { force: true })
      legacyRemoved = true
    }
    const dir = dirname(legacy)
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
  } catch { /* 占用/权限：留着 */ }
  return { tmp, legacyRemoved }
}

/**
 * 把随包二进制落到 `mcpTargetPath()`（**用户级 bin**），让 preset 的 `!!js` 表达式能取到它。
 *
 * 幂等：内容一致（size + sha256）就直接复用，不重复拷 8 MiB。
 * 与 `src/host/mcpBinary.ts` 的 `ensureMaterialized()` 是同一件事的两个入口 ——
 * 安装期先落一份，让**新会话立刻可用**，不必等到宿主重启。
 *
 * 迁移（0.5.1）：落好之后清掉 0.5.0 的私有副本 `$DSH_HOME/.gitee-chat/bin/…`；
 * 目标位置若已有**别的**二进制（自己 go install 的、上游 npm 版），先让到 `<name>.bak`。
 *
 * @returns {{ok: boolean, source: string, path: string, copied: boolean, detail: string}}
 */
function materializeMcp() {
  const info = inspectVendoredMcp()

  if (info.manifest === null) {
    return { ok: false, source: 'missing', path: info.target, copied: false, detail: `缺少随包清单 ${MCP_MANIFEST}（安装不完整）` }
  }
  if (!info.bundled) {
    return {
      ok: false, source: 'unsupported', path: info.target, copied: false,
      detail: `本平台（${info.key}）未随包提供 MCP 二进制，回落到 PATH 上的 mcp-gitee-ent`,
    }
  }
  if (!info.vendoredFileExists) {
    return { ok: false, source: 'missing', path: info.target, copied: false, detail: `清单声明的 ${info.entry.file} 不存在（安装不完整）` }
  }

  const pathHint = info.onPath
    ? ''
    : `；注意 ${dirname(info.target)} 不在 PATH 上，其它 MCP 客户端要直接调 \`${basename(info.target)}\` 需把它加进 PATH`

  if (info.matches === true) {
    const swept = sweepMcpArtifacts(info.target, info.legacy)
    return {
      ok: true, source: 'vendored', path: info.target, copied: false,
      detail: `随包 MCP 二进制已就位：${info.target}（${info.toolCount} 个工具）`
        + (swept.legacyRemoved ? '；已清掉 0.5.0 的私有副本' : '') + pathHint,
    }
  }

  try {
    mkdirSync(dirname(info.target), { recursive: true })
    sweepMcpArtifacts(info.target, info.legacy)
    // 目标已有**别的**二进制 → 让到 `.bak` 再落（只保留最近一份）。
    let backedUp = false
    if (existsSync(info.target)) {
      try {
        rmSync(`${info.target}.bak`, { force: true })
        renameSync(info.target, `${info.target}.bak`)
        backedUp = true
      } catch { /* 让不开（Windows 占用）：随包版本优先 */ }
    }
    const tmp = `${info.target}.tmp-${process.pid}`
    try {
      cpSync(join(MCP_VENDOR_DIR, info.entry.file), tmp)
      chmodSync(tmp, 0o755)
      renameSync(tmp, info.target)
    } catch (error) {
      try { rmSync(tmp, { force: true }) } catch { /* 占用中 */ }
      throw error
    }
    const swept = sweepMcpArtifacts(info.target, info.legacy)
    return {
      ok: true, source: 'vendored', path: info.target, copied: true,
      detail: `已落地随包 MCP 二进制：${info.target}（${info.toolCount} 个工具）`
        + (backedUp ? `；原文件不是随包版本，已备份为 ${info.target}.bak` : '')
        + (swept.legacyRemoved ? '；已清掉 0.5.0 的私有副本' : '') + pathHint,
    }
  } catch (error) {
    return {
      ok: false, source: 'failed', path: info.target, copied: false,
      detail: `落地失败：${error.message}`,
    }
  }
}

/**
 * 判定「使用者是不是软件开发项目的下属成员」。
 *
 * 判据（可解释，且只用一次 `gq mywork`）：
 *   我参与的项目里，**有仓库**（`reposCount > 0`）→ 是；
 *   否则我的工作项类型里出现「需求 / 缺陷 / bug」→ 是；
 *   否则 → 否。没有 token 时返回"未知"，交给 AI 问使用者，不猜。
 */
async function softwareDevSignal() {
  const token = locateToken()
  if (!token.found) {
    return { known: false, softwareDev: null, why: '没有 token，无法从 Gitee 判定；需要问使用者' }
  }
  try {
    const { stdout } = await run(process.execPath, [join(root, 'scripts/gitee/gq.mjs'), 'mywork', '--json'], {
      env: tokenEnv(), cwd: root, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    })
    const payload = JSON.parse(String(stdout).trim().split('\n').pop())
    if (payload.ok !== true) return { known: false, softwareDev: null, why: `取数失败：${payload.error ?? '未知'}` }

    const withRepos = (payload.programs ?? []).filter((p) => p.reposCount > 0)
    if (withRepos.length > 0) {
      return {
        known: true, softwareDev: true,
        why: `我参与的 ${payload.programs.length} 个项目里有 ${withRepos.length} 个带仓库`
          + `（${withRepos.slice(0, 3).map((p) => p.name).join('、')}）→ 软件开发项目`,
      }
    }
    return {
      known: true,
      softwareDev: false,
      why: `我参与的 ${(payload.programs ?? []).length} 个项目都没有仓库 → 不按软件开发项目对待`
        + '（若判断有误，直接回答"是"即可覆盖）',
    }
  } catch (error) {
    return { known: false, softwareDev: null, why: `判定异常：${String(error?.stderr || error?.message || error).slice(0, 200)}` }
  }
}

/**
 * 协作环境体检。
 * @param {{ cwd?: string, withSignal?: boolean }} [opts]
 */
async function envCheck(opts = {}) {
  const roots = discoverSkillRoots(opts.cwd ?? process.cwd())
  const { skills, roots: scannedRoots } = scanSkills(roots)
  const token = locateToken()
  const signal = opts.withSignal === false
    ? { known: false, softwareDev: null, why: '（本次未判定）' }
    : await softwareDevSignal()

  const tools = []
  for (const def of ENV_TOOLS) {
    const item = {
      id: def.id,
      label: def.label,
      scope: def.scope,
      why: def.why,
      /** 这一项对本使用者是否"必须"。future 一律不判失败。 */
      required: def.scope === 'all' || (def.scope === 'software-dev' && signal.softwareDev === true),
      /** 是否因为适用范围不符而跳过。 */
      skipped: def.scope === 'software-dev' && signal.softwareDev !== true,
      ok: false,
      binary: null,
      note: null,
      missingSkills: [],
      install: def.install ?? null,
    }

    if (def.token === true) {
      item.ok = token.found
      item.binary = token.source
      if (!token.found) {
        item.note = `未找到 token。可选位置：环境变量 ${TOKEN_ENVS.join(' / ')}，或 ${tokenFileCandidates().join(' / ')}`
      }
    } else if (def.id === 'gitee-mcp') {
      // 随包二进制优先 —— 同事不需要 Go 环境。
      //
      // 「ok」判的是**使用者还需不需要动手**，不是"本地是否已落地"：
      // 包里有这份二进制，落地是我们（apply / 宿主启动）的事，不该让使用者在
      // 装之前就看到一个红叉。所以只有"包里本身就缺"才算失败。
      const mcp = inspectVendoredMcp()
      const probe = await probeBinary(def.binary, def.probe)
      if (mcp.manifest === null) {
        item.ok = false
        item.note = `缺少随包清单 ${MCP_MANIFEST}；这个包不完整，跑 node scripts/build-mcp.mjs 重新生成`
      } else if (!mcp.bundled) {
        // 本平台未随包（如 arm64 / macOS）：回到"自己装"的老路
        item.binary = probe.path
        item.ok = probe.found
        item.note = probe.found
          ? `随包未覆盖本平台（${mcp.key}），用 PATH 上已有的：${probe.path}`
          : `随包未覆盖本平台（${mcp.key}），PATH 里也没有 \`${def.binary}\`；`
            + '自己 go install，或用 MCP_GITEE_ENT_BIN 指到已有二进制'
      } else if (!mcp.vendoredFileExists) {
        item.ok = false
        item.binary = mcp.target
        item.note = `清单声明了 ${mcp.entry.file}，但包里没有这个文件；跑 node scripts/build-mcp.mjs 重新生成`
      } else {
        // 包里有 = 就绪；下面只补充"当前落地状态"，不影响 ok。
        item.ok = true
        item.binary = mcp.target
        item.toolCount = mcp.toolCount
        if (mcp.matches === true) {
          item.note = `随包分发（无需 Go）：${mcp.target} · ${mcp.toolCount} 个工具 · sha256 与清单一致`
            + (mcp.onPath ? '' : `（${dirname(mcp.target)} 不在 PATH 上，其它 MCP 客户端要用需加 PATH）`)
        } else if (!mcp.installed) {
          item.note = `随包分发（无需 Go）：${mcp.toolCount} 个工具，尚未落地；`
            + (mcp.legacyPresent
              ? `暂用 0.5.0 的旧副本 ${mcp.legacy}，` + '`apply` 或重启 `dsh web` 会迁到用户级 bin'
              : '`apply` 或重启 `dsh web` 会自动补上')
        } else {
          item.note = `已落地的文件与随包清单 sha256 不一致（多半是上游 npm 版——它没有 create_program）；`
            + '宿主下次启动会自动覆盖回随包版本'
        }
        if (probe.found) item.note += `。PATH 上另有一份 ${probe.path}，preset 优先用随包的那份`
      }
    } else if (typeof def.binary === 'string' && def.binary !== '') {
      const probe = await probeBinary(def.binary, def.probe)
      const dirs = (def.alsoDirs ?? []).map(expandToolDir).filter((d) => existsSync(d))
      item.binary = probe.path
      item.ok = probe.found || dirs.length > 0
      if (probe.found && probe.output !== null) item.note = probe.output
      else if (probe.found && probe.error !== null && def.probeOptional === true) {
        item.note = `已安装（PATH: ${probe.path}），但当前不可用：${probe.error}`
      }
      // "装了但命令用不了"要说清楚，别只丢一个目录了事
      if (!probe.found && dirs.length > 0) {
        item.note = `装了，但 \`${def.binary}\` 不在 PATH（发现应用目录：${dirs.join('、')}）—— 命令行用不了，见上面的安装说明`
      }
      if (!item.ok) item.note = `PATH 里没有 \`${def.binary}\``
    } else {
      item.ok = def.scope === 'future' // 预留位：登记即"就绪（未接入）"
      item.note = def.install?.note ?? null
    }

    // 期望可见的 skill
    for (const name of def.skills ?? []) {
      if (!skills.has(name)) item.missingSkills.push(name)
    }
    if (item.missingSkills.length > 0 && item.ok) {
      item.note = `${item.note ?? ''} 但 skill 集缺 ${item.missingSkills.length} 个：${item.missingSkills.slice(0, 4).join('、')}${item.missingSkills.length > 4 ? '…' : ''}`
      item.ok = false
    }

    if (item.scope === 'future') item.required = false
    tools.push(item)
  }

  const requiredTools = tools.filter((t) => t.required)
  const missing = tools.filter((t) => !t.ok && !t.skipped && t.scope !== 'future').map((t) => t.id)

  return {
    ok: missing.length === 0,
    cwd: opts.cwd ?? process.cwd(),
    scope: signal,
    /** 扫过的 skill 根（换机器时先看这里：根没了，skill 自然全缺）。 */
    skillRoots: scannedRoots,
    skillCount: skills.size,
    tools,
    summary: {
      required: requiredTools.map((t) => t.id),
      ok: tools.filter((t) => t.ok).map((t) => t.id),
      missing,
      skipped: tools.filter((t) => t.skipped).map((t) => t.id),
      reserved: tools.filter((t) => t.scope === 'future').map((t) => t.id),
    },
  }
}

/** 人话版的 env 报告。 */
function renderEnv(r) {
  const L = ['▶ 协作环境体检', '']
  L.push(`  skill 根 ${r.skillRoots.length} 个（可见 skill ${r.skillCount} 个）：`)
  for (const root of r.skillRoots) {
    L.push(`    · ${root.exists ? '✓' : '·'} ${root.path}  [${root.source}, ${root.count} 个]${root.exists ? '' : ' （不存在）'}`)
  }
  L.push('')
  L.push(`  使用场景：${r.scope.known ? (r.scope.softwareDev ? '软件开发项目下属成员' : '非软件开发项目') : '未判定'} —— ${r.scope.why}`)
  L.push('')
  for (const t of r.tools) {
    const tag = t.scope === 'future' ? '[预留]' : t.skipped ? '[跳过]' : t.required ? '[必需]' : '[可选]'
    L.push(`  ${t.ok ? '✓' : t.skipped || t.scope === 'future' ? '·' : '✗'} ${t.label} ${tag}`)
    if (t.binary !== null) L.push(`      探测：${t.binary}`)
    if (t.note !== null && t.note !== '') L.push(`      说明：${t.note}`)
    if (!t.ok && !t.skipped && t.install !== null) {
      for (const [k, v] of Object.entries(t.install)) {
        if (k === 'note') continue
        L.push(`      ${k}: ${v}`)
      }
    }
  }
  L.push('')
  L.push(r.ok
    ? '协作环境齐备 ✅'
    : `缺 ${r.summary.missing.length} 项：${r.summary.missing.join('、')}（见上方每项的安装方式）`)
  L.push('  装单项：node scripts/setup.mjs env --install <id>')
  return L.join('\n')
}

// ── questions ───────────────────────────────────────────────────────────────

/**
 * 输出该问用户的问题。
 *
 * 每个问题都带 `default`（推荐值）与 `ifUnanswered`（用户说"你决定"就用它），
 * 所以 AI 可以**一个都不问**直接 apply —— 这是"无操作化"的兜底。
 */
function questions(facts, env) {
  const list = facts.enterprise.list ?? []
  const multiple = list.length > 1

  const q = []

  q.push({
    id: 'profile',
    question: `配置写到哪个 profile 的 cordis.patch.yml？`,
    why: '补丁是按 profile 生效的；写错 profile 等于没配。',
    options: facts.profiles.map((p) => ({
      value: p.name,
      label: p.name + (p.hasBundle ? '（已装本插件）' : ''),
      detail: p.patchPath,
    })),
    default: facts.targetProfile,
    ifUnanswered: facts.targetProfile,
    required: facts.profiles.length > 1,
  })

  q.push({
    id: 'enterpriseId',
    question: multiple
      ? `token 能看到 ${list.length} 个企业，固定用哪一个？`
      : '固定使用哪个企业？',
    why: '写进插件配置后在重启前一直生效。**看不到企业列表时**说明 token 还没配好，可先跳过。',
    options: [
      { value: 0, label: '不固定（自动）', detail: list.length === 1
        ? '只有一个企业，脚本会自动用它'
        : '多企业时取数会报错要求指定 —— 这是刻意的，避免拿错公司的数据' },
      ...list.map((e) => ({ value: e.id, label: `${e.name}（${e.id}）`, detail: e.path ?? '' })),
    ],
    default: list.length === 1 ? list[0].id : 0,
    ifUnanswered: 0,
    required: false,
    note: '也可以用 `gq enterprises --use <id>` 随时切换，那种方式不需要重启。',
  })

  q.push({
    id: 'allowWrites',
    question: '允许在工作项详情里直接改状态 / 改派 / 发评论吗？',
    why: '关掉就是只读部署：界面上这几个按钮会明确报错，而不是静默失败。',
    options: [
      { value: true, label: '允许（推荐）', detail: '写操作全部经唯一写入口，且要求会话处于 Gitee 模式' },
      { value: false, label: '只读', detail: '改数据请到 Gitee 网页' },
    ],
    default: true,
    ifUnanswered: true,
    required: false,
  })

  q.push({
    id: 'requiredLabels',
    question: '工作项规范要求几个标签？',
    why: '这个包默认按「职能域 × 优先级 × 阶段」= 3 个标签做规范体检。'
      + '**这是某个团队的约定，不是 Gitee 的规则** —— 你们不这么做就设成实际数量，或设 0 关闭该检查。',
    options: [
      { value: 3, label: '3 个（原团队约定）' },
      { value: 4, label: '4 个' },
      { value: 2, label: '2 个' },
      { value: 0, label: '不做标签数检查' },
    ],
    default: 3,
    ifUnanswered: 3,
    required: false,
  })

  q.push({
    id: 'weeklyCapacity',
    question: '团队每周大约能完成多少个工作项？',
    why: '用于「交付容量」卡片判断哪几周排不下（按截止日期分周）。',
    options: [
      { value: 10, label: '10 个（默认）' },
      { value: 5, label: '5 个' },
      { value: 20, label: '20 个' },
    ],
    default: 10,
    ifUnanswered: 10,
    required: false,
  })

  // 协作环境：只有"不确定是不是软件开发成员"时才问 —— 能自己判定的就不问
  const envMissing = (env?.summary?.missing ?? []).filter((id) => id === 'apifox')
  if (env !== undefined && (env.scope.softwareDev !== true || envMissing.length > 0)) {
    q.push({
      id: 'apifox',
      question: '你是「软件开发项目」的下属成员吗？（决定要不要装 Apifox 协作工具）',
      why: env.scope.known
        ? `我从 Gitee 判定为「${env.scope.softwareDev ? '是' : '否'}」：${env.scope.why}`
          + `${envMissing.length > 0 ? '，而且本机还没装好' : ''}。判断有误请直接纠正。`
        : `${env.scope.why}。软件开发成员需要 Apifox CLI + 接口协作技能集（接口文档/Mock/自动化测试）。`,
      options: [
        { value: true, label: '是，装 Apifox（推荐）', detail: 'npm i -g apifox-cli + 8 个 apifox-* skill' },
        { value: false, label: '不是，跳过', detail: '只做 Gitee 侧的项目协作' },
      ],
      default: env.scope.softwareDev === true,
      ifUnanswered: env.scope.softwareDev === true,
      required: false,
    })
  }

  q.push({
    id: 'mode',
    question: '人格（管理者 / 项目执行）怎么定？',
    why: '默认按 Gitee token 的身份关系自动推导：企业角色是管理员 → 管理者；'
      + '是某项目负责人 → 项目执行·负责人档；否则执行档。',
    options: [
      { value: 'auto', label: '自动推导（推荐）' },
      { value: 'manager', label: '强制管理者' },
      { value: 'project', label: '强制项目执行·负责人档' },
      { value: 'exec', label: '强制项目执行·执行档' },
    ],
    default: 'auto',
    ifUnanswered: 'auto',
    required: false,
  })

  return {
    /** 用户一个都不回答时，apply 用这些默认值也能得到可用配置。 */
    canRunWithDefaults: true,
    questionCount: q.length,
    /** 只需回答这几个就能装完；其余是"可选调优"。 */
    essential: ['profile', 'enterpriseId', 'allowWrites'],
    questions: q,
  }
}

// ── apply ───────────────────────────────────────────────────────────────────

/**
 * 由 answers 组装完整的插件配置。
 *
 * 「完整」指：profile 补丁里同一 id 的 `config` 是**整体替换**，所以凡是要生效的键
 * 都得写出来。**唯一的例外是 `scriptPath`**——它的默认值由宿主从包位置推导，
 * 只有「键不出现」时才生效，所以这里给的是**报告用的绝对值**，`renderBlock`
 * 刻意不把它写进补丁（写空串会把包内默认值覆盖掉，见 renderBlock 里的注释）。
 */
function buildConfig(a) {
  return {
    apiBase: a.apiBase || 'https://api.gitee.com/enterprises',
    cacheTtlSeconds: 0,
    scriptTimeoutMs: 60000,
    allowFixtureFallback: false,
    /** 实际生效的脚本位置（仅用于输出/展示；不写入补丁）。 */
    scriptPath: join(root, 'scripts', 'gitee', 'gq.mjs'),
    enterpriseId: Number(a.enterpriseId) || 0,
    roleTtlSeconds: 600,
    mode: a.mode || 'auto',
    userAgent: '',
    allowWrites: a.allowWrites !== false,
    presetIds: [],
    agentRowName: 'dsh-gitee-chat/agent',
    /**
     * 知识库文档（见 DOCS.md）。
     *
     * 这里**没有任何端点配置** —— 文档能力的唯一实现是 MCP 工具，
     * 插件只决定"缓存在哪、工具叫什么名字"。
     */
    docs: {
      root: join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'gitee', 'docs'),
      mcpToolPrefix: 'mcp__gitee_ent__',
      autoCheckOnRead: true,
      maxPageBytes: 200000,
    },
    thresholds: {
      stallDays: numOr(a.stallDays, 14),
      overloadOpen: numOr(a.overloadOpen, 8),
      overloadOverdue: numOr(a.overloadOverdue, 2),
      requiredLabels: numOr(a.requiredLabels, 3),
      weeklyCapacity: numOr(a.weeklyCapacity, 10),
      trendWeeks: numOr(a.trendWeeks, 8),
      milestoneRiskDays: numOr(a.milestoneRiskDays, 7),
    },
  }
}

/** 数字兜底（允许 0）。 */
function numOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** 生成补丁里本插件那一段（带注释，因为人会读它）。 */
function renderBlock(config, facts) {
  const L = []
  L.push(BEGIN)
  L.push('# 这一段由 `node scripts/setup.mjs apply` 生成，重跑会整段替换。')
  L.push('# 想手工改也可以：去掉哨兵注释后本脚本就不再接管它。')
  L.push('#')
  L.push('# 为什么写在 profile 补丁里：补丁在**所有 bundle 之后**应用，')
  L.push('# 且同一 id 的 `config` 是**整体替换**（不是深合并），所以这里必须是完整配置。')
  L.push('#')
  L.push('# 本次安装探测到的事实（写入时快照）：')
  L.push(`#   token      : ${facts.token.found ? facts.token.source : '未找到（取数会提示未配置）'}`)
  // ⚠️ 这里必须报**三级回落解析出来的那份**，不能报"PATH 上有没有"：
  //    0.5.1 起随包二进制落在用户级 bin（Linux 通常在 PATH 上，Windows 默认不在），
  //    而 0.5.0 的旧位置 `$DSH_HOME/.gitee-chat/bin/` 本来就不在 PATH 上。
  //    旧写法会写出「MCP 可执行 : 未找到（MCP 工具会挂不上）」——
  //    而同一轮 apply 刚把 51 个工具的二进制落地，注释自相矛盾。
  L.push(`#   MCP 可执行 : ${facts.mcpBinary.found
    ? `${facts.mcpBinary.path}（${facts.mcpBinary.source === 'bundled' ? '随包分发，无需 Go' : facts.mcpBinary.source === 'env' ? 'MCP_GITEE_ENT_BIN 指定' : 'PATH 上'}）`
    : `未找到（MCP 工具会挂不上）—— ${facts.mcpBinary.detail}`}`)
  L.push(`#   企业列表   : ${facts.enterprise.list === null ? '取不到' : facts.enterprise.list.map((e) => `${e.name}(${e.id})`).join('、') || '空'}`)
  L.push('')
  L.push(`- id: ${ROW_ID}`)
  L.push('  config:')
  L.push(`    # Gitee 企业版 API base（私有化部署时改这里）。`)
  L.push(`    apiBase: ${yamlScalar(config.apiBase)}`)
  L.push(`    # 传给 gq 脚本的同参数短时缓存秒数（0 = 关闭）。只写 /tmp，不是数据库。`)
  L.push(`    cacheTtlSeconds: ${yamlScalar(config.cacheTtlSeconds)}`)
  L.push(`    # 单次脚本执行超时（毫秒）。`)
  L.push(`    scriptTimeoutMs: ${yamlScalar(config.scriptTimeoutMs)}`)
  L.push(`    # 无 token 时是否降级成样例数据渲染。false = 宁可明确报错，也不让人误以为是真数据。`)
  L.push(`    allowFixtureFallback: ${yamlScalar(config.allowFixtureFallback)}`)
  // scriptPath **故意不写**：省略 = 用包内 scripts/gitee/gq.mjs。
  // 写成 `scriptPath: ''` 曾经导致整个看板「取数失败」——补丁里的 config 是整体替换，
  // 空串会覆盖掉包内默认值，宿主于是执行 `node '' <子命令>`，而 Node 把空脚本名
  // 当成「从 stdin 读」，stdin 立即 EOF → 退出码 0、零输出 → 只能报「输出不是 JSON」。
  // 现在宿主已把空串当「未设置」处理，但注释掉仍然是更准确的表达。
  L.push(`    # 留空/省略 = 用包内自带的 scripts/gitee/gq.mjs；要指到别处再取消注释。`)
  L.push(`    # scriptPath: '/abs/path/to/gq.mjs'`)
  L.push(`    # 固定企业 id。0 = 自动（只有一个企业时用它；多个企业时**报错要求指定**，绝不猜）。`)
  L.push(`    enterpriseId: ${yamlScalar(config.enterpriseId)}`)
  L.push(`    # 身份/人格解析缓存（秒）。`)
  L.push(`    roleTtlSeconds: ${yamlScalar(config.roleTtlSeconds)}`)
  L.push(`    # 人格模式：auto（按身份推导）/ manager / project / exec（人工强制）。`)
  L.push(`    mode: ${yamlScalar(config.mode)}`)
  L.push(`    # 企业版端点要求的应用标识 UA。留空 = 用脚本内置默认值。`)
  L.push(`    userAgent: ${yamlScalar(config.userAgent)}`)
  L.push(`    # 是否允许在工作项详情里改状态 / 改派 / 发评论（唯一写入口）。`)
  L.push(`    allowWrites: ${yamlScalar(config.allowWrites)}`)
  L.push(`    # 显式列出哪些 preset id 算 Gitee 模式。留空 = 按事实判定（读 preset 组合里有没有挂 agentRowName）。`)
  L.push(`    presetIds: ${yamlScalar(config.presetIds)}`)
  L.push(`    # 组合里代表本插件的行名。`)
  L.push(`    agentRowName: ${yamlScalar(config.agentRowName)}`)
  // 知识库文档：只配"缓存在哪、MCP 工具叫什么"，**没有任何端点**（DOCS.md §7）。
  L.push('    # 知识库文档（见 DOCS.md）。文档能力的唯一实现是 MCP 工具，这里不配任何端点。')
  L.push('    docs:')
  L.push(`      root: ${yamlScalar(config.docs.root)}            # 按需缓存的本地根（不是镜像，只存读过的页）`)
  L.push(`      mcpToolPrefix: ${yamlScalar(config.docs.mcpToolPrefix)}  # 必须与 preset 里 mcp-gitee 行的 serverName 一致`)
  L.push(`      autoCheckOnRead: ${yamlScalar(config.docs.autoCheckOnRead)}       # 读本地前是否先核一次远程 version`)
  L.push(`      maxPageBytes: ${yamlScalar(config.docs.maxPageBytes)}         # 单页正文落盘上限（字符）`)
  L.push(`    # 固定分析阈值。设 requiredLabels: 0 表示关闭标签数检查。`)
  L.push('    thresholds:')
  L.push(`      stallDays: ${yamlScalar(config.thresholds.stallDays)}          # 进行中且多少天没更新算停滞`)
  L.push(`      overloadOpen: ${yamlScalar(config.thresholds.overloadOpen)}        # 过载判定：未完成数下限`)
  L.push(`      overloadOverdue: ${yamlScalar(config.thresholds.overloadOverdue)}     # 过载判定：逾期数下限`)
  L.push(`      requiredLabels: ${yamlScalar(config.thresholds.requiredLabels)}      # 规范要求的标签数（0 = 关闭）`)
  L.push(`      weeklyCapacity: ${yamlScalar(config.thresholds.weeklyCapacity)}     # 每周交付容量（项）`)
  L.push(`      trendWeeks: ${yamlScalar(config.thresholds.trendWeeks)}         # 交付趋势回看周数`)
  L.push(`      milestoneRiskDays: ${yamlScalar(config.thresholds.milestoneRiskDays)}  # 里程碑「有风险」的剩余天数窗口`)
  L.push(END)
  return L
}

/**
 * 把生成的段落写进补丁文件（**保留其余全部内容**）。
 *
 * 这一步是"使用者无操作"能成立的关键：补丁文件里可能有别人的手写配置，
 * 我们只换自己那一段，其余字节原样不动。
 *
 * @returns {{ text: string, mode: 'insert' | 'replace' }}
 */
function splicePatch(original, blockLines) {
  let text = original.replace(/\r\n/g, '\n')
  // dsh 初始 patch 模板形如「几行注释 + `[]`」。`[]` 是空数组占位，
  // 直接在其后追加列表项会产出无 `---` 分隔的双文档，dsh 解析报
  // "end of the stream or a document separator is expected"。
  // 去掉独立成行的空数组占位，让 managed 段成为文件唯一的 YAML 文档。
  text = text.replace(/(^|\n)[ \t]*\[\][ \t]*(?=\n|$)/g, '$1')
  const existing = extractBlock(text)

  if (existing === null) {
    const base = text.replace(/\s*$/, '')
    const head = base === '' ? '' : `${base}\n\n`
    return { text: `${head}${blockLines.join('\n')}\n`, mode: 'insert' }
  }

  const lines = text.split('\n')
  // 别人的行（市场/用户插进哨兵段里的）挪到哨兵之后，不能跟着旧段一起消失
  const preserved = preservedRowsInBlock(lines.slice(existing.start, existing.end))
  const out = [...lines.slice(0, existing.start), ...blockLines, ...preserved, ...lines.slice(existing.end)]
  // 折叠掉替换后可能出现的多余空行（不碰文件头部注释）
  return { text: `${out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '')}\n`, mode: 'replace' }
}

/** 按行打印两段文本的差异（够用即可）。 */
function diffLines(before, after) {
  const a = before.split('\n')
  const b = after.split('\n')
  const out = []
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue
    if (a[i] !== undefined && !b.includes(a[i])) out.push(`- ${a[i]}`)
    if (b[i] !== undefined && !a.includes(b[i])) out.push(`+ ${b[i]}`)
  }
  return out
}

/**
 * 检查 skill 的挂载状况。
 *
 * skill **不往别处拷贝**：真源是 `<包>/skills/<name>/SKILL.md`，由本包 bundle
 * 补丁（0.4.5 起是 `cordis.skills.patch.yml`）里的 `gitee-chat-skills` 行挂一个
 * skill provider 指向它。
 * 所以这里只回答三件事：文件在不在、补丁里声明的行在不在、那行的解析结果是不是本包目录。
 */
function inspectSkill(packageRoot = root, anchor = null) {
  // ⚠️ customSkillDirs 的元素是**根目录**：每个直接子目录里放一个 SKILL.md。
  //    所以声明的根是 <包>/skills，而这个 skill 的真源在 <包>/skills/<name>/SKILL.md。
  const dir = join(packageRoot, 'skills')
  const file = join(dir, SKILL_NAME, 'SKILL.md')
  const fileExists = existsSync(file)

  // ⚠️ 0.4.5 起这一行在 cordis.skills.patch.yml（host 行那个文件必须留成纯
  //    insert 供插件市场热挂载，见 DESIGN.md §35），所以读 dsh.bundle.patch
  //    声明的**全部**补丁文件，不写死文件名。
  const patchFiles = bundlePatchFiles(packageRoot)
  const patchPath = patchFiles.length > 0 ? patchFiles.join(' + ') : join(packageRoot, 'cordis.patch.yml')
  let rowDeclared = false
  let declaredDir = null
  try {
    const text = bundlePatchText(packageRoot)
    rowDeclared = text.includes('id: ' + SKILL_ROW_ID)
    // 抓出 !!js 表达式并按同样的语义算一遍：从 profile 目录解析本包
    const m = /customSkillDirs:\s*\n\s*-\s*!!js\s*"([^"]+)"/.exec(text)
    if (m !== null) declaredDir = evalSkillExpr(m[1], anchor ?? defaultSkillAnchor())
  } catch { /* 读不到就按未声明处理 */ }

  // 那行解析出来的目录里，真的躺着这个 skill 吗？
  // ⚠️ 判据必须是"解析结果里有没有 SKILL.md"，**不是**"解析结果 == 本包 skills/"。
  //    后者只对 `link:` 装法成立：`file:`（官方推荐的真目录装法）会把包复制进
  //    profiles/<name>/node_modules/，于是解析到的是**副本**目录，路径当然不等于源码
  //    目录 —— 真机上因此稳定误报「skill 未生效 ❌」，而它其实是好的。
  const resolvedSkillFile = declaredDir === null ? null : join(declaredDir, SKILL_NAME, 'SKILL.md')
  const resolvesToSource = declaredDir !== null && realpathOrNull(declaredDir) === realpathOrNull(dir)

  return {
    /** 真源文件（随包分发，不需要安装）。 */
    path: file,
    dir,
    fileExists,
    /** 本包补丁里声明了挂载行吗？ */
    rowDeclared,
    patchPath,
    /** 那行解析出来的根目录（`file:` 装法下指向副本，不是本包源码目录）。 */
    resolvesTo: declaredDir,
    /** 解析出来的目录里那个 SKILL.md（真正会被 DSH 加载的那份）。 */
    resolvedSkillFile,
    /** 解析结果 == 本包源码目录？true 只可能是 `link:` 装法。 */
    resolvesToSource,
    /** `link:`（同一份）还是 `file:`（副本）。 */
    installedAs: declaredDir === null ? null : resolvesToSource ? 'link' : 'file',
    /** 是否真的会被 DSH 加载。 */
    effective: fileExists && rowDeclared && resolvedSkillFile !== null && existsSync(resolvedSkillFile),
    how: '随包分发：由本包 bundle 补丁（cordis.skills.patch.yml）的 gitee-chat-skills 行挂 skill provider 指向本包 skills/（用户级可见，热加载，无需重启）',
  }
}

/** realpath，失败返回原串（用于"是不是同一个目录"这种判断）。 */
function realpathOrNull(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** `!!js` 表达式求值时的 baseUrl：装了本插件的那个 profile 目录。 */
function defaultSkillAnchor() {
  const profiles = listProfiles()
  const withBundle = profiles.find((p) => p.hasBundle) ?? profiles[0]
  return withBundle === undefined ? `file://${dshHome}/` : `file://${withBundle.dir}/`
}

/**
 * 按 `!!js` 的语义求值一行 skill 表达式。
 * `baseUrl` = profile 目录（实测结论，见 DESIGN.md §17）；这里用一个能解析到本包的锚点。
 */
function evalSkillExpr(expr, anchor = null) {
  const profileAnchor = anchor ?? defaultSkillAnchor()
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('baseUrl', `with ({ baseUrl }) { return eval(${JSON.stringify(expr)}) }`)
    return fn(profileAnchor)
  } catch {
    return null
  }
}

/**
 * 执行安装。
 * @param {Record<string, unknown>} answers - AI/用户给出的答案（可只给一部分）。
 * @param {{ dryRun?: boolean }} opts
 */
async function apply(answers, opts = {}) {
  const facts = await detect()
  const profileName = String(answers.profile ?? facts.targetProfile ?? '')
  const profile = facts.profiles.find((p) => p.name === profileName)
  if (profile === undefined) {
    throw new Error(`找不到 profile "${profileName}"。可用：${facts.profiles.map((p) => p.name).join('、') || '(无)'}`)
  }

  const config = buildConfig(answers)
  const block = renderBlock(config, facts)

  // ① profile 补丁。
  //    先去掉插件市场（dshmarket）可能留下的半状态残留（本插件的行被写成
  //    disabled: true 且不在托管段里），再写自己的托管段（见 DESIGN.md §35）。
  const original = existsSync(profile.patchPath) ? readFileSync(profile.patchPath, 'utf8') : ''
  const halfStateRemoved = foreignDisabledRows(original)
  const spliced = splicePatch(stripForeignDisabledRows(original).text, block)
  const patchChanged = spliced.text !== original

  // ② 本地企业配置（不需要重启就能切换的那种）
  //
  // 答案里**没给**企业 id（=0）时保留本地已选的那家：设置页也能选企业，
  // 重跑一次安装不该把使用者在界面上选好的公司静默清掉（见 DESIGN.md §36）。
  const configPath = join(dshHome, '.gitee-chat', 'config.json')
  const beforeLocal = readJson(configPath) ?? {}
  const answeredEnterprise = Number(answers.enterpriseId ?? 0)
  const localEnterpriseId = answeredEnterprise > 0
    ? answeredEnterprise
    : (Number(beforeLocal.enterpriseId ?? 0) || 0)
  const afterLocal = { ...beforeLocal, enterpriseId: localEnterpriseId }

  const result = {
    ok: true,
    dryRun: opts.dryRun === true,
    profile: profileName,
    config,
    patch: {
      path: profile.patchPath,
      mode: spliced.mode,
      changed: patchChanged,
      backup: null,
      diff: opts.dryRun === true ? diffLines(original, spliced.text).slice(0, 60) : [],
    },
    /** 市场半状态：本次从 profile 补丁里去掉的 disabled: true 行（本插件行 id）。 */
    halfState: { removed: halfStateRemoved, fixed: halfStateRemoved.length > 0 },
    localConfig: { path: configPath, before: beforeLocal, after: afterLocal },
    skill: null,
    presets: null,
    nextSteps: [],
    /** 非故障的说明（例如桌面版裸导入探针的假阴性），与 warnings 分开渲染。 */
    notes: [],
  }

  if (answeredEnterprise <= 0 && localEnterpriseId > 0) {
    result.notes.push(
      `本地企业配置保留了上次选择的企业 ${localEnterpriseId}：本次安装没有指定企业 id，`
      + '补丁里 enterpriseId=0 表示「不钉企业」，所以在设置页里选的那家继续生效。',
    )
  }

  if (opts.dryRun === true) {
    result.presets = { ok: true, message: '(dry-run 未写入)' }
    return result
  }

  // 写补丁（先备份）
  if (patchChanged) {
    if (original !== '') {
      const backup = `${profile.patchPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`
      writeFileSync(backup, original)
      result.patch.backup = backup
    } else {
      mkdirSync(dirname(profile.patchPath), { recursive: true })
    }
    writeFileSync(profile.patchPath, spliced.text)
  }

  // 写本地企业配置
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(afterLocal, null, 2) + '\n')

  // skill 不安装：它随包分发，由本包补丁挂载（见 inspectSkill 的注释）
  result.skill = inspectSkill()

  // 随包 MCP 后端落地 —— 让新会话立刻能用，不必等宿主重启。
  // （宿主装配时也会做一次，那是自愈；这里是"装完就能用"。）
  result.mcp = materializeMcp()

  // preset 随本包 bundle patch 交付，装配期组合 —— 这里没有"安装"这一步，只有交付自检。
  try {
    const { stdout } = await run(process.execPath, [join(root, 'scripts/check-presets.mjs'), '--check'], { cwd: root, timeout: 60_000 })
    result.presets = { ok: true, message: String(stdout).trim().split('\n').filter(Boolean).slice(-2).join(' / ') }
  } catch (error) {
    result.presets = { ok: false, message: String(error?.stderr || error?.message || error).slice(0, 400) }
    result.ok = false
  }

  // agent 半的可解析性：`link:` 安装的死穴（见本文件上面那一段）。
  // 必须放在 preset 装完之后 —— 它探的就是 preset 里那一行能否 import。
  const bundleProfile = facts.profiles.find((p) => p.hasBundle) ?? profile
  result.agentHalf = await ensureAgentHalf(bundleProfile.dir)
  if (result.agentHalf.repair?.action === 'linked') {
    result.agentHalf.link = `${result.agentHalf.repair.dest} → ${result.agentHalf.repair.source}`
  }
  // 桌面版：宿主自带 @deepseek-ai 闭包，裸导入探针必假阴性 ⇒ 不算安装失败（见 isDesktopManagedProfile）
  if (result.agentHalf.present && !result.agentHalf.ok && result.agentHalf.hostSuppliesClosure !== true) result.ok = false

  // 装配后自检
  const after = await detect()
  result.problems = after.problems

  // 协作环境缺口：本插件装好了 ≠ 能协作
  const env = await envCheck()
  result.env = {
    ok: env.ok,
    missing: env.summary.missing,
    softwareDev: env.scope.softwareDev,
    why: env.scope.why,
    /** 缺的每一项怎么装（直接转述给使用者/自己执行）。 */
    howTo: env.tools.filter((t) => !t.ok && !t.skipped).map((t) => ({ id: t.id, label: t.label, install: t.install })),
  }

  const warnings = []
  if (!after.token.found) {
    warnings.push('还没有 Gitee token —— 取数会提示「未配置 token」，界面不会显示空数据。'
      + '在应用「设置 → Gitee 企业项目」里粘贴保存即可（0.4.1 起，即时生效）。')
  }
  if (!result.mcp.ok && !after.mcpBinary.found) {
    warnings.push(`MCP 后端不可用（${after.mcpBinary.detail}）—— MCP 工具用不了（标签页与固定分析不受影响）。`
      + '本平台随包时不缺 Go：跑一次 apply 会落地那份二进制。')
  }
  if (!after.presets.installed.includes('gitee')) warnings.push('preset 未就位 —— 会话里选不到「Gitee 项目管理」。')
  // 0.5.4 把两个模式合成一个；老 profile 里残留的 exec preset 要提示手动删掉。
  if (after.presets.installed.includes('gitee-exec')) {
    warnings.push('检测到旧的 `gitee-exec` preset（0.5.4 起已合并为 `gitee`）—— 在 Agent 预设里删掉那条，避免出现重复入口。')
  }
  if (result.agentHalf !== undefined && result.agentHalf.present && !result.agentHalf.ok) {
    const probe = result.agentHalf.probeAfter ?? result.agentHalf.probe
    if (result.agentHalf.hostSuppliesClosure === true) {
      // 桌面版：探针必假阴性（见 isDesktopManagedProfile），写成说明而不是故障
      result.notes.push('agent 半的裸导入探针在桌面版上是假阴性，不算故障：'
        + `本机报 ${probe.error}，`
        + '因为桌面版把 @deepseek-ai/* 依赖闭包放在 app.asar 里、由**宿主**提供解析；'
        + 'profile 里装的 dsh-context / dsh-cost-meter 同样裸导入 @deepseek-ai/* ，也用同样方式加载。'
        + 'preset 里那行能否起来以界面实测为准：新建会话能选到「Gitee 项目管理」并正常建起，就说明没问题。')
    } else {
      warnings.push(`agent 半 import 不了：${probe.error}`
        + ' —— preset 里那行 `dsh-gitee-chat/agent` 起不来，会话建不起来，'
        + '界面表现是「选了工作区没反应」。'
        + (result.agentHalf.repair?.note === null || result.agentHalf.repair?.note === undefined
          ? ''
          : `（${result.agentHalf.repair.note}）`)
        + ' 兜底：改用真目录装法 `dsh plugin --profile <name> add file:<本包目录>`。')
    }
  }
  result.warnings = warnings

  result.nextSteps = [
    '**刷新浏览器页面**即可（配置改动会热重载，几秒内生效）。',
    '只有当本次安装改了插件**代码**（`lib/`）时才需要重启 `dsh web`。',
    '新建会话时选择「Gitee 项目管理」预设。',
    '打开会话里的「Gitee 项目」标签页，点右上角「刷新」。',
  ]
  if (result.env.missing.length > 0) {
    result.nextSteps.unshift(`协作环境还缺 ${result.env.missing.join('、')}：`
      + '`node scripts/setup.mjs env --install <id>` 装单项，或按上面的 install 说明手工装。')
  }
  if (warnings.length > 0) result.nextSteps.unshift('先解决上面的 warning。')
  if (result.agentHalf?.repair?.action === 'linked') {
    result.nextSteps.unshift(`已给 \`link:\` 安装补一跳（${result.agentHalf.link}）：agent 半的裸导入现在解析得到，`
      + '起会话不会再用「选了工作区没反应」的方式失败。'
      + '这是 `link:` 装法的固有限制（模块 realpath 在 profiles/** 之外），重装插件后重跑 apply 即可。')
  }

  return result
}

// ── verify ──────────────────────────────────────────────────────────────────

/** 装配后自检：给人类可读的结论。 */
async function verify() {
  const facts = await detect()
  const lines = []
  let bad = 0

  const mark = (ok, text, hint) => {
    if (!ok) bad++
    lines.push(`  ${ok ? '✓' : '✗'} ${text}${ok || hint === undefined ? '' : `\n      → ${hint}`}`)
  }

  lines.push('▶ dsh-gitee-chat 装配自检')
  lines.push('')
  lines.push(`  环境：DSH_HOME=${facts.dshHome}  包=${facts.root}  v${facts.version ?? '?'}`)
  lines.push('')

  mark(facts.token.found, `token：${facts.token.found ? facts.token.source : '未找到'}`,
    '在应用「设置 → Gitee 企业项目」里粘贴保存（0.4.1 起，推荐、即时生效）；'
    + `或设环境变量 ${TOKEN_ENVS[0]} / 写入 ${facts.tokenFileCandidates[0]}`)

  // MCP 后端：随包二进制优先，PATH 只是备用。
  const mcpState = inspectVendoredMcp()
  if (mcpState.manifest === null) {
    mark(false, 'MCP 后端：随包清单缺失（这个包不完整）',
      'node scripts/build-mcp.mjs   # 重新编译并写入 vendor/mcp-gitee-ent/')
  } else if (!mcpState.bundled) {
    // 本平台未随包：老实说清楚，并给出替代路径
    mark(facts.mcpBinary.found,
      `MCP 后端：本平台（${mcpState.key}）未随包 · ${facts.mcpBinary.detail}`,
      '用 MCP_GITEE_ENT_BIN 指到已有二进制，或自己 go install gitee.com/oschina/dsh-mcp-gitee-ent')
  } else if (!mcpState.vendoredFileExists) {
    mark(false, `MCP 后端：清单声明了 ${mcpState.entry.file}，但包里没有这个文件`,
      'node scripts/build-mcp.mjs   # 重新生成随包二进制')
  } else if (mcpState.matches === true) {
    mark(true, `MCP 后端：随包分发（无需 Go）· ${mcpState.toolCount} 个工具 · sha256 与清单一致`,
      mcpState.onPath
        ? (mcpState.legacyPresent ? `rm -f ${mcpState.legacy}   # 清掉 0.5.0 的私有副本` : undefined)
        : `把 ${dirname(mcpState.target)} 加进 PATH，其它 MCP 客户端也能直接用 mcp-gitee-ent`)
  } else {
    // 包里有、但本地落地的不对 → 不是失败（宿主下次启动会自愈），但必须说出来
    const why = mcpState.installed
      ? '已落地的文件与随包清单不一致（多半是上游 npm 版——它没有 create_program，建项目会静默不可用）'
      : '尚未落地'
    mark(true, `MCP 后端：随包分发（无需 Go）· ${mcpState.toolCount} 个工具 · ${why}`,
      mcpState.installed
        ? `rm -f ${mcpState.target} && node scripts/setup.mjs apply   # 覆盖回随包版本`
        : 'node scripts/setup.mjs apply   # 落地随包二进制')
  }
  mark(facts.skill.effective,
    `skill：${facts.skill.effective
      ? `${facts.skill.resolvedSkillFile}${facts.skill.installedAs === 'file' ? '（file: 装法，加载的是副本）' : ''}`
      : '未生效'}`,
    facts.skill.fileExists
      ? `本包 bundle 补丁（cordis.skills.patch.yml）里的 gitee-chat-skills 行缺失，或它解析到 ${facts.skill.resolvesTo} 而那里没有 SKILL.md（见 DESIGN.md §17）`
      : `仓库里缺少 ${facts.skill.path}`)

  const expected = facts.presets.expected
  const missing = expected.filter((p) => !facts.presets.installed.includes(p))
  mark(missing.length === 0,
    `preset：${facts.presets.installed.join('、') || '(无)'}${missing.length > 0 ? `（缺 ${missing.join('、')}）` : ''}`,
    'node scripts/check-presets.mjs   # preset 随 bundle 补丁交付；缺了先看它')

  const withBundle = facts.profiles.filter((p) => p.hasBundle)
  mark(withBundle.length > 0,
    `profile bundle：${withBundle.map((p) => p.name).join('、') || '(没有 profile 装了本插件)'}`,
    'dsh plugin --profile <name> add <本包目录>')

  // 插件市场半状态：包在 dsh.profile.bundles 里、行却被写成 disabled: true。
  // 界面表现是 Gitee preset 还在列表里却红标「加载失败」（见 DESIGN.md §35）。
  const halfState = facts.profiles.filter((p) => (p.disabledRows?.length ?? 0) > 0 && p.hasBundle)
  mark(halfState.length === 0,
    halfState.length === 0
      ? '插件市场半状态：无'
      : '插件市场半状态：' + halfState.map((p) => p.name + ' 的 ' + p.disabledRows.join('、')).join('；') + ' 被写成 disabled: true',
    'node scripts/setup.mjs repair   # 去掉这些行；apply 也会顺手做这一步')

  // agent 半能不能真 import —— 只有这一步探的是 preset 里那一行本身
  if (facts.agentHalf !== null && facts.agentHalf.present) {
    const hostSupplied = facts.agentHalf.ok ? false : facts.agentHalf.hostSuppliesClosure === true
    mark(facts.agentHalf.ok || hostSupplied,
      `agent 半：${facts.agentHalf.ok
        ? `可 import ✓（装法 ${facts.agentHalf.spec ?? '?'}）`
        : hostSupplied
          ? '裸导入探针在桌面版不适用（宿主自带 @deepseek-ai 闭包）—— 不算失败'
          : `import 失败（${facts.agentHalf.error}）`}`,
      'node scripts/setup.mjs apply   # 会给 link: 安装自动补一跳；或改用 add file:<本包目录>')
  }

  for (const p of facts.profiles) {
    if (!p.hasBundle && p.currentConfig?.present !== true) continue
    const c = p.currentConfig
    mark(true, `profile ${p.name} 的补丁：${c?.present === true ? `已写入（enterpriseId=${c.config?.enterpriseId ?? '?'}, allowWrites=${c.config?.allowWrites ?? '?'}, requiredLabels=${c.config?.thresholds?.requiredLabels ?? '?'}）` : '未写入本插件配置'}`)
  }

  // 协作环境（git / Obsidian / MCP / token / Apifox）
  const env = await envCheck({ withSignal: facts.token.found })
  // 分母排除 future：预留位不该把"就绪 6/5"这种数字算出来
  const envConsidered = env.tools.filter((t) => t.scope !== 'future')
  mark(env.ok, `协作环境：${envConsidered.filter((t) => t.ok).length}/${envConsidered.length} 项就绪`
    + (env.summary.missing.length > 0 ? `（缺 ${env.summary.missing.join('、')}）` : '')
    + (env.summary.skipped.length > 0 ? `（跳过 ${env.summary.skipped.join('、')}）` : '')
    + `｜场景：${env.scope.known ? (env.scope.softwareDev ? '软件开发项目成员' : '非软件开发项目') : '未判定'}`
    + `｜预留位 ${env.summary.reserved.length} 个`,
    'node scripts/setup.mjs env   # 看每一项的安装方式')

  // 真实取数：只有 token 在才试
  if (facts.token.found) {
    lines.push('')
    try {
      const { stdout } = await run(process.execPath, [join(root, 'scripts/gitee/gq.mjs'), 'health', '--json'], {
        env: tokenEnv(), cwd: root, timeout: 40_000, maxBuffer: 4 * 1024 * 1024,
      })
      const health = JSON.parse(String(stdout).trim())
      if (health.ok === true) {
        lines.push(`  ✓ 取数连通：企业 ${health.enterprise?.name || '(未命名)'}（${health.enterprise?.id}）· 样例项目数 ${health.programsSeen}`)
      } else {
        bad++
        lines.push(`  ✗ 取数失败（${health.stage}）：${health.message}`)
        if (Array.isArray(health.candidates)) lines.push(`      → token 可选位置：${health.candidates.join(' / ')}`)
      }
    } catch (error) {
      bad++
      lines.push(`  ✗ 取数自检无法执行：${String(error?.stderr || error?.message || error).slice(0, 200)}`)
    }
  } else {
    lines.push('')
    lines.push('  · 跳过取数连通性检查（没有 token）')
  }

  lines.push('')
  if (facts.enterprise.list !== null && facts.enterprise.list.length > 1 && facts.enterprise.localFile === 0) {
    const cfgProfile = facts.profiles.find((p) => p.currentConfig?.present === true)?.currentConfig?.config
    if ((cfgProfile?.enterpriseId ?? 0) === 0) {
      lines.push('  ⚠ 你有多个企业且没有固定使用哪一个：取数会**报错要求指定**（这是刻意的，避免拿错公司的数据）。')
      lines.push('      最简单：在应用「设置 → Gitee 企业项目 → 当前企业」里直接选（立即生效，不用重启）。')
      lines.push('      或（不需要重启）：node scripts/gitee/gq.mjs enterprises --use <id>')
      lines.push(`      或固定进配置：node scripts/setup.mjs apply --answers '{"enterpriseId":<id>}'`)
      lines.push('')
    }
  }

  lines.push(bad === 0
    ? '自检通过 ✅ 记得重启 `dsh web` 让 host 半的新配置生效。'
    : `${bad} 项待处理 ❌（见上面的 → 提示）`)
  return { ok: bad === 0, bad, text: lines.join('\n'), facts }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/** 极简参数解析。 */
function parseArgv(argv) {
  const cmd = argv[0] ?? 'detect'
  const flags = {}
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) flags[key] = true
    else { flags[key] = next; i++ }
  }
  return { cmd, flags }
}

/** 读 answers：`--answers -` 从 stdin，`--answers <path>` 从文件，`--answers '<json>'` 直接给。 */
function readAnswers(flag) {
  if (flag === undefined || flag === true) return {}
  if (flag === '-') return JSON.parse(readFileSync(0, 'utf8'))
  if (existsSync(flag)) return JSON.parse(readFileSync(flag, 'utf8'))
  return JSON.parse(String(flag)) // 直接给 JSON 串
}

async function main() {
  const { cmd, flags } = parseArgv(process.argv.slice(2))
  const asJson = flags.json === true

  if (cmd === 'detect') {
    const facts = await detect()
    process.stdout.write(asJson ? JSON.stringify(facts, null, 2) + '\n' : renderDetect(facts) + '\n')
    process.exit(0)
  }

  if (cmd === 'questions') {
    const facts = await detect()
    const q = questions(facts, await envCheck())
    process.stdout.write(asJson ? JSON.stringify(q, null, 2) + '\n' : renderQuestions(q) + '\n')
    process.exit(0)
  }

  if (cmd === 'apply') {
    const answers = readAnswers(flags.answers)
    const result = await apply(answers, { dryRun: flags['dry-run'] === true })
    if (asJson) process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    else {
      const L = []
      L.push(result.dryRun ? '▶ 预演（未写盘）' : '▶ 安装完成')
      L.push(`  profile      : ${result.profile}`)
      L.push(`  补丁         : ${result.patch.path}（${result.patch.mode === 'insert' ? '新增本插件段落' : '替换本插件段落'}${result.patch.changed ? '' : '，内容无变化'}）`)
      if (result.patch.backup !== null) L.push(`  备份         : ${result.patch.backup}`)
      if (result.dryRun) { L.push('  将要写入的差异：'); for (const d of result.patch.diff) L.push(`    ${d}`) }
      if (result.halfState?.removed?.length > 0) {
        L.push('  半状态修复   : 去掉市场留下的 disabled 行（' + result.halfState.removed.join('、') + '）')
      }
      L.push(`  企业         : ${result.config.enterpriseId === 0 ? '不固定（自动）' : result.config.enterpriseId}`)
      L.push(`  写通道       : ${result.config.allowWrites ? '开' : '只读'}`)
      L.push(`  标签数检查   : ${result.config.thresholds.requiredLabels === 0 ? '关闭' : result.config.thresholds.requiredLabels + ' 个'}`)
      L.push(`  每周容量     : ${result.config.thresholds.weeklyCapacity} 项`)
      L.push(`  skill        : ${result.skill?.effective ? '随包挂载 ✓（无需安装）' : '未生效（见 verify）'}`)
      L.push(`  preset       : ${result.presets?.message ?? '-'}`)
      if (result.warnings?.length > 0) { L.push('  待处理：'); for (const w of result.warnings) L.push(`    ⚠ ${w}`) }
      if (result.notes?.length > 0) { L.push('  说明：'); for (const n of result.notes) L.push(`    · ${n}`) }
      L.push('  下一步：')
      for (const s of result.nextSteps ?? []) L.push(`    · ${s}`)
      process.stdout.write(L.join('\n') + '\n')
    }
    process.exit(result.ok === false ? 1 : 0)
  }

  if (cmd === 'env') {
    const env = await envCheck()
    if (flags.install !== undefined) {
      const id = String(flags.install)
      const tool = ENV_TOOLS.find((t) => t.id === id)
      if (tool === undefined) {
        process.stderr.write(`未知工具：${id}。可选：${ENV_TOOLS.map((t) => t.id).join(' / ')}\n`)
        process.exit(2)
      }
      const auto = tool.install?.auto
      if (!Array.isArray(auto)) {
        process.stdout.write(`「${tool.label}」没有可自动执行的安装命令，按说明手工装：\n`)
        for (const [k, v] of Object.entries(tool.install ?? {})) if (k !== 'note') process.stdout.write(`  ${k}: ${v}\n`)
        process.exit(1)
      }
      const [bin, argv] = auto
      process.stdout.write(`▶ 执行：${bin} ${argv.join(' ')}\n`)
      try {
        const { stdout, stderr } = await run(bin, argv, { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })
        process.stdout.write(String(stdout) + String(stderr))
      } catch (error) {
        process.stderr.write(String(error?.stdout ?? '') + String(error?.stderr ?? error?.message ?? error))
        process.stderr.write(`\n安装失败。按说明手工装：${JSON.stringify(tool.install)}\n`)
        process.exit(1)
      }
      const after = await envCheck()
      const t = after.tools.find((x) => x.id === id)
      const shown = asJson ? JSON.stringify({ ok: t?.ok === true, tool: t }, null, 2) : renderEnv(after)
      process.stdout.write('\n' + shown + '\n')
      if (t?.install?.after !== undefined) process.stdout.write(`\n下一步：${t.install.after}\n`)
      process.exit(t?.ok === true ? 0 : 1)
    }
    process.stdout.write(asJson ? JSON.stringify(env, null, 2) + '\n' : renderEnv(env) + '\n')
    // `--json` 一律退 0：JSON 消费者读 `ok` 字段判断，不必处理退出码
    // （否则 `node setup.mjs env --json` 在缺项时会以非零退出，管道就断了）。
    // 人话模式才用退出码表达"齐 / 不齐"，方便写进 shell 脚本。
    process.exit(asJson || env.ok ? 0 : 1)
  }

  if (cmd === 'verify') {
    const r = await verify()
    process.stdout.write(r.text + '\n')
    process.exit(r.ok ? 0 : 1)
  }

  if (cmd === 'repair') {
    const dryRun = flags['dry-run'] === true
    const profiles = listProfiles()
    const results = profiles
      .filter((p) => p.hasBundle || (p.disabledRows?.length ?? 0) > 0)
      .map((p) => repairMarketHalfState(p, { dryRun }))
    if (asJson) process.stdout.write(JSON.stringify(results, null, 2) + '\n')
    else {
      const L = ['▶ 插件市场（dshmarket）半状态修复']
      if (results.length === 0) L.push('  没有装了本插件的 profile，没东西可修。')
      for (const r of results) {
        if (r.action === 'fixed') L.push('  ' + r.profile + ': 去掉 ' + r.removed.length + ' 行（' + r.removed.join('、') + '）' + (r.backup === null ? '' : '，备份 ' + r.backup))
        else L.push('  ' + r.profile + ': 无需修复' + (r.note === null ? '' : '（' + r.note + '）'))
      }
      if (results.some((r) => r.action === 'fixed')) L.push('  重启应用（桌面版）或刷新页面（web 版）后，Gitee preset 应能正常起来。')
      process.stdout.write(L.join('\n') + '\n')
    }
    process.exit(0)
  }

  process.stderr.write(`未知子命令：${cmd}\n用法：env | detect | questions | apply | verify | repair\n`)
  process.exit(2)
}

/** 人类可读的 detect。 */
function renderDetect(f) {
  const L = []
  L.push('▶ 环境探测')
  L.push(`  DSH_HOME   : ${f.dshHome}`)
  L.push(`  包         : ${f.root}  v${f.version}`)
  L.push(`  token      : ${f.token.found ? f.token.source : '未找到'}`)
  L.push(`  MCP        : ${f.mcpBinary.found ? `${f.mcpBinary.path}  [${f.mcpBinary.source}]` : `未找到 —— ${f.mcpBinary.detail}`}`)
  const sk = f.skill
  L.push(`  skill      : ${sk.effective
    ? `已挂载 ✓ ${sk.resolvedSkillFile}${sk.installedAs === 'file' ? '（file: 装法，加载的是副本）' : ''}`
    : `未生效 ✗ ${sk.rowDeclared
      ? `补丁行解析到 ${sk.resolvesTo}，那里没有 ${SKILL_NAME}/SKILL.md`
      : `补丁里没有 ${SKILL_ROW_ID} 行`}`}`)
  if (f.agentHalf !== null && f.agentHalf.present) {
    const hostSupplied = f.agentHalf.ok ? false : f.agentHalf.hostSuppliesClosure === true
    L.push(`  agent 半   : ${f.agentHalf.ok
      ? `可 import ✓（装法 ${f.agentHalf.spec ?? '?'}）`
      : hostSupplied
        ? '裸导入探针不适用（桌面版宿主自带解析）—— 不影响 preset'
        : `import 失败 ✗ ${f.agentHalf.error}（装法 ${f.agentHalf.spec ?? '?'}）`}`)
  }
  L.push(`  preset     : ${f.presets.installed.join('、') || '(无)'}（仓库里：${f.presets.expected.join('、') || '(无)'}）`)
  L.push('  profile：')
  for (const p of f.profiles) {
    const cur = p.currentConfig
    L.push(`    · ${p.name}  bundle=${p.hasBundle ? '有' : '无'}  补丁=${cur?.present === true ? `已配(${cur.managed ? '受管' : '手工'})` : '未配'}  ${p.patchPath}`)
  }
  L.push(`  企业       : ${f.enterprise.list === null ? `取不到（${f.enterprise.error ?? '无 token'}）` : f.enterprise.list.map((e) => `${e.name}(${e.id})`).join('、') || '空'}`)
  if (f.problems.length > 0) { L.push('  待处理：'); for (const p of f.problems) L.push(`    ⚠ ${p}`) }
  return L.join('\n')
}

/** 人类可读的 questions。 */
function renderQuestions(q) {
  const L = ['▶ 建议向使用者确认的问题（全部都有默认值，不回答也能装）', '']
  for (const [i, item] of q.questions.entries()) {
    L.push(`${i + 1}. ${item.question}`)
    L.push(`   为什么问：${item.why}`)
    for (const o of item.options) L.push(`     - ${JSON.stringify(o.value)}  ${o.label}${o.detail ? `（${o.detail}）` : ''}`)
    L.push(`   推荐：${JSON.stringify(item.default)}　未回答时用：${JSON.stringify(item.ifUnanswered)}${item.required ? '　【必答】' : ''}`)
    L.push('')
  }
  return L.join('\n')
}

// 仅在被直接执行时跑 CLI（被 import 时不跑）。
// 与 gq.mjs 同款守卫：这个模块的 ENV_TOOLS 等导出会被测试 import，
// 少了这一行，import 一次就会把整个 CLI 跑一遍（冒烟里当场撞到了）。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`setup 失败：${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  })
}
