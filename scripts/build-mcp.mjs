#!/usr/bin/env node
/**
 * 把 Gitee 企业版 MCP 后端**编译进本插件** —— 让同事不需要 Go 环境。
 *
 * 为什么要入库二进制而不是让每个人 `go install`：
 *   1. 不是每个同事都有 Go 环境，为装一个 MCP 后端装一套 Go 不划算；
 *   2. 上游 npm 包（@gitee/mcp-gitee-ent）**没有 `create_program`**（建项目），
 *      而我们的能力矩阵依赖它，也依赖 9 个 `*_doc_node*` / `create_wiki` 工具；
 *   3. 内网隔离的同事装不上 npm 依赖，随包带着最稳。
 *
 * Go 的交叉编译让这件事很便宜：`CGO_ENABLED=0` 出来的是**完全静态链接**的
 * 单文件，拷到同事机器上就能跑，不用管 glibc 版本。一台 Linux 就能编出
 * Windows 的可执行文件。
 *
 * 产物（都进 git，见 .gitignore 里**没有**排除 vendor/）：
 *   vendor/mcp-gitee-ent/manifest.json            ← 溯源 + 每个平台的 sha256 + 工具清单
 *   vendor/mcp-gitee-ent/mcp-gitee-ent-<os>-<arch>[.exe]
 *
 * 用法：
 *   node scripts/build-mcp.mjs                      # 编默认平台并写 manifest
 *   node scripts/build-mcp.mjs --platforms linux/amd64,windows/amd64
 *   node scripts/build-mcp.mjs --fork ../dsh-mcp-gitee-ent
 *   node scripts/build-mcp.mjs --check              # 只校验（sha256 + 工具清单 + 与能力矩阵对齐）
 *   node scripts/build-mcp.mjs --json
 *
 * ⚠️ 二进制不可 bit 级复现的保证：Go 版本相同 + `-trimpath` 时通常一致，
 *    但不作承诺。所以 `--check` 校验的是「**manifest 与已入库的二进制一致**」，
 *    不是「重新编译能得到同样的字节」。换 Go 版本后请重跑本脚本并提交。
 *
 * @module dsh-gitee-chat/scripts/build-mcp
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readPresetPatchText } from './preset-files.mjs'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** 二进制入库位置。 */
const VENDOR_DIR = join(root, 'vendor', 'mcp-gitee-ent')
/** 清单文件名。 */
const MANIFEST = 'manifest.json'

/**
 * 默认平台：linux + windows 各 amd64。
 *
 * 这是**权衡后的取舍**，不是能力上限：加一个平台就往 git 历史里多压 ~7 MiB，
 * 而每次发版都会再累加一次。arm64/macOS 的同事走 PATH 上自带的
 * `mcp-gitee-ent` 或 `MCP_GITEE_ENT_BIN`，`verify` 会明确告诉他们本平台未随包提供。
 */
const DEFAULT_PLATFORMS = ['linux/amd64', 'windows/amd64']

/**
 * 本 fork 的上游基线版本。
 *
 * 为什么要把这个数字记进 manifest：排查"为什么某个工具没有"时，第一件事就是
 * 判断这份二进制到底是谁编的、基于哪一版上游。同时它也是合并上游的起点
 * —— 差距、互补关系与冲突点写在同级仓库的 `dsh-mcp-gitee-ent/FORK.md`。
 */
const UPSTREAM_BASE = '0.2.1'

/**
 * 编进二进制里的版本号（`-X .../utils.Version=`）。
 *
 * 上游的 `utils/constants.go`（0.2.x 起）默认是 `dev`，靠发布时注入。
 * 我们沿用这套：`0.2.1-dsh.4` = 基于上游 0.2.1 + 本 fork 的改动
 * （.1 加文档工具，.2 目录作用域改成跟随会话工作区，.3 加 download_attach_file 读知识库附件内容，
 *   .4 补声明 `Repository.wiki_enabled_with_content` —— 仓库 WIKI 的唯一判据）。
 * 握手时 MCP 的 `serverInfo.version` 报的就是它 —— 排查时一眼能看出是哪份。
 */
const BINARY_VERSION = '0.2.1-dsh.4'

/**
 * **从上游并进来的**那 6 个工具（v0.2.0/0.2.1）。
 *
 * ⚠️ 它们**不是**"另一族 API"。别被目录名骗了：上游的 `operations/documents/`
 * 与我们的 `operations/doc_nodes/` 打的是**同一个 `/{eid}/doc_nodes` 家族**
 * （把每个工具里的 `fmt.Sprintf` 路径挖出来就知道：`list_enterprise_documents`
 * 用的是 `doc_nodes/tile` 与 `doc_nodes/search`）。真实形状是
 * **同一个企业知识库、各做了一半**：
 *
 *   我们（早于上游 v0.2.0）：节点树的**变更**（create/create_wiki/{id}/move/
 *         {id}/recycle/{id}/auth/attach_file）+ 逐层与按项目列举（level/programs）
 *   上游 v0.2.0/0.2.1：文档**正文与文件**（`docs/{id}/files…` 页面读改写、
 *         upload/export）+ 平铺列举与搜索（doc_nodes/tile·search）
 *
 * 两边在「列举知识库内容」与「上传内容」上有**语义重叠**（端点与粒度不同），
 * 其余互补。v0.2.1 的 `search` 会改变 `list_enterprise_documents` 的返回结构
 * （文档列表 → 页面级命中），且不能与 program_id / created_by_me / direction /
 * per_page 同用。细致对照见同级仓库 `dsh-mcp-gitee-ent/FORK.md` §3。
 *
 * ## 为什么记进 manifest
 *
 * 失败模式是「换成上游 npm 版 → 静默少工具」，所以这 6 个**必须在**：
 * 若哪天又不见了，`--check` 直接失败，而不是让线上悄悄变弱。
 */
const MERGED_UPSTREAM_TOOLS = [
  'list_enterprise_documents', 'get_enterprise_document_page', 'update_enterprise_document_page',
  'list_enterprise_document_pages', 'upload_enterprise_document_files', 'download_enterprise_document',
]

/** 上游 npm 包做不到的那几个工具（换二进制时最先丢的就是它们）。 */
const FORK_ONLY_TOOLS = [
  'create_program',
  'create_doc_node', 'create_wiki', 'list_doc_nodes', 'list_program_doc_nodes',
  'move_doc_node', 'set_doc_node_auth', 'recycle_doc_node', 'delete_doc_node', 'attach_doc_file',
  // 读附件内容（v0.2.1-dsh.3）：`list_doc_nodes` 只给文件名，正文/二进制靠它取。
  // 上游至今没有这个工具 —— 而本企业知识库全是 AttachFile，所以它是**唯一**能读的路。
  'download_attach_file',
]
// 注：v0.2.1-dsh.4 **没有新增工具**，只补了一个被静默丢掉的字段 ——
// `list_enterprise_repositories` 的 `wiki_enabled_with_content`（"这个仓库有没有 WIKI"
// 的唯一判据）。它早先没在 fork 的 `types.Repository` 里声明，Go 的 `json.Unmarshal`
// 只填声明过的字段，于是客户端**永远拿到 false**（与 `DocNode.FileId` 同一类坑）。
// 所以工具数不变（仍 48），变的是**已存在工具的返回契约**。

/** 把 `linux/amd64` 翻成 vendor 里的文件名与 DSH 侧的键。 */
function describePlatform(spec) {
  const [os, arch] = spec.split('/')
  const ext = os === 'windows' ? '.exe' : ''
  const platformKey = os === 'windows' ? 'win32' : os
  const archKey = arch === 'amd64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch
  return { spec, os, arch, ext, key: `${platformKey}-${archKey}`, file: `mcp-gitee-ent-${os}-${arch}${ext}` }
}

/**
 * 计算 fork 的**源码指纹**：`*.go` + `go.mod` + `go.sum` 按路径排序后逐个 sha256，
 * 再整体 sha256。
 *
 * 为什么需要它：Go 构建**不是 bit 级可复现的**（实测：同一份源码、同一个 Go 版本，
 * 重编两次 sha256 不同）。于是 manifest 里的 sha256 只能证明「这个文件就是当初
 * 入库的那份」，**证明不了「它就是当前源码编出来的」**。
 * 没有指纹的话，「改了 Go 源码但忘了重编二进制」会一路静默通过 ——
 * 而这正是那种"少几个工具却什么都不报"的事故。
 *
 * 有意排除：`bin/`、`.git`、`node_modules`、`npm/`（打包脚本）、文档。
 * @param forkDir - fork 仓库目录。
 */
function sourceFingerprint(forkDir) {
  const files = []
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = entry.name
      if (name === '.git' || name === 'node_modules' || name === 'bin' || name === 'vendor') continue
      const abs = join(dir, name)
      const next = rel === '' ? name : `${rel}/${name}`
      if (entry.isDirectory()) { walk(abs, next); continue }
      if (!/\.go$/.test(name) && name !== 'go.mod' && name !== 'go.sum') continue
      files.push(next)
    }
  }
  walk(forkDir, '')
  files.sort()
  const hash = createHash('sha256')
  for (const rel of files) {
    hash.update(rel)
    hash.update('\0')
    hash.update(readFileSync(join(forkDir, rel)))
    hash.update('\0')
  }
  return { fingerprint: hash.digest('hex'), fileCount: files.length }
}

/** 文件 sha256。 */
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 跑一次 MCP 握手，问出这个二进制**实际**注册了哪些工具。
 *
 * 为什么值得做：`--enabled-toolsets` 是个**过滤器不是校验器**——名字对不上就
 * 静默跳过。所以换错二进制时不会报错，只会"少 10 个工具"，AI 到时只会说
 * 「我做不了」。把真实清单记进 manifest，安装时就能立刻发现。
 * @param binary - 二进制绝对路径。
 * @param timeoutMs - 握手总超时。
 * @returns 工具名数组（排序后）。
 */
async function probeTools(binary, timeoutMs = 20_000) {
  const { spawn } = await import('node:child_process')
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, ['--transport=stdio'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    const messages = []
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`MCP 握手超时（${timeoutMs}ms）：${binary}`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      let at
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at)
        buf = buf.slice(at + 1)
        if (line.trim() === '') continue
        try { messages.push(JSON.parse(line)) } catch { /* 非 JSON 行忽略 */ }
      }
      const listed = messages.find((m) => m.id === 2)
      if (listed !== undefined) {
        clearTimeout(timer)
        child.kill()
        const names = (listed.result?.tools ?? []).map((t) => t.name)
        if (names.length === 0) reject(new Error('MCP 返回了空的工具清单'))
        else resolve({
          names: names.slice().sort(),
          // 顺带把 serverInfo.version 带回来：能验证 -X 注入真的生效了
          reportedVersion: String(messages.find((m) => m.id === 1)?.result?.serverInfo?.version ?? ''),
        })
      }
    })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })

    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'build-mcp', version: '1' } },
    })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 400)
  })
}

/**
 * 读 preset 里 `--enabled-toolsets` 声明的工具名（能力矩阵的落点）。
 *
 * 形状是 YAML 序列的第二个元素，整串引号包着逗号分隔的名单：
 *   args:
 *     - '--enabled-toolsets'
 *     - 'list_enterprises,get_user_info,…'
 * 所以要把 `- ` 前缀与引号剥掉，否则会把首尾两个名字解析坏。
 */
function presetToolsets() {
  const text = readPresetPatchText('gitee-manager')
  const at = text.indexOf('--enabled-toolsets')
  if (at < 0) return []
  // 取下一行的**第一行**：不切行会把整个文件尾巴都吞进最后一个名字里。
  const rest = text.slice(text.indexOf('\n', at) + 1)
  const line = rest.slice(0, rest.indexOf('\n')).trim()
  return line
    .replace(/^-\s*/, '')
    .replace(/^['"]|['"]$/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/** 读已入库的 manifest（缺失/损坏返回 null）。 */
function readManifestFile() {
  try {
    return JSON.parse(readFileSync(join(VENDOR_DIR, MANIFEST), 'utf8'))
  } catch {
    return null
  }
}

/** 校验：manifest 与已入库的二进制、与能力矩阵三方一致。 */
function check(opts = {}) {
  const problems = []
  /** 因环境缺条件而没做的校验（不是失败，但要让人知道没查）。 */
  const checkSkipped = []
  const manifestPath = join(VENDOR_DIR, MANIFEST)
  if (!existsSync(manifestPath)) {
    return {
      ok: false, problems: [`缺少 ${manifestPath}；先跑一次 node scripts/build-mcp.mjs`],
      manifest: null, skipped: checkSkipped,
    }
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  for (const [key, entry] of Object.entries(manifest.platforms)) {
    const path = join(VENDOR_DIR, entry.file)
    if (!existsSync(path)) { problems.push(`平台 ${key} 声明的文件不存在：${entry.file}`); continue }
    const actualSize = statSync(path).size
    if (actualSize !== entry.size) problems.push(`${entry.file} 大小不符：manifest ${entry.size}，实际 ${actualSize}`)
    const actualHash = sha256(path)
    if (actualHash !== entry.sha256) problems.push(`${entry.file} sha256 不符（文件被换过或拷坏了）`)
  }

  // 🔴 最关键的一条：入库的二进制必须真的提供能力矩阵假设的那些工具。
  // 少了 create_program 这类，界面不会报错，只会「悄悄做不了」。
  const declared = presetToolsets()
  if (declared.length > 0) {
    const provided = new Set(manifest.tools ?? [])
    const missing = declared.filter((t) => !provided.has(t))
    if (missing.length > 0) {
      problems.push(`能力矩阵声明的 ${missing.length} 个工具不在入库二进制里：${missing.join(', ')}`
        + '（多半是换成了上游 npm 版——它没有 create_program）')
    }
    const forked = FORK_ONLY_TOOLS.filter((t) => !provided.has(t))
    if (forked.length > 0) problems.push(`入库二进制缺 fork 特有工具：${forked.join(', ')}`)
  }

  // 从上游并进来的那 6 个必须**在**（v0.2.x 合并后）。缺了就是又退回"静默少工具"。
  if (!Array.isArray(manifest.mergedUpstreamTools)) {
    problems.push('manifest 缺少 mergedUpstreamTools（记录从上游并进来的工具，见 FORK.md §3）；'
      + '重跑 node scripts/build-mcp.mjs')
  } else {
    const gone = manifest.mergedUpstreamTools.filter((t) => !(manifest.tools ?? []).includes(t))
    if (gone.length > 0) {
      problems.push(`入库二进制缺少已并入的上游工具：${gone.join(', ')}`
        + '（上游 documents 家族没编进来？见 FORK.md §5 的合并配方）')
    }
  }
  // 版本注入必须生效：否则握手报的是上游 constants.go 的默认值 'dev'
  if (typeof manifest.binaryVersion !== 'string' || manifest.binaryVersion === '') {
    problems.push('manifest 缺少 binaryVersion；重跑 node scripts/build-mcp.mjs')
  } else if (manifest.reportedVersion !== undefined && manifest.reportedVersion !== manifest.binaryVersion) {
    problems.push(`二进制自报版本 ${JSON.stringify(manifest.reportedVersion)}`
      + ` ≠ manifest 的 ${JSON.stringify(manifest.binaryVersion)}（-X 注入没生效）`)
  }

  // 🔴 最容易被漏掉的一条：**改了 Go 源码但忘了重编二进制**。
  //
  // manifest 里的 sha256 只证明"文件就是当初入库的那份"，证明不了"它是当前源码
  // 编出来的"——而 Go 构建不可复现，所以也不能靠重新编译来比对。
  // 唯一的办法是记下源码指纹，在这里对一次。
  //
  // fork 仓库不在本机时（同事只有插件包）跳过：那时无从校验，但也不该报错。
  const forkDir = opts?.fork ?? join(root, '..', 'dsh-mcp-gitee-ent')
  if (existsSync(join(forkDir, 'main.go'))) {
    const source = sourceFingerprint(forkDir)
    if (typeof manifest.sourceFingerprint !== 'string') {
      problems.push('manifest 缺少 sourceFingerprint（旧脚本生成的）；重跑 node scripts/build-mcp.mjs')
    } else if (manifest.sourceFingerprint !== source.fingerprint) {
      problems.push(`随包二进制不是当前 fork 源码编的：源码指纹 ${source.fingerprint.slice(0, 12)}…`
        + ` ≠ manifest 记录的 ${manifest.sourceFingerprint.slice(0, 12)}…。`
        + '跑 node scripts/build-mcp.mjs 重新编译并提交 vendor/mcp-gitee-ent/')
    }
  } else {
    checkSkipped.push(`fork 仓库不在 ${forkDir}，跳过源码指纹校验（只校验了清单与二进制的一致性）`)
  }

  return { ok: problems.length === 0, problems, manifest, skipped: checkSkipped }
}

/** 编译并写 manifest。 */
async function build({ fork, platforms, json }) {
  const log = (...a) => { if (!json) console.log(...a) }
  if (!existsSync(join(fork, 'main.go'))) {
    throw new Error(`fork 目录里没有 main.go：${fork}\n（用 --fork 指向 dsh-mcp-gitee-ent 的 checkout）`)
  }

  const [commitRes, goRes] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], { cwd: fork }).catch(() => ({ stdout: '' })),
    run('go', ['version']).catch(() => ({ stdout: '' })),
  ])
  const forkCommit = commitRes.stdout.trim()
  const goVersion = goRes.stdout.trim()

  const dirtyRes = await run('git', ['status', '--porcelain'], { cwd: fork }).catch(() => ({ stdout: '' }))
  const dirty = dirtyRes.stdout.trim() !== ''

  const source = sourceFingerprint(fork)
  const previous = readManifestFile()
  if (previous?.sourceFingerprint === source.fingerprint
      && previous.platforms !== undefined
      && platforms.every((s) => {
        const key = describePlatform(s).key
        return previous.platforms[key] !== undefined
      })) {
    log('  ⚠️ 源码指纹与上次相同（Go 源码没变）。')
    log('     Go 构建不保证 bit 级可复现 → 重编会得到不同的字节，'
      + '等于往 git 历史里再塞 ~15 MiB。若只是想更新 manifest，别重编。')
  }

  mkdirSync(VENDOR_DIR, { recursive: true })
  const entries = {}
  let tools = null

  for (const spec of platforms) {
    const p = describePlatform(spec)
    const out = join(VENDOR_DIR, p.file)
    const tmp = `${out}.tmp`
    log(`▶ 编译 ${spec} → ${p.file}`)
    await run('go', [
      'build', '-trimpath',
      '-ldflags', `-s -w -X gitee.com/oschina/mcp-gitee-ent/utils.Version=${BINARY_VERSION}`,
      '-o', tmp, '.',
    ], {
      cwd: fork,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CGO_ENABLED: '0', GOOS: p.os, GOARCH: p.arch, GOFLAGS: '' },
    })
    renameSync(tmp, out)
    chmodSync(out, 0o755)
    const size = statSync(out).size
    entries[p.key] = {
      file: p.file,
      os: p.os,
      arch: p.arch,
      size,
      sha256: sha256(out),
    }
    log(`  ✓ ${(size / 1048576).toFixed(1)} MiB  sha256 ${entries[p.key].sha256.slice(0, 16)}…`)

    // 工具清单只探一次：同一份源码编出的各平台工具集是一样的。
    // 探 linux 产物；若本次没编 linux，就探任意一个（本机能执行的只有 linux）。
    if (tools === null && p.os === 'linux') {
      tools = await probeTools(out)
      log(`  ✓ MCP 握手：实际注册 ${tools.names.length} 个工具（自报版本 ${tools.reportedVersion || '未注入'}）`)
    }
  }

  if (tools === null) {
    throw new Error(`本次没有编 linux 目标，无法探测工具清单（握手要在本机执行）。`
      + `请把 linux/${process.arch === 'x64' ? 'amd64' : process.arch} 也放进 --platforms。`)
  }

  // 记录"上游有而我们没有"的那几个：如果哪天它们出现在 tools 里，
  // 说明有人把上游的 documents 家族也合进来了——那是好事，但值得注意，
  // 因为 DSH 侧的能力矩阵还没有对应条目。
  const manifest = {
    name: 'mcp-gitee-ent',
    purpose: 'Gitee 企业版 MCP 后端（随插件分发，用户无需 Go 环境）',
    fork: 'dsh-mcp-gitee-ent',
    /** 上游基线版本；差距与合并冲突点见同级仓库的 FORK.md。 */
    upstreamBase: UPSTREAM_BASE,
    forkCommit,
    /** Go 源码指纹（*.go + go.mod + go.sum）。用来发现"改了源码没重编"。 */
    sourceFingerprint: source.fingerprint,
    sourceFileCount: source.fileCount,
    forkDirty: dirty,
    goVersion,
    buildFlags: 'CGO_ENABLED=0 go build -trimpath -ldflags "-s -w"',
    generatedAt: new Date().toISOString(),
    /** 编进二进制的版本（`-X utils.Version=`），握手时 serverInfo.version 报它。 */
    binaryVersion: BINARY_VERSION,
    /** 二进制自报的版本 —— 与 binaryVersion 一致才说明注入生效。 */
    reportedVersion: tools.reportedVersion,
    toolCount: tools.names.length,
    tools: tools.names,
    /** 我们独有、上游没有的工具（换二进制时最先丢的就是它们）。 */
    forkOnlyTools: FORK_ONLY_TOOLS,
    /** 从上游 v0.2.x 并进来的工具（现在**必须**在）。 */
    mergedUpstreamTools: MERGED_UPSTREAM_TOOLS,
    platforms: entries,
  }
  writeFileSync(join(VENDOR_DIR, MANIFEST), JSON.stringify(manifest, null, 2) + '\n')

  log('')
  log(`▶ 写入 ${join('vendor', 'mcp-gitee-ent', MANIFEST)}`)
  log(`  fork commit : ${forkCommit || '(未知)'}${dirty ? ' ⚠️ 工作区有未提交改动' : ''}`)
  log(`  go          : ${goVersion}`)
  log(`  平台        : ${Object.keys(entries).join(', ')}`)
  log(`  工具        : ${tools.names.length} 个`)
  log(`  版本        : ${tools.reportedVersion || '(未注入)'}`)

  const verdict = check()
  if (!verdict.ok) {
    log('')
    log('❌ 自检不通过：')
    for (const p of verdict.problems) log(`   · ${p}`)
    return { ok: false, problems: verdict.problems, manifest, built: true }
  }
  log('  ✓ 自检通过（sha256 / 工具清单 / 与能力矩阵一致）')
  return { ok: true, problems: [], manifest, built: true }
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { fork: join(root, '..', 'dsh-mcp-gitee-ent'), platforms: DEFAULT_PLATFORMS, check: false, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--check') out.check = true
    else if (a === '--json') out.json = true
    else if (a === '--fork') out.fork = argv[++i]
    else if (a === '--platforms') out.platforms = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return out
}

/** 直接跑时才是 CLI（被 import 时无副作用 —— 与 setup.mjs 同一条纪律）。 */
async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log('用法：node scripts/build-mcp.mjs [--fork <dir>] [--platforms linux/amd64,windows/amd64] [--check] [--json]')
    return
  }
  const result = opts.check
    ? check(opts)
    : await build(opts)

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      ok: result.ok,
      problems: result.problems,
      manifest: result.manifest === null ? null : {
        forkCommit: result.manifest.forkCommit,
        goVersion: result.manifest.goVersion,
        toolCount: result.manifest.toolCount,
        platforms: Object.keys(result.manifest.platforms ?? {}),
      },
    }, null, 2) + '\n')
    process.exit(result.ok ? 0 : 1)
  }

  for (const s of result.skipped ?? []) console.log(`  · ${s}`)

  if (!result.ok) {
    console.error('')
    console.error('❌ 校验不通过：')
    for (const p of result.problems) console.error(`   · ${p}`)
  } else if (opts.check) {
    console.log(`✓ 随包 MCP 校验通过（${Object.keys(result.manifest.platforms).join('/')}`
      + ` · ${result.manifest.toolCount} 个工具 · 源码指纹 ${String(result.manifest.sourceFingerprint).slice(0, 12)}…）`)
  }
  process.exit(result.ok ? 0 : 1)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`✗ ${error.message}`)
    process.exit(2)
  })
}

export { build, check, describePlatform, FORK_ONLY_TOOLS, VENDOR_DIR }
