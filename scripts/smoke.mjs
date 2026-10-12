/**
 * dsh-gitee-chat 冒烟测试（零依赖，直接跑 node）。
 *
 * 覆盖两半，并**专门守住平面纪律**：
 *   - host 半（profile）：路由 + giteeChat 服务 + **公开 gateway `gitee_ent` 一个工具**
 *     （故意例外）；除此之外**不得**注册工具/人格/门禁。
 *     这条是回归守卫——早先版本把工具与人格注入写在 host 半，
 *     导致 PTC 等无关 preset 的新会话也被注入 Gitee 人格、也能看到 Gitee 工具。
 *   - agent 半（preset）：工具 + 人格注入 + 门禁 + 把公开 gateway `restrict` 掉；
 *     不得自己挂路由。
 *
 * 用法：node scripts/smoke.mjs
 */

import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { existsSync as pathExists, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs'
import { presetPatchPath, readPresetPatchText } from './preset-files.mjs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'

const run = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
import {
  apply as applyHost, compositionMountsRow, createGqRunner, materializedPath, name as hostName,
  ensureMaterialized, platformKey, resolveConfig, toolGapOf, VERSION,
  binaryName, isOnPath, userBinDir,
  classifyPageState, rollupDocState, planPull, enterpriseLayer, safeSlug, pageRelPath,
  unwrapToolResult, DocError, createMcpDocs, createDocService,
  createRepoService, createWikiCache, toWorkspacePath, safeRepoSegment,
  classifyAttachState, readAttachManifest, cacheStats, humanBytes,
  createMcpClient, giteeEntGatewayTool, PUBLIC_GATEWAY_TOOL_NAME, WRITE_TOOLS,
} from '../lib/index.js'
import { apply as applyAgent, rawMcpToolName } from '../lib/agent.js'
import { createIssueWriter } from '../lib/index.js'
import { codeMatches, codeOfTitle, computeExtendedAnalysis, parseTemplate, resolveThresholds, THRESHOLD_DEFAULTS } from '../scripts/gitee/analysis.mjs'

/**
 * 从 preset 里读能力矩阵声明的工具名。
 *
 * 形状是 YAML 序列的第二个元素：`- 'a,b,c'`。必须只取那一行 ——
 * 不切行会把整个文件尾巴吞进最后一个名字里（build-mcp.mjs 第一次跑就栽在这）。
 */
function presetToolsetsFromFile(path) {
  const text = readFileSync(path, 'utf8')
  const at = text.indexOf('--enabled-toolsets')
  if (at < 0) return []
  const rest = text.slice(text.indexOf('\n', at) + 1)
  const line = rest.slice(0, rest.indexOf('\n')).trim()
  return line.replace(/^-\s*/, '').replace(/^['"]|['"]$/g, '').split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * 建一个指向 `target` 的**目录链接**（fixture 里模拟装的插件）。
 *
 * Windows 上普通用户（没开开发者模式、也不是管理员）用 `fs.symlink(…, 'dir')`
 * 会拿到 `EPERM: operation not permitted, symlink` —— 那是**本机权限**问题，
 * 不是夹具或插件的错，却会让 `pnpm run check` 在 Windows 开发机上必然红
 * （CI 的 runner 是管理员，反而看不出来）。退到 junction：不需要任何特权，
 * 而且这正是产品在 Windows 上补那一跳的形状
 * （见 `scripts/setup.mjs`：`symlinkSync(source, dest, process.platform === 'win32' ? 'junction' : 'dir')`）。
 */
async function linkDir(target, linkPath) {
  try {
    await symlink(target, linkPath, 'dir')
  } catch (err) {
    if (process.platform !== 'win32' || (err.code !== 'EPERM' && err.code !== 'EACCES')) throw err
    await symlink(resolve(target), linkPath, 'junction')
  }
}

/** 取出 preset 里 `command: !!js "…"` 的那个表达式；不是这个形状返回 null。 */
function presetCommandExpression(path) {
  const line = readFileSync(path, 'utf8').split('\n').find((l) => l.trim().startsWith('command:'))
  if (line === undefined) return null
  const m = /^\s*command:\s*!!js\s*"(.*)"\s*$/.exec(line)
  return m === null ? null : m[1]
}

/**
 * 在隔离的 vm 里求值 preset 的 `!!js` 表达式。
 *
 * 只给 `process` —— 这正是 DSH 的 `!!js` 求值上下文提供的全部东西。
 * `materialized` 控制落地文件是否存在，用来验证回落的两个分支：
 *   `'user'` = 用户级 bin 那份在，`false` = 不在（应回落到 PATH 上的裸名）。
 */
function evaluateExpression(expr, { env, platform, materialized }) {
  const home = platform === 'win32' ? (env.USERPROFILE ?? '') : (env.HOME ?? '')
  const name = platform === 'win32' ? 'mcp-gitee-ent.exe' : 'mcp-gitee-ent'
  const xdg = typeof env.XDG_BIN_HOME === 'string' && env.XDG_BIN_HOME.trim() !== '' ? env.XDG_BIN_HOME.trim() : null
  const binDir = platform === 'win32' ? join(home, '.local', 'bin') : (xdg ?? join(home, '.local', 'bin'))
  const userBin = join(binDir, name)
  const existing = materialized === 'user' ? new Set([userBin]) : new Set()
  const fakeProcess = {
    env,
    platform,
    getBuiltinModule: (id) => (id === 'node:fs'
      ? { existsSync: (p) => existing.has(p) }
      // 真实平台上 `os.homedir()` 就是 USERPROFILE（win32）/ HOME（posix）。
      // vm 跑在 Linux 上，照搬真模块会让模拟的 win32 分支永远算不出家里的 `.dsh`，
      // 于是表达式回落到 PATH 上的裸名字 —— 那是**测试环境**的错，不是表达式错。
      : id === 'node:os'
        ? { homedir: () => (platform === 'win32' ? (env.USERPROFILE ?? '') : (env.HOME ?? '')) }
        : process.getBuiltinModule(id)),
  }
  return vm.runInNewContext(expr, { process: fakeProcess })
}

/** 假 cordis 上下文：只实现两半实际用到的面。 */
function fakeCtx() {
  // 记录容器刻意与 API 键名分开（tools/webServer 是 API，rec.tools 才是记录），
  // 否则展开时会互相覆盖。
  const rec = {
    tools: [],
    routes: [],
    guards: [],
    promptContexts: [],
    provided: {},
    effects: [],
    /** `inject(deps, cb)` 的依赖列表（host 半用它注册公开 gateway）。 */
    injects: [],
    /** `tools.restrict(filter)` 的调用参数（agent 半用它隐藏公开 gateway）。 */
    restricts: [],
    /** 已注册的事件监听器：event → [fn]。 */
    listeners: {},
    /** 假的 preset 组合文本：presetId → YAML 文本（供 agentPresets.read 返回）。 */
    compositions: {},
  }
  return {
    rec,
    logger: { info: () => {}, warn: (m) => console.log('  [warn]', m) },
    effect(fn) {
      const disposer = fn()
      rec.effects.push(disposer)
      return disposer
    },
    /**
     * cordis 的依赖注入子插件：`inject(deps, cb)` 等价于
     * `plugin({ inject: deps, apply: cb })` —— 依赖就绪才跑 cb。
     * 冒烟里依赖总是"就绪"，所以直接同步跑，子上下文继承同一套记录容器。
     */
    inject(deps, callback) {
      const list = Array.isArray(deps) ? deps : [deps]
      rec.injects.push(list)
      const child = Object.create(this)
      child.__injected = list
      const disposer = callback(child)
      rec.effects.push(disposer)
      return disposer
    },
    provide(serviceName, value) {
      rec.provided[serviceName] = value
      return () => {}
    },
    on(event, fn) {
      rec.listeners[event] = rec.listeners[event] ?? []
      rec.listeners[event].push(fn)
      return () => {}
    },
    /** 触发一个事件（模拟 host 侧 emit）。 */
    emit(event, ...args) {
      for (const fn of rec.listeners[event] ?? []) fn(...args)
    },
    get(serviceName) {
      if (serviceName === 'webRuntime') return { trustedHosts: [] }
      if (serviceName === 'agentPresets') {
        // **0.1.7 的服务形状**：读声明文本是 `readDocument(id)` →
        // `{ content }`，读结构化行是 `compositionInventory()`。0.1.6 及以前那个
        // `read(id)` 已经不存在 —— `rec.legacyReadOnly` 专门用来复现"只剩旧方法"的现场。
        if (rec.legacyReadOnly === true) {
          return {
            composedPreset: () => undefined,
            /** 旧形状（0.1.6 及以前）：直接返回组合文本。 */
            async read(id) {
              const text = rec.compositions[id]
              if (text === undefined) throw new Error(`no preset ${id}`)
              return text
            },
          }
        }
        return {
          composedPreset: () => undefined,
          /** 声明文本由 rec.compositions 注入。 */
          async readDocument(id) {
            const text = rec.compositions[id]
            if (text === undefined) throw new Error(`no preset ${id}`)
            return { agentPreset: id, content: text }
          },
          /** 结构化行清单由 rec.inventory 注入；默认空 = 退回文本判据。 */
          async compositionInventory() {
            return rec.inventory ?? []
          },
        }
      }
      if (serviceName === 'systemPrompt') {
        return {
          context(input) {
            rec.promptContexts.push(input)
            return () => {}
          },
        }
      }
      return undefined
    },
    tools: {
      register(def) {
        rec.tools.push(def)
        return () => {}
      },
      guard(fn) {
        rec.guards.push(fn)
        return () => {}
      },
      /**
       * agent 作用域内过滤**全局**工具（agent 半用它隐藏公开 gateway）。
       *
       * 刻意按真契约校验（`@deepseek-ai/dsh-tools` 的
       * `restrict(filter: { allow?, deny? })`）：传数组或空对象都会抛。
       * 名字数组会被真宿主静默 no-op，假 ctx 必须按真契约拒掉，
       * 否则同类 bug 会假绿到人工测试才发现。
       */
      restrict(filter) {
        if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
          throw new Error('tools.restrict() 期望 { allow?, deny? } 对象（收到的不是对象）')
        }
        if (filter.allow === undefined && filter.deny === undefined) {
          throw new Error('tools.restrict({}) 是 no-op：必须给 allow 和/或 deny')
        }
        rec.restricts.push(filter)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        rec.routes.push(route)
        return () => {}
      },
    },
  }
}

/** 造一个假请求对象（满足 handler 读 headers / method / url / body）。 */
function fakeReq({ method = 'POST', url = '/', host = '127.0.0.1:3080', body = '', headers = {} } = {}) {
  const listeners = {}
  return {
    method,
    url,
    headers: { host, ...headers },
    on(event, cb) {
      listeners[event] = listeners[event] ?? []
      listeners[event].push(cb)
      return this
    },
    destroy() {},
    emitBody() {
      if (body !== '') for (const cb of listeners.data ?? []) cb(Buffer.from(body, 'utf8'))
      for (const cb of listeners.end ?? []) cb()
    },
  }
}

/** 造一个假响应对象，记录 status 与 body。 */
function fakeRes() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.status = status
      res.headers = headers ?? {}
      return res
    },
    end(text) {
      res.body = typeof text === 'string' ? text : ''
      return res
    },
  }
  return res
}

/** 跑一次 handler。 */
async function call(handler, reqInit) {
  const req = fakeReq(reqInit)
  const res = fakeRes()
  const pending = handler(req, res)
  req.emitBody()
  await pending
  return { status: res.status, json: res.body === '' ? null : JSON.parse(res.body) }
}

async function main() {
  // 🔴 把 DSH_HOME 与**用户级 bin** 都指到临时目录，整场测试都不碰使用者的真实环境。
  //
  // 为什么必须有这一步：host 半在装配时会自愈随包 MCP 二进制（`ensureMaterialized`），
  // 而本套测试在进程内挂载 host 半 ——
  //   落点是用户级 bin（POSIX `$XDG_BIN_HOME` → `~/.local/bin`），
  //   于是一定要同时把 `XDG_BIN_HOME` 钉进沙箱，否则会往真实的 `~/.local/bin`
  //   写一份 8 MiB 的二进制。
  // 测试不该改使用者的状态，这条第一次跑就被发现了（文件时间对得上）。
  //
  // 单独需要真实现场的用例（如 12j/12l 的端到端）自己再覆盖一次 DSH_HOME。
  const sandboxHome = await mkdtemp(join(tmpdir(), 'gq-smoke-home-'))
  process.env.DSH_HOME = sandboxHome
  process.env.XDG_BIN_HOME = join(sandboxHome, 'user-bin')
  process.on('exit', () => { try { rmSync(sandboxHome, { recursive: true, force: true }) } catch { /* 尽力而为 */ } })

  // 沙箱里造一个装了本插件的 profile：`apply` 必须先找到目标 profile 才肯干活，
  // 而 12i 那几条动词测试跑在默认（=沙箱）DSH_HOME 上。
  // 顺带把 `$DSH_HOME/skills` 建出来，让 "user-dsh" 这个 skill 根真实存在。
  const sandboxProfile = join(sandboxHome, 'profiles', 'smoke')
  await mkdir(sandboxProfile, { recursive: true })
  await mkdir(join(sandboxHome, 'skills'), { recursive: true })
  await writeFile(join(sandboxProfile, 'cordis.yml'), '[]\n')
  await writeFile(join(sandboxProfile, 'package.json'), JSON.stringify({
    name: 'smoke-profile', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-gitee-chat'] } },
  }, null, 2) + '\n')

  console.log(`▶ ${hostName} 冒烟 (v${VERSION})`)
  console.log(`  （DSH_HOME 已隔离到 ${sandboxHome}）`)

  // ══ 1. 配置默认值 ═══════════════════════════════════════════════════════
  const defaults = resolveConfig()
  assert.equal(defaults.apiBase, 'https://api.gitee.com/enterprises')
  assert.equal(defaults.enterpriseId, 0)
  assert.equal(defaults.mode, 'auto')
  assert.match(defaults.scriptPath, /scripts[\\/]gitee[\\/]gq\.mjs$/)
  console.log('  ✓ 配置默认值')

  // ══ 1b. 🔴 空串配置必须等同「未设置」（这就是「取数失败」的根因）════════
  // profile 补丁里同一 id 的 config 是整体替换，安装脚本会写出**完整**配置；
  // 「留空 = 用默认值」的键于是被写成空串。空串不是 nullish，`??` 会放它过去，
  // scriptPath 变成 ''，宿主执行 `node '' <子命令>`——Node 把空脚本名当「从 stdin 读」，
  // stdin 立即 EOF，退出码 0、零输出，界面上只剩一句「gq 输出不是 JSON：」。
  const blanks = resolveConfig({
    apiBase: '',
    scriptPath: '   ',
    mode: '',
    agentRowName: '',
    userAgent: '',
    presetIds: ['', '  ', 'my-preset'],
  })
  assert.match(blanks.scriptPath, /scripts[\\/]gitee[\\/]gq\.mjs$/,
    '空串/空白 scriptPath 必须回落到包内默认脚本，否则会执行 `node ""` 而静默零输出')
  assert.notEqual(blanks.scriptPath.trim(), '')
  assert.equal(blanks.apiBase, 'https://api.gitee.com/enterprises', '空串 apiBase 必须回落默认')
  assert.equal(blanks.mode, 'auto', '空串 mode 必须回落 auto')
  assert.equal(blanks.agentRowName, 'dsh-gitee-chat/agent', '空串 agentRowName 会让 preset 事实判定永远为假')
  assert.ok(pathExists(blanks.scriptPath), `回落后的脚本必须真实存在：${blanks.scriptPath}`)
  assert.deepEqual(blanks.presetIds, ['my-preset'], 'presetIds 里的空白项要滤掉')
  console.log('  ✓ 空串配置 = 未设置（回归：曾导致「gq 输出不是 JSON：」）')

  // ══ 1c. 脚本不可用时必须报「脚本」而不是「输出不是 JSON」════════════════
  // 这条错误的误导性正是上次排障慢的原因：症状在 JSON，病根在路径。
  const emptyPathRunner = createGqRunner({ scriptPath: '' })
  assert.equal(emptyPathRunner.scriptExists(), false)
  const emptyHealth = await emptyPathRunner.health()
  assert.equal(emptyHealth.ok, false)
  assert.ok(/scriptPath|脚本路径为空/.test(emptyHealth.message),
    `空路径应直指配置，实际：${emptyHealth.message}`)
  assert.ok(!/不是 JSON/.test(emptyHealth.message), '空路径不该报成 JSON 解析问题')

  const missingRunner = createGqRunner({ scriptPath: '/nonexistent/gq-nope.mjs' })
  const missingHealth = await missingRunner.health()
  assert.equal(missingHealth.ok, false)
  assert.ok(/脚本不存在/.test(missingHealth.message), `缺脚本应直说，实际：${missingHealth.message}`)
  let threw = false
  try {
    await missingRunner.execJson(['portfolio'])
  } catch (error) {
    threw = true
    assert.ok(/脚本不存在/.test(String(error.message)), '取数路径也要报脚本不存在，而不是 JSON 解析失败')
  }
  assert.ok(threw, '脚本不存在时取数必须抛错')
  console.log('  ✓ 脚本缺失/路径为空 → 直指脚本，不误报 JSON')

  // ══ 1d. 版本单一真源：/ping 回显的必须就是 package.json 里的 ═══════════
  const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  assert.equal(VERSION, pkgVersion, `VERSION(${VERSION}) 必须等于 package.json(${pkgVersion})`)
  assert.notEqual(VERSION, '0.0.0', 'VERSION 读不到 package.json 时会回落 0.0.0，这说明读取路径错了')
  console.log(`  ✓ 版本单一真源：v${VERSION}`)

  // ══ 1e. 清单标准化（对齐 awesome-dsh-plugin 的收审规则）═══════════════════
  //
  // 收录/安装的机械门槛只认清单，所以这里把清单当**契约**来断言，而不是靠人读。
  // 依据：awesome-dsh-plugin/contributing.md（"What CI checks"）与生态已收录插件
  // （dsh-better-sidebar / dsh-context / dsh-cost-meter）。
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

  // ① dsh.bundle 必须声明（只声明 dsh.client 是不可安装的 —— 最常见的被拒原因）
  //
  // `patch` 允许字符串或**字符串数组**（随发行版的 dsh-web-app 就是这么把自己的
  // 四个 preset 补丁列进去的）。本包从 §29 起用数组：`cordis.patch.yml` +
  // `cordis.skills.patch.yml` + 两个 preset 补丁（0.4.5 起把 skill 行拆出去，见 §35）。
  // 断言写成"必须包含"而不是"等于"，但两件事都要钉住：
  //   ① `./cordis.patch.yml` 必须在列表里（contributing.md 第一条）；
  //   ② 仓库里每个 `presets/*.patch.yml` 都必须被列进去 —— 少了就是"文件在仓库里、
  //      装到别人机器上不生效"，那正是 §29 那个事故的形状。
  const declaredPatch = pkg.dsh?.bundle?.patch
  const patchList = Array.isArray(declaredPatch) ? declaredPatch : [declaredPatch]
  assert.ok(patchList.length > 0 && patchList.every((p) => typeof p === 'string'),
    'dsh.bundle.patch 必须是非空字符串或字符串数组（contributing.md 第一条）')
  assert.ok(patchList.includes('./cordis.patch.yml'),
    'dsh.bundle.patch 必须包含包内 cordis.patch.yml（contributing.md 第一条）')
  for (const rel of patchList) {
    assert.ok(rel.startsWith('./') && !rel.includes('..') && pathExists(join(root, rel)),
      `dsh.bundle.patch 里的 ${rel} 必须是包内相对路径且文件存在`)
  }
  const presetPatches = pathExists(join(root, 'presets'))
    ? readdirSync(join(root, 'presets')).filter((f) => f.endsWith('.patch.yml')).sort()
    : []
  for (const file of presetPatches) {
    assert.ok(patchList.includes(`./presets/${file}`),
      `presets/${file} 没列进 dsh.bundle.patch —— 装上也不会被组合`)
  }
  assert.ok(pathExists(join(root, 'cordis.patch.yml')), 'cordis.patch.yml 必须真的在包里')
  assert.ok(pathExists(join(root, 'cordis.skills.patch.yml')), 'cordis.skills.patch.yml 必须真的在包里')

  // 读 dsh.bundle.patch 声明的**全部**补丁文件（skill 行 0.4.5 起在单独的文件里）
  const bundlePatchFilesOf = () => {
    const declared = pkg.dsh?.bundle?.patch
    const list = Array.isArray(declared) ? declared : [declared]
    return list.filter((p) => typeof p === 'string' && p !== '').map((rel) => join(root, rel))
  }
  const bundlePatchTextOf = () => bundlePatchFilesOf().filter(pathExists).map((f) => readFileSync(f, 'utf8')).join('\n')

  // 复刻 dshmarket/lib/hot.js 的 parseSimplePatch()：**只**接受「- insert:」/缩进
  // 「- id: X」/缩进「name: Y」三类行；任何其它行（config、!!js、没被剥掉的注释）
  // 都返回 null → 插件市场放弃热挂载 → 关掉再开启就留半状态。
  const marketHotMountRows = (text) => {
    const rows = []
    let pending = null
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trimEnd()
      if (line.trim() === '') continue
      if (/^-\s+insert:\s*$/.test(line)) continue
      const asId = /^\s+-\s+id:\s*(\S+)\s*$/.exec(line)
      if (asId !== null) { if (pending !== null) return null; pending = asId[1]; continue }
      const asName = /^\s+name:\s*['\"]?([^'\"\s]+)['\"]?\s*$/.exec(line)
      if (asName !== null && pending !== null) { rows.push({ id: pending, name: asName[1] }); pending = null; continue }
      return null
    }
    if (pending !== null || rows.length === 0) return null
    return rows
  }

  const rootPatchText = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.ok(/- insert:/.test(rootPatchText) && /id: gitee-chat\b/.test(rootPatchText),
    'cordis.patch.yml 要按标准形态给出 insert 行（id + name）')
  // 根补丁是插件市场「未识别数组」时**唯一**读到的文件，必须能被热挂载。
  const hotRows = marketHotMountRows(rootPatchText)
  assert.ok(hotRows !== null && hotRows.some((r) => r.id === 'gitee-chat' && r.name === 'dsh-gitee-chat'),
    'cordis.patch.yml 必须是插件市场能热挂载的纯 insert 形态（不许有 config/!!js）')

  // ② 前端半必须带 platform（否则宿主不知道往哪个前端挂）
  assert.equal(pkg.dsh?.client?.platform, 'web', 'dsh.client.platform 必填')

  // ③ 官方包必须是 peerDependencies，且**范围必须真的放行装到的那一版**
  //
  // contributing.md 专门用 ⚠️ 标出这条：node-semver 只在「范围里某个比较符与该版本
  // major.minor.patch 元组一致、且自身带预发布标签」时才放行预发布版。`*`
  // （= `>=0.0.0`）不带预发布标签 → **静默排除 harness 的 0.1.5-rc.x**
  // （实测 `satisfies('0.1.5-rc.2','*') === false`），用户装的时候撞 ERESOLVE。
  // 判据用**本仓 dev 闭包里实际装到的版本**，所以 harness 转稳定版时它会自动放宽。
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/')) continue
    assert.notEqual(range, '*',
      `${name} 的 peer 范围不许写 "*"：它排除一切预发布版（contributing.md 的 ⚠️ 那条）`)
    let actual = null
    try {
      actual = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version
    } catch { /* dev 闭包里没有（如纯前端的 client-* 包）→ 只能查上面那条 */ }
    if (actual !== null && String(actual).includes('-')) {
      assert.ok(range.includes('-'),
        `${name} 装到的是预发布版 ${actual}，但范围 "${range}" 不带预发布分支 → 会静默排除它`)
    }
  }
  assert.ok(!('@deepseek-ai/dsh-tools' in (pkg.dependencies ?? {})),
    '官方 @deepseek-ai/* 只能出现在 peerDependencies，不能进 dependencies')

  // ③b 清单标准化的三处口径（2026-09-30 审计后定，官方包逐一对过）
  assert.ok(!('@deepseek-ai/dsh-client-locale' in (pkg.peerDependencies ?? {})),
    'dsh-client-locale 不该在 peerDependencies：官方 client 插件把它放 devDependencies，'
    + '同时列进 dsh.client.inject；本包 src 里 0 处引用它')
  assert.deepEqual(pkg.publishConfig, { access: 'public', registry: 'https://registry.npmjs.org/' },
    'publishConfig 必须是 access=public + registry 钉官方源（本机 npm 常被配成镜像，'
    + '不钉就会往只读镜像发）')
  assert.equal(pkg.exports?.['./src/*'], './src/*',
    'exports 要放行 ./src/*（官方包一致）')
  assert.equal(pkg.types, 'types/index.d.ts',
    'package.json 要有 types 字段（tsc 生成到 types/，由 types:check 守卫）')
  assert.equal(pkg.exports?.['.']?.types, './types/index.d.ts',
    'exports["."] 要带 types 条件（否则 TS 使用方拿不到声明）')
  assert.equal(pkg.exports?.['./agent']?.types, './types/agent.d.ts',
    'exports["./agent"] 要带 types 条件')
  assert.equal(pkg.exports?.['./client']?.types, './types/client/index.d.ts',
    'exports["./client"] 要带 types 条件（生成产物落在 client/index.d.ts）')
  assert.ok('typescript' in (pkg.devDependencies ?? {}),
    'typescript 要在 devDependencies（types/ 由它生成，不随包发布）')
  assert.equal(pkg.exports?.['.']?.default, './lib/index.js',
    'exports["."] 的 default 仍要指向 lib/index.js')
  assert.ok((pkg.files ?? []).includes('types'),
    'files 白名单必须包含 types（否则声明不会被发布）')
  assert.ok((pkg.files ?? []).includes('CHANGELOG.md'),
    'files 白名单必须包含 CHANGELOG.md')

  // ⑥ **只留一个锁文件**（2026-10-10 定，用户口径"按照标准作"）。
  //
  // 本包用 pnpm：`pnpm-workspace.yaml` 里那两个键（autoInstallPeers / allowBuilds.esbuild）
  // 就是 pnpm 读的，CI 与 Windows 安装脚本也走 pnpm。两个锁并存时它们会**各自漂移**
  // —— 旧门禁正是被这个咬过一次：改了 peer 却没同步 `package-lock.json`，
  // 同事 `npm install` 完 `git status` 立刻是脏的。所以：只保留 `pnpm-lock.yaml`。
  assert.ok(pathExists(join(root, 'pnpm-lock.yaml')), '必须有 pnpm-lock.yaml（唯一的锁文件）')
  assert.equal(pathExists(join(root, 'package-lock.json')), false,
    'package-lock.json 必须不存在（双锁文件会各自漂移；已统一到 pnpm）')

  // ④ license 声明了就要有 LICENSE 文件，并随包发（生态三家都这么做）
  assert.equal(pkg.license, 'MIT', 'license 字段应为 MIT')
  assert.ok(pathExists(join(root, 'LICENSE')), '声明了 license 就必须有 LICENSE 文件')
  assert.ok([...pkg.files].includes('LICENSE'), 'LICENSE 要在 files 里（否则发布/打包会丢）')

  // ⑤ files 必须覆盖运行期真正需要的东西
  //    `presets` 从 §29 起是运行期必需品：preset 补丁由 bundle 交付，缺了它
  //    `file:` 装法（按 files 打包）会把两个 Gitee 模式整段丢掉。
  for (const need of ['lib', 'vendor', 'skills', 'presets', 'cordis.patch.yml', 'cordis.skills.patch.yml']) {
    assert.ok([...pkg.files].includes(need), `files 必须包含 ${need}（运行期需要）`)
  }

  // ⑥ 溯源字段若给了，必须是 https（http 的仓库地址会被 npm 标成不安全，
  //    而 `git+ssh`/裸 ssh 在网页端也会变成死链）
  for (const [what, url] of [
    ['repository.url', pkg.repository?.url],
    ['homepage', pkg.homepage],
    ['bugs.url', pkg.bugs?.url],
  ]) {
    if (url === undefined) continue
    assert.ok(String(url).replace(/^git\+/, '').startsWith('https://'),
      `${what} 必须是 https 地址：实际 ${url}`)
  }

  // ⑦ **跟随最新 DSH 版本**（本插件的明确策略：不做旧版兼容）
  //
  // 判据锚点取"本仓构建实际所对的那一版 harness"（dev 闭包里的 dsh-tools），
  // 于是升级 harness 之后这条会立刻红，并直接告诉你该把 peer / engines.dsh
  // 跟到哪个值。为什么必须跟：npm 的 peer 规则只在「范围里某个比较符与该版本
  // major.minor.patch 元组一致、且自身带预发布标签」时才放行预发布版 ——
  // 只要 harness 换了个 patch 元组（0.1.5-rc.2 → 0.1.6-rc.1），
  // 旧的 `^0.1.5-rc.2` 就会**静默排除**新版本，用户在 ERESOLVE 上卡住。
  const VERSION_LITERAL = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/
  const tupleOf = (v) => String(v).split('-')[0]
  const lineOf = (v) => tupleOf(v).split('.').slice(0, 2).join('.')
  const anchor = JSON.parse(readFileSync(join(root, 'node_modules/@deepseek-ai/dsh-tools/package.json'), 'utf8')).version
  const anchorIsPre = String(anchor).includes('-')
  const assertFollows = (what, range) => {
    const m = String(range).match(VERSION_LITERAL)
    assert.ok(m !== null, `${what} 必须带显式版本号（不要 * / latest）：实际 "${range}"`)
    const declared = m[1]
    if (anchorIsPre) {
      assert.ok(declared.includes('-'),
        `${what}（${range}）必须带预发布标签，否则排除 harness 预发布版`)
      assert.equal(tupleOf(declared), tupleOf(anchor),
        `${what} 写的是 ${range}，而本仓构建所对的 harness 是 ${anchor}`
        + ` —— 请跟到 ^${anchor}（本插件跟随最新 DSH，不做旧版兼容）`)
    } else {
      assert.equal(lineOf(declared), lineOf(anchor),
        `${what}（${range}）与 harness ${anchor} 不在同一版本线 —— 请跟到 ^${anchor}`)
    }
  }
  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    if (name === '@deepseek-ai/cordis') {
      // cordis 独立版本线（4.x），按它自己装到的版本判
      const cordis = JSON.parse(readFileSync(join(root, 'node_modules/@deepseek-ai/cordis/package.json'), 'utf8')).version
      assert.equal(tupleOf(String(range).match(VERSION_LITERAL)?.[1] ?? ''), tupleOf(cordis),
        `@deepseek-ai/cordis 的 peer 范围（${range}）必须跟上装到的 ${cordis}`)
      continue
    }
    if (name.startsWith('@deepseek-ai/dsh-')) assertFollows(`${name} 的 peer 范围`, range)
  }
  assertFollows('engines.dsh', pkg.engines?.dsh ?? '')

  // ⑦b **每个 dsh peer 都必须真的在 harness 闭包里解析得到。**
  //
  // 为什么单列一条：⑦ 只比对**版本范围**，不比对**包还在不在**。0.2.0-rc.2 删掉了
  // `@deepseek-ai/dsh-client-runtime`（本插件从没 import 过它，是历史遗留），而
  // `^0.2.0-rc.2` 照样"版本对得上" —— 于是一个指向**已消失的包**的 peer 能一路绿灯，
  // 直到用户升级 DSH 时被 `skipping profile bundle` 拦下来（2026-09-30 实测）。
  // 判据用 DSH 运行时的同一个解析器（安装闭包锚点），与 dsh 自己的判定同源；
  // 闭包锚点拿不到（无全局 dsh 的裸环境）时跳过，不误报。
  const resolveFromInstall = (() => {
    try {
      return createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
    } catch {
      return null
    }
  })()
  if (resolveFromInstall !== null) {
    for (const name of Object.keys(pkg.peerDependencies ?? {})) {
      if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
      let resolvable = false
      try {
        resolveFromInstall.resolve(`${name}/package.json`)
        resolvable = true
      } catch { /* 下面统一报 */ }
      assert.ok(resolvable,
        `${name} 在 harness 闭包里解析不到 —— 这个包已被 DSH 删除或改名，`
        + '请从 peerDependencies 里删掉它（版本对得上不等于包还在）')
    }
  }
  console.log(`  ✓ 清单标准化 ⑦：peer/engines.dsh 都跟在本仓构建所对的 harness（${anchor}）上`)
  console.log('  ✓ 清单标准化：dsh.bundle / dsh.client.platform / peer 预发布分支 / LICENSE / files 覆盖面 / 溯源 https')

  // ══ 1f. Windows 安装脚本的静态不变量 ═════════════════════════════════════
  //
  // 这个 .cmd 永远跑不到 CI 里（开发机是 Linux），所以它只能靠静态断言兜住。
  // 下面三条各自对应一个**真机上真实发生过**的坑，不是想象的洁癖：
  //   ① 行尾/编码：非 ASCII 的 .cmd 在 936 代码页下变乱码；LF 行尾会让 cmd 读岔
  //   ② `^` 在双引号内不是转义符 —— 真机输出原样打出了 "file:^<repo dir^>"
  //   ③ `!!` 会被 EnableDelayedExpansion 吃成空 → 提示语变成 "[]"
  // 检查器先自证有效（负例），再断言脚本本体。
  const cmdCaretInQuotes = (line) => {
    let inQuote = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') { inQuote = !inQuote; continue }
      if (inQuote && ch === '^' && (line[i + 1] === '<' || line[i + 1] === '>')) return true
    }
    return false
  }
  assert.ok(cmdCaretInQuotes('  echo add "file:^<repo dir^>"'),
    '检查器必须能抓到真机那个 bug（引号内的 ^<）—— 抓不到就等于没守卫')
  assert.ok(!cmdCaretInQuotes('  echo cd /d ^<repo^>'),
    '引号外的 ^< 是正确写法，检查器不能误报')

  const cmdPath = join(root, 'scripts/install-dsh.cmd')
  const cmdRaw = readFileSync(cmdPath, 'utf8')
  assert.ok(!/[^\x00-\x7F]/.test(cmdRaw),
    'install-dsh.cmd 必须纯 ASCII：非 ASCII 的 .cmd 在 936 代码页下会乱码')
  assert.ok(!/(^|[^\r])\n/.test(cmdRaw),
    'install-dsh.cmd 必须是 CRLF 行尾（编辑器插入一个裸 LF 就可能让 cmd 读岔）')
  const caretOffenders = cmdRaw.split('\r\n')
    .filter((line) => /^\s*echo\b/i.test(line) && cmdCaretInQuotes(line))
  assert.equal(caretOffenders.length, 0,
    `echo 行在双引号内用了 ^< / ^>（cmd 只在引号外把 ^ 当转义符，引号内会原样打印）：\n    ${caretOffenders.join('\n    ')}`)
  assert.ok(!cmdRaw.includes('!!'),
    '提示语里不能出现 !!：EnableDelayedExpansion 会把它吃成空变量引用')
  // 真机教训：npm 的 shim 有 dsh.ps1，PowerShell 优先选它、被 ExecutionPolicy 拦。
  // 脚本验收走 cmd 所以看不见这个失败 —— 必须在结语里把出路打出来。
  assert.ok(cmdRaw.includes('Set-ExecutionPolicy -Scope CurrentUser RemoteSigned') && cmdRaw.includes('dsh.cmd'),
    '结语必须给出 PowerShell 的出路（dsh.cmd / Set-ExecutionPolicy RemoteSigned）：'
    + '验收通过 ≠ 用户能用')
  // 策略口径（同事机实测后定的三条）：
  //  ① 只提升"出厂默认" Restricted → RemoteSigned（仅当前用户）
  //  ② AllSigned 是**有人故意选的更严**档位，不许我们偷偷放宽，只能提示
  //  ③ 5.1 与 7 的策略存储互相独立，两个都要探
  assert.ok(cmdRaw.includes('Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force'),
    '脚本应当真的尝试改策略，而不是只打印命令（用户明确要求"让改就改"）')
  assert.ok(/if \/i "!POLICY!"=="Restricted" goto :PolicyTryFix/.test(cmdRaw)
    && /if \/i "!POLICY!"=="AllSigned" goto :PolicyStricter/.test(cmdRaw),
    'Restricted 才自动改；AllSigned 必须走"仅提示"分支（不许静默放宽安全策略）')
  assert.ok(cmdRaw.includes('call :PolicyCheck powershell') && cmdRaw.includes('call :PolicyCheck pwsh'),
    'Windows PowerShell 5.1 与 PowerShell 7 的策略存储是两套，两个都要探')
  assert.ok(cmdRaw.includes('call :PolicyQuery') && /Get-ExecutionPolicy" 2\^>nul/.test(cmdRaw),
    '改完必须**用新进程重新探测**确认（Set-ExecutionPolicy 被组策略覆盖时仍返回 0，'
    + '且那句提示是本地化的，不能靠匹配文本判断成功）')
  // 这个 .cmd 在这台机器上连语法都没法执行（无 cmd.exe / 无 wine），所以退一步：
  // 至少保证每个 goto/call 的目标标签都真的存在 —— 打错一个字母就是一个死循环或直接跑飞。
  const cmdLabels = new Set(cmdRaw.split('\r\n')
    .filter((line) => /^\s*:[A-Za-z]/.test(line))
    .map((line) => line.trim().slice(1).toLowerCase()))
  const cmdTargets = [...cmdRaw.matchAll(/(?:goto|call)\s+:([A-Za-z_]\w*)/g)].map((m) => m[1].toLowerCase())
  // `:eof` 是 cmd 的**内建**标签（`goto :eof` / `call :eof` = 本子过程返回），
  // 不出现在文件里，所以不算悬空目标。
  const dangling = [...new Set(cmdTargets)].filter((t) => t !== 'eof' && !cmdLabels.has(t))
  assert.equal(dangling.length, 0,
    `install-dsh.cmd 里 goto/call 了不存在的标签：${dangling.join(', ')}（已定义：${[...cmdLabels].join(', ')}）`)
  // 结语不要再手写 "<repo dir>" 占位符：用 %~dp0.. 算真实路径，才可复制粘贴
  assert.ok(/for %%I in \("%~dp0\.\."\) do set "REPO_DIR=%%~fI"/.test(cmdRaw),
    '结语应打印真实仓库路径（%~dp0.. + %%~fI 折叠 ..），而不是 "<repo dir>" 占位符')

  // ══ 1f-1b. 插件安装链（2026-09-22 真机缺口 ×2 补上）══════════════════════
  //
  // 脚本原本装完 DSH 就停，把"构建 + 装插件"留给手工 —— 同事在 PowerShell 5.1 里
  // 照 SKILL.md 抄 `npm install ... && npm run build`，整行解析错误（PS 5.1 没有
  // &&，一条都没执行）；接着 dsh plugin add 又死在没装 pnpm 上（"dsh: pnpm
  // failed in profile directory"）。现在整链进脚本：
  assert.ok(cmdRaw.includes('npm install -g pnpm'),
    'install-dsh.cmd 必须装 pnpm：dsh plugin add 在 profile 目录里 shell 出去调它，'
    + '没装就是真机那句 "pnpm failed in profile directory"')
  assert.ok(cmdRaw.includes('--legacy-peer-deps'),
    '仓库构建必须带 --legacy-peer-deps：@deepseek-ai/dsh-* peer 由 DSH 闭包提供，'
    + 'registry 上没有对应版本')
  // 变量写法两种都收：脚本后半段统一用延迟展开（`!REPO_DIR!`），老版用 `%REPO_DIR%`，
  // 断言要守的是 **file: 前缀**，不是变量语法。
  assert.ok(/plugin --profile "%PROFILE%" add "file:(?:%REPO_DIR%|!REPO_DIR!)"/.test(cmdRaw),
    '装插件必须用 file: 前缀（裸路径记成 link:，realpath 落在 $DSH_HOME/profiles 之外，'
    + 'agent 半裸导入 Cannot find package）')
  assert.ok(cmdRaw.includes('scripts\\setup.mjs apply') && cmdRaw.includes('scripts\\setup.mjs verify'),
    '装完插件要接着 setup.mjs apply（默认配置，幂等带备份）与 verify（自检报告）')
  const pnpmAt = cmdRaw.indexOf('npm install -g pnpm')
  const legacyAt = cmdRaw.indexOf('--legacy-peer-deps')
  // 用真实的调用行（`call "!DSH_EXE!" plugin --profile "%PROFILE%" add "file:!REPO_DIR!"`）
  // 定位，别按某一个变量写法去找 —— 脚本的变量写法会演进，顺序约束不会。
  const addAt = cmdRaw.lastIndexOf('add "file:')
  assert.ok(pnpmAt !== -1 && addAt !== -1 && pnpmAt < addAt, 'pnpm 必须先于 dsh plugin add 装好')
  assert.ok(legacyAt !== -1 && legacyAt < addAt, '构建必须先于 dsh plugin add 完成（lib/ 不入库）')
  assert.ok(cmdRaw.includes('set "PROFILE=web"') && cmdRaw.includes('GITEE_CHAT_DSH_PROFILE'),
    'install-dsh.cmd 必须自动挑目标 profile（默认 web，GITEE_CHAT_DSH_PROFILE 可覆盖）—— '
    + '桌面版固定加载 profiles\\desktop，装进没人加载的 profile 是静默失效（tab 与工具都不出现）')
  // 两种"桌面版在场"的判据都收（0.4.5 重写后改成：找到**应用自带的 CLI** ⇒ 桌面版在场）：
  // 断言要守的是行为——桌面版在用 desktop 这个固定 profile 名，不是某一行写法。
  assert.ok(/if defined DSH_EXE \(\s*set "PROFILE=desktop"/.test(cmdRaw)
    || cmdRaw.includes('if exist "%DSH_HOME%\\profiles\\desktop" set "PROFILE=desktop"'),
    'install-dsh.cmd 必须在桌面版在场时改选 desktop（应用自带的 CLI 被找到 / profiles\\desktop 存在；'
    + '桌面版 profile 名固定为 desktop）')
  console.log('  ✓ Windows .cmd 插件安装链：pnpm → 构建（--legacy-peer-deps）→ file: add → apply/verify 顺序闭合')
  console.log('  ✓ Windows .cmd 静态不变量：ASCII / CRLF / 引号内无 ^< / 无 !! / 结语含 PowerShell 出路')

  // ══ 1f-2. Windows 卸载脚本（install-dsh 的严格逆操作）的静态不变量 ═════════
  //
  // 复位脚本同样进不了 CI（无 cmd.exe），同样的静态守卫，外加它自己的口径：
  //   ① 撤销必须真的执行（CurrentUser 改回 Undefined），而不是只打印命令
  //   ② 只有 install-dsh 提的那一档（CurrentUser RemoteSigned）才自动撤销；
  //      脚本本身绝不允许出现"放宽"方向的 Set-ExecutionPolicy
  //   ③ 5.1 与 7 两套存储都要还原；撤销前后都用新进程探作用域
  //     （组策略覆盖时 Set-ExecutionPolicy 返回 0 但没改成，提示还是本地化的）
  const uninstPath = join(root, 'scripts/uninstall-dsh.cmd')
  const uninstRaw = readFileSync(uninstPath, 'utf8')
  assert.ok(!/[^\x00-\x7F]/.test(uninstRaw),
    'uninstall-dsh.cmd 必须纯 ASCII：非 ASCII 的 .cmd 在 936 代码页下会乱码')
  assert.ok(!/(^|[^\r])\n/.test(uninstRaw),
    'uninstall-dsh.cmd 必须是 CRLF 行尾（编辑器插入一个裸 LF 就可能让 cmd 读岔）')
  assert.ok(!uninstRaw.includes('!!'),
    'uninstall-dsh.cmd 提示语里不能出现 !!：EnableDelayedExpansion 会把它吃成空变量引用')
  const unCaretOffenders = uninstRaw.split('\r\n')
    .filter((line) => /^\s*echo\b/i.test(line) && cmdCaretInQuotes(line))
  assert.equal(unCaretOffenders.length, 0,
    `uninstall-dsh.cmd 的 echo 行在双引号内用了 ^< / ^>：\n    ${unCaretOffenders.join('\n    ')}`)
  assert.ok(uninstRaw.includes('Set-ExecutionPolicy -Scope CurrentUser Undefined -Force'),
    '复位必须真的执行撤销（CurrentUser 改回 Undefined），而不是只打印命令')
  assert.ok(!/Set-ExecutionPolicy -Scope CurrentUser (?!Undefined)/.test(uninstRaw),
    '卸载脚本里不许出现非 Undefined 方向的 Set-ExecutionPolicy —— 它的职责是还原出厂，不是放宽')
  assert.ok(/if \/i "!POLICY_SCOPE!"=="RemoteSigned" goto :PRUndo/.test(uninstRaw),
    '只有 CurrentUser 恰为 RemoteSigned（install-dsh 提的那一档）才自动撤销')
  assert.ok(uninstRaw.includes('call :PolicyRestore powershell') && uninstRaw.includes('call :PolicyRestore pwsh'),
    'Windows PowerShell 5.1 与 PowerShell 7 的策略存储是两套，两个都要还原')
  assert.ok(uninstRaw.includes('call :ScopeQuery') && /Get-ExecutionPolicy -Scope CurrentUser" 2\^>nul/.test(uninstRaw),
    '撤销前后都必须用新进程探 CurrentUser 作用域（Set-ExecutionPolicy 被组策略覆盖时仍返回 0，'
    + '不能靠匹配输出文本判断成功）')
  assert.ok(uninstRaw.includes('%USERPROFILE%\\.dsh') && uninstRaw.includes('%APPDATA%\\npm')
    && uninstRaw.includes('%LOCALAPPDATA%\\npm-cache'),
    '三个要删的文件夹（DSH home / npm 全局前缀 / npm 缓存）的默认路径必须写对')
  const unLabels = new Set(uninstRaw.split('\r\n')
    .filter((line) => /^\s*:[A-Za-z]/.test(line))
    .map((line) => line.trim().slice(1).toLowerCase()))
  const unTargets = [...uninstRaw.matchAll(/(?:goto|call)\s+:([A-Za-z_]\w*)/g)].map((m) => m[1].toLowerCase())
  const unDangling = [...new Set(unTargets)].filter((t) => !unLabels.has(t))
  assert.equal(unDangling.length, 0,
    `uninstall-dsh.cmd 里 goto/call 了不存在的标签：${unDangling.join(', ')}（已定义：${[...unLabels].join(', ')}）`)
  console.log('  ✓ Windows 卸载 .cmd 静态不变量：ASCII / CRLF / 无 !! / 撤销口径（只还 RemoteSigned 一档）/ 标签闭合')

  // ══ 1g. `pnpm install` 必须真能跑通（README 手工安装段的第一步）═══════════
  //
  // 真机上"照着 README 走卡在第一步"的两个原因，都在这一个文件里：
  //   ① 缺 autoInstallPeers: false → pnpm 自动去装 peer，而 @deepseek-ai/dsh-* 只由
  //      DSH 的依赖闭包在运行时提供，registry 上没有对应版本 →
  //      ERR_PNPM_NO_MATCHING_VERSION（实测 pnpm 11.5.1）
  //   ② allowBuilds.esbuild 必须是**真布尔值**：仓库里原本留着 pnpm 自动生成的占位串
  //      `set this to true or false`，那等于没放行 → ERR_PNPM_IGNORED_BUILDS + exit 1
  //      （实测 `onlyBuiltDependencies` 在 pnpm 11.5.1 上无效，只有 allowBuilds 生效）
  // 这两个键都靠人手工维护，删掉任何一个 install 就挂 —— 所以钉在这里。
  const pnpmWs = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(pnpmWs, /^autoInstallPeers:\s*false\s*$/m,
    'pnpm-workspace.yaml 必须写 autoInstallPeers: false —— 否则 pnpm 会去 registry 找 '
    + '@deepseek-ai/dsh-* 这些只由 DSH 闭包提供的 peer，直接 ERR_PNPM_NO_MATCHING_VERSION')
  assert.match(pnpmWs, /^allowBuilds:\s*\n(?:[ \t]+.*\n)*?[ \t]+esbuild:\s*true\s*$/m,
    'pnpm-workspace.yaml 必须给 esbuild 放行构建脚本（是真的 true）—— '
    + '否则 pnpm install 以 ERR_PNPM_IGNORED_BUILDS 退出 1，README 第一步就卡住')
  assert.ok(!pnpmWs.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n').includes('set this to true or false'),
    '不能留着 pnpm 自动生成的占位串 `set this to true or false` —— 那等于没放行'
    + '（注释里解释这个坑是可以的，所以只查非注释行）')

  // ══ 1h. client 半的槽位注册（静态钉契约）═════════════════════════════════
  //
  // 客户端代码跑不进 node 冒烟（它要浏览器 + ModuleLoader），但**注册契约**能静态钉住：
  // 槽位名写错 / id 撞了 shipped 的格子 / 漏了设置分节，都会在浏览器里静默消失。
  // 三个槽位各守一条：
  //   · `tool.call.toolview`（key = 工具名）—— 看板卡片
  //   · `conversation.view`（id=gitee）—— 与 对话/轨迹/上下文 并列的标签页
  //   · `settings.section`（id=gitee，order 45）—— 应用设置里的 token 正式入口
  const clientSrc = readFileSync(join(root, 'src', 'client', 'index.tsx'), 'utf8')
  assert.match(clientSrc, /name:\s*'tool\.call\.toolview'[\s\S]{0,120}?key:\s*'gitee_board'/,
    'client 半必须为 gitee_board 注册工具卡片（key 必须与 host 侧工具名一致）')
  assert.match(clientSrc, /name:\s*'conversation\.view'[\s\S]{0,160}?id:\s*'gitee'[\s\S]{0,160}?label:\s*'Gitee 项目'/,
    'client 半必须注册会话标签页 conversation.view（id=gitee，label=Gitee 项目）')
  assert.match(clientSrc, /name:\s*'settings\.section'[\s\S]{0,200}?id:\s*'gitee'[\s\S]{0,200}?order:\s*45[\s\S]{0,200}?label:\s*'Gitee 企业项目'/,
    'client 半必须注册设置分节 settings.section（id=gitee、order=45、label=Gitee 企业项目）'
    + ' —— token 的正式入口就在这里，别只留在会话标签页里')
  // 构建产物里也要有（漏 rebuild 的话浏览器拿到的是旧包，静态源码却看着没问题）。
  // 注意 esbuild 默认 `charset: ascii` —— 中文在 bundle 里是 `\uXXXX` 转义，
  // 所以这里断言**结构**（槽位名 + id + order），不要断言中文文案。
  const clientBundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  assert.match(clientBundle, /settings\.section"[\s\S]{0,80}?id:\s*"gitee"[\s\S]{0,80}?order:\s*45/,
    'lib/client.js 里看不到设置分节 —— 先 `npm run build`（构建产物与源码不同步最容易骗过人）')
  // 🔴 反向守卫：配置入口**不许**回到「Gitee 项目」标签页里（0.4.0 曾有一个 ⚙ 设置 弹窗）。
  // 那个标签页只在 Gitee 模式的会话里才有内容，而"能不能进 Gitee 模式"和"有没有 token"
  // 可能互为前提 —— 把配置做进标签页，等于让使用者先有 token 才能找到配 token 的地方。
  const tabViewSrc = readFileSync(join(root, 'src', 'client', 'GiteeProjectView.tsx'), 'utf8')
  assert.ok(!/TokenSettings|TokenForm|粘贴企业版 access token/.test(tabViewSrc),
    '「Gitee 项目」标签页不得再出现 token 配置代码 —— 入口只有应用「设置 → Gitee 企业项目」')
  assert.ok(!/settings\.section/.test(tabViewSrc),
    '设置分节只能在 client/index.tsx 里注册，别在标签页视图里再注册一遍')
  console.log('  ✓ client 槽位：工具卡片 / 会话标签页 / 设置分节（Gitee 企业项目）都已注册且已进入构建产物')
  console.log('  ✓ 反向守卫：配置入口不再出现在「Gitee 项目」标签页里')

  // ══ 2. host 半装配（profile 平面）═══════════════════════════════════════
  const hostCtx = fakeCtx()
  applyHost(hostCtx, { allowFixtureFallback: true })

  assert.equal(hostCtx.rec.routes.length, 1, `host 半应注册 1 条路由，实际 ${hostCtx.rec.routes.length}`)
  assert.equal(hostCtx.rec.routes[0].kind, 'prefix')
  assert.equal(hostCtx.rec.routes[0].path, '/api/gitee-chat')
  assert.ok(hostCtx.rec.provided.giteeChat, 'host 半必须发布 giteeChat 服务')
  console.log(`  ✓ host 半：路由 ${hostCtx.rec.routes[0].path}/* + 发布 giteeChat 服务`)

  // ══ 3. 🔴 平面纪律回归守卫（本次 bug 的守卫）════════════════════════════
  //
  // host 半**只许**注册公开 gateway 这一个工具（`gitee_ent`，MCP 是工具类后端、
  // 用户 2026-10-10 要求公共化），其余任何 agent 可见的东西
  // （人格上下文、门禁、第二个工具、restrict）都不许出现。
  assert.equal(hostCtx.rec.tools.length, 1,
    `host 半只许注册公开 gateway 一个工具，实际 ${hostCtx.rec.tools.length} 个——`
    + 'host 半挂在 profile 里，注册即对所有 preset 生效')
  assert.equal(hostCtx.rec.tools[0].name, PUBLIC_GATEWAY_TOOL_NAME,
    `host 半注册的那一个工具必须是公开 gateway「${PUBLIC_GATEWAY_TOOL_NAME}」`)
  assert.deepEqual(hostCtx.rec.injects, [['tools']],
    'host 半必须走 inject([…tools…]) 注册 gateway（依赖就绪才启动，且随插件卸载而 dispose）')
  assert.equal(hostCtx.rec.promptContexts.length, 0,
    'host 半不得注册人格上下文——曾导致 PTC 等无关 preset 被注入 Gitee 人格')
  assert.equal(hostCtx.rec.guards.length, 0,
    'host 半不得注册门禁——门禁属于 agent 平面')
  assert.equal(hostCtx.rec.restricts.length, 0,
    'host 半不得 restrict——tools.restrict() 要求 agent 作用域，全局调用会遮住所有 agent')
  console.log(`  ✓ 🔴 平面纪律：host 半只注册公开 gateway「${PUBLIC_GATEWAY_TOOL_NAME}」一个工具，无工具/人格/门禁越界`)

  // ══ 4. agent 半装配（preset 平面）═══════════════════════════════════════
  const agentCtx = fakeCtx()
  applyAgent({ ...agentCtx, giteeChat: hostCtx.rec.provided.giteeChat }, {
    injectPersona: true,
    enforceTier: true,
  })

  assert.equal(agentCtx.rec.tools.length, 4, `agent 半应注册 4 个工具，实际 ${agentCtx.rec.tools.length}`)
  assert.deepEqual(
    agentCtx.rec.tools.map((t) => t.name).sort(),
    ['gitee_board', 'gitee_chat_health', 'gitee_enterprises', 'gitee_role'],
  )
  assert.equal(agentCtx.rec.promptContexts.length, 1, 'agent 半应注册 1 个人格上下文')
  assert.equal(agentCtx.rec.guards.length, 1, 'agent 半应注册 1 个门禁')
  assert.equal(agentCtx.rec.routes.length, 0, 'agent 半不得挂路由（路由是进程级，属 host 半）')
  // Gitee 会话里必须把公开 gateway 隐藏掉：它不裁剪工具（48 个全可达），
  // 而本 preset 已经挂着**原生** MCP 工具 + 能力档门禁，重复入口只是绕过档位的后门。
  assert.deepEqual(agentCtx.rec.restricts, [{ deny: [PUBLIC_GATEWAY_TOOL_NAME] }],
    `agent 半必须 restrict 掉公开 gateway「${PUBLIC_GATEWAY_TOOL_NAME}」，改用原生 mcp__gitee_ent__* 工具`)
  // 反向自检：这个假 ctx 真的会拦下"把数组当 filter"的写法吗？
  // （真宿主对数组会静默 no-op，只有假 ctx 按契约拦下才不至于假绿。）
  assert.throws(() => agentCtx.tools.restrict([PUBLIC_GATEWAY_TOOL_NAME]),
    /期望 \{ allow\?, deny\? \} 对象/,
    '假 ctx 必须按真契约拒绝数组 filter，否则同类 bug 还会假绿')
  assert.throws(() => agentCtx.tools.restrict({}), /no-op/,
    '假 ctx 必须按真契约拒绝空 filter')
  console.log('  ✓ agent 半：4 工具 + 1 人格上下文 + 1 门禁 + restrict 掉公开 gateway（无路由）')

  const ctx = { tools: agentCtx.rec.tools, rec: agentCtx.rec }
  const promptContexts = agentCtx.rec.promptContexts
  const handler = hostCtx.rec.routes[0].handler

  // ══ 4b. 公开 gateway════════════════════════════════════
  //
  // 真起一个假 MCP 后端（stdio + 换行分隔 JSON-RPC）——不碰真二进制、也不要 token，
  // 但握手/目录/取 schema/执行/报错/只读硬拦/后端缺失这七条路都真跑一遍。
  const gwDir = await mkdtemp(join(tmpdir(), 'gq-gateway-'))
  const gwServer = join(gwDir, 'fake-mcp.mjs')
  await writeFile(gwServer, `
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const at = buffer.indexOf('\\n')
    if (at < 0) break
    const line = buffer.slice(0, at)
    buffer = buffer.slice(at + 1)
    if (line.trim() === '') continue
    const message = JSON.parse(line)
    const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n')
    if (message.method === 'initialize') {
      send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0' } } })
    } else if (message.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: message.id, result: { tools: [
        { name: 'list_things', description: '列出东西\\n第二行细节不该进目录', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
        { name: 'create_enterprise_issue', description: '创建工作项（写操作）', inputSchema: { type: 'object', properties: {} } },
      ] } })
    } else if (message.method === 'tools/call') {
      const name = message.params?.name
      if (name === 'boom') {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown tool: boom' } })
      } else {
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'RESULT:' + name + ':' + JSON.stringify(message.params?.arguments ?? {}) }] } })
      }
    }
  }
})
`, 'utf8')

  const gwClients = []
  const gwClient = (options) => {
    const client = createMcpClient(options)
    gwClients.push(client)
    return client
  }
  try {
    const gwTool = giteeEntGatewayTool({
      client: gwClient({ command: process.execPath, args: [gwServer], timeoutMs: 10_000 }),
      allowWrites: true,
      runtimeWrites: () => [],
      // 用**合成** id：真实企业 id 不进公开仓库（本文件会随包发布）
      enterpriseId: 31415926,
    })
    assert.equal(gwTool.name, PUBLIC_GATEWAY_TOOL_NAME, '公开 gateway 的工具名必须是 gitee_ent')
    // 两级暴露的全部意义：**常驻的那一个 schema 必须很小**（48 个全量 ≈ 14.6K tokens）。
    const gwBytes = Buffer.byteLength(JSON.stringify({
      name: gwTool.name, description: gwTool.description, parameters: gwTool.parameters,
    }), 'utf8')
    assert.ok(gwBytes < 4_000, `gateway 自己的 schema 应保持精简，实测 ${gwBytes} 字节（两级暴露就是为了这个）`)

    const listed = await gwTool.execute({ op: 'list' }, {})
    assert.match(listed.text, /list_things/, '目录里必须能看见工具名')
    assert.match(listed.text, /create_enterprise_issue ✎/, '目录必须把写工具标成 ✎')
    assert.ok(!/第二行细节/.test(listed.text), '目录只取描述第一行（多行描述会撑大常驻成本）')
    assert.match(listed.text, /31415926/, '目录抬头应带上本部署钉住的企业 id（此处用合成 id）')

    const schemaRes = await gwTool.execute({ op: 'schema', name: 'list_things' }, {})
    assert.match(schemaRes.text, /inputSchema/, 'op=schema 必须回参数表')
    assert.match((await gwTool.execute({ op: 'schema', name: 'list_thing' }, {})).text, /没有名为/,
      'op=schema 给错名字要给可行动提示')
    assert.match((await gwTool.execute({ op: 'schema' }, {})).text, /需要 name/,
      'op=schema 缺 name 要提示先 list')
    assert.match((await gwTool.execute({ op: 'call' }, {})).text, /需要 name/,
      'op=call 缺 name 要提示先 list')
    // 非法 op 由 defineTool 的 enum 在 execute **之前**拦下（所以 gateway 里那句
    // "未知的 op" 只是防御性回落，正常路径到不了）。
    await assert.rejects(() => gwTool.execute({ op: 'wat' }, {}), /"op" must be one of/,
      'op 的取值必须由参数校验兜住，非法值不该进 execute')

    const called = await gwTool.execute({ op: 'call', name: 'list_things', args: { q: 'x' } }, {})
    assert.match(called.text, /RESULT:list_things:\{"q":"x"\}/, 'op=call 必须把 args 原样转给 MCP 后端')
    assert.match((await gwTool.execute({ op: 'call', name: 'boom' }, {})).text, /工具名可能不对/,
      'MCP 报 unknown tool 时应提示改用 op=list')

    // 只读部署：写工具硬拦（用生成表里真实存在的写工具名，顺带钉住生成物被真的读到了）。
    assert.ok(WRITE_TOOLS.includes('create_enterprise_issue'),
      'src/generated/tierWrites.ts 必须含 create_enterprise_issue（读不到就是生成物没进构建）')
    const readOnlyTool = giteeEntGatewayTool({
      client: gwClient({ command: process.execPath, args: [gwServer], timeoutMs: 10_000 }),
      allowWrites: false,
      runtimeWrites: () => [],
    })
    assert.match((await readOnlyTool.execute({ op: 'call', name: 'create_enterprise_issue' }, {})).text,
      /只读部署：写操作被拦截/, 'allowWrites=false 时写工具必须硬拦')
    assert.match((await readOnlyTool.execute({ op: 'call', name: 'list_things' }, {})).text,
      /RESULT:list_things/, 'allowWrites=false 只管写工具，读工具照常')
    assert.match((await readOnlyTool.execute({ op: 'list' }, {})).text, /只读/,
      '只读部署的目录里要写明写操作会被拦')

    // 后端缺失 / 超时：两条失败路径都要给可行动文案，而不是抛异常。
    const missingTool = giteeEntGatewayTool({ client: gwClient({ command: '' }), allowWrites: true })
    assert.match((await missingTool.execute({ op: 'list' }, {})).text, /MCP 后端不可用/,
      '命令为空时应报「随包 MCP 后端不可用」')
    const silentTool = giteeEntGatewayTool({
      client: gwClient({ command: process.execPath, args: ['-e', 'process.stdin.resume()'], timeoutMs: 300 }),
      allowWrites: true,
    })
    assert.match((await silentTool.execute({ op: 'list' }, {})).text, /调用超时/,
      '后端不响应时应报超时并给缩小范围的建议')

    console.log(`  ✓ 公开 gateway：${gwTool.name} 常数 1 个工具（schema ${gwBytes} 字节）—— list/schema/call + 只读硬拦 + 失败文案`)
  } finally {
    for (const client of gwClients) client.dispose()
    await rm(gwDir, { recursive: true, force: true })
  }

  // ══ 5. 真实调用工具（无 token → 样例降级）═══════════════════════════════
  const boardTool = ctx.tools.find((t) => t.name === 'gitee_board')
  const toolResult = await boardTool.execute({ scope: 'portfolio' }, {})
  assert.equal(typeof toolResult.text, 'string')
  assert.match(toolResult.text, /样例数据/, '未配置 token 时应提示样例数据')
  assert.match(toolResult.text, /风险/)
  console.log(`  ✓ gitee_board.execute → ${toolResult.text.length} 字符摘要`)

  const healthTool = ctx.tools.find((t) => t.name === 'gitee_chat_health')
  assert.match((await healthTool.execute({}, {})).text, /环境自检/)
  console.log('  ✓ gitee_chat_health.execute → 自检报告')

  // ══ 6. 路由（host 半）═══════════════════════════════════════════════════
  const ping = await call(handler, { method: 'GET', url: '/api/gitee-chat/ping' })
  assert.equal(ping.status, 200)
  assert.equal(ping.json.ok, true)
  assert.equal(ping.json.scriptExists, true)
  console.log(`  ✓ GET /ping → ${JSON.stringify(ping.json)}`)

  const payloadRes = await call(handler, {
    method: 'POST',
    url: '/api/gitee-chat/payload',
    body: JSON.stringify({ scope: 'portfolio' }),
  })
  assert.equal(payloadRes.status, 200, JSON.stringify(payloadRes.json))
  const payload = payloadRes.json.payload
  assert.equal(payload.kpi.programs, 3)
  assert.ok(payload.risks.length > 0)
  const summaryBytes = Buffer.byteLength(payload.summary)
  const fullBytes = Buffer.byteLength(JSON.stringify(payload))
  console.log(`  ✓ POST /payload → ${payload.kpi.issues} 工作项 / ${payload.kpi.overdue} 逾期`)
  console.log(`  · 摘要 ${summaryBytes}B vs 全量 ${fullBytes}B（模型只看前者）`)

  const again = await call(handler, {
    method: 'POST',
    url: '/api/gitee-chat/payload',
    body: JSON.stringify({ scope: 'portfolio' }),
  })
  assert.equal(again.json.cached, true, '第二次同参数请求应命中宿主缓存')
  console.log('  ✓ 宿主缓存命中（第二次请求 cached=true）')

  // ══ 7. 信任栅栏 ════════════════════════════════════════════════════════
  assert.equal((await call(handler, {
    method: 'GET', url: '/api/gitee-chat/ping', headers: { 'sec-fetch-site': 'cross-site' },
  })).status, 403)
  assert.equal((await call(handler, {
    method: 'GET', url: '/api/gitee-chat/ping', host: 'evil.example.com',
  })).status, 403)
  console.log('  ✓ 信任栅栏：跨站 403 / 陌生 Host 403')

  // ══ 8. 能力档推导规则 ══════════════════════════════════════════════════
  const { deriveTier, personaOf, TIERS, renderMatrix } = await import('../scripts/gitee/gq.mjs')

  assert.equal(deriveTier({ enterpriseRole: 'enterprise_owner' }), 'manager')
  assert.equal(deriveTier({ enterpriseRole: 'admin' }), 'manager')
  assert.equal(deriveTier({ enterpriseRole: 'member', ownedPrograms: [{ id: 1, name: 'A' }] }), 'project')
  assert.equal(deriveTier({ enterpriseRole: 'member', ownedPrograms: [], ownedIssueCount: 9 }), 'exec')
  assert.equal(deriveTier({ enterpriseRole: 'super_admin', ownedPrograms: [{ id: 1, name: 'A' }] }), 'manager',
    '管理角色优先于项目负责人')
  console.log('  ✓ 能力档推导：管理者 / 负责人档 / 执行档 + 优先级')

  assert.equal(personaOf('manager'), 'manager')
  assert.equal(personaOf('project'), 'executor')
  assert.equal(personaOf('exec'), 'executor')
  assert.equal(new Set(Object.values(TIERS).map((t) => t.persona)).size, 2, '人格必须恰好 2 种')
  assert.equal(TIERS.manager.management, true)
  assert.equal(TIERS.project.management, true)
  assert.equal(TIERS.exec.management, false, '执行档必须关闭项目管理与分析')
  console.log('  ✓ 人格恰好 2 种；项目管理开关：管理者/负责人=开，执行=关')

  // 🔴 <docs> 人格块的主路径**必须指向真有数据的形态**。
  //
  // 这块曾经整段指向 WikiInfo（`list_enterprise_document_pages`），而本企业一篇都没有 ——
  // AI 被指引着走空路、还不会报错，只会说"这家企业没有文档"。
  // 与 UI 那次的"绑错数据源"同类，只是发生在 AI 平面上。
  {
    const { renderPersonaContext } = await import('../scripts/gitee/gq.mjs')
    const docsBlock = renderPersonaContext({ tier: 'manager', managedPrograms: [], ownedIssueCount: 0, me: null, enterpriseRole: 'admin' })
    const i = docsBlock.indexOf('<docs>')
    const j = docsBlock.indexOf('</docs>')
    assert.ok(i >= 0 && j > i, '人格里必须有 <docs> 块')
    const block = docsBlock.slice(i, j)
    // 主路径：节点树 + 附件读取
    assert.match(block, /list_program_doc_nodes/, '主路径必须写清楚节点树的入口')
    assert.match(block, /list_doc_nodes\(parent_id/, '主路径必须是逐层列节点')
    assert.match(block, /download_attach_file/, '读内容必须指向本 fork 的那个工具')
    // 仓库 WIKI 单列，且写明必须用 path_with_namespace
    assert.match(block, /wiki_enabled_with_content/, '必须写明"有没有 WIKI"的判据')
    assert.match(block, /path_with_namespace/, '必须写明拼 WIKI 地址要用 path_with_namespace（用 name 会 404）')
    // WikiInfo 降级成条件块，且**不得**出现在条件块之外
    const outside = block.replace(/<wikiinfo>[\s\S]*?<\/wikiinfo>/, '')
    assert.ok(!/list_enterprise_document_pages/.test(outside),
      'list_enterprise_document_pages 只能在 <wikiinfo> 条件块里（那是本企业恒为 0 的路）')
    assert.match(block, /<wikiinfo>[\s\S]*list_enterprise_documents[\s\S]*<\/wikiinfo>/,
      'WikiInfo 那套必须包在 <wikiinfo> 里，并写明"先探测再假设"')
    console.log('  ✓ <docs> 人格块：主路径=节点树+附件 · 仓库 WIKI 单列 · WikiInfo 降级为条件块')
  }

  // 工具集单调 + 越权剔除 + 覆盖真实 41
  const execTools = new Set(TIERS.exec.tools)
  const projTools = new Set(TIERS.project.tools)
  const mgrTools = new Set(TIERS.manager.tools)
  for (const t of execTools) assert.ok(projTools.has(t), `负责人档应包含执行档工具：${t}`)
  for (const t of projTools) assert.ok(mgrTools.has(t), `管理者档应包含负责人档工具：${t}`)
  for (const t of ['merge_enterprise_pull', 'create_program', 'create_enterprise_repository']) {
    assert.ok(!execTools.has(t) && !projTools.has(t), `${t} 不该出现在执行/负责人档`)
    assert.ok(mgrTools.has(t), `${t} 应在管理者档`)
  }
  assert.equal(mgrTools.size, 48, `管理者档应恰好覆盖二进制的 48 个工具，实际 ${mgrTools.size}`)
  console.log(`  ✓ 工具集：执行 ${execTools.size} ⊂ 负责人 ${projTools.size} ⊂ 管理者 ${mgrTools.size}（覆盖全部 48）`)

  // 写工具子集：只读部署（allowWrites=false）的门禁按它硬拦，必须真的是 tools 的子集
  for (const k of ['exec', 'project', 'manager']) {
    const writes = new Set(TIERS[k].writes)
    assert.ok(writes.size > 0, `${k} 档缺 writes（只读部署会拦不住任何东西）`)
    for (const w of writes) assert.ok(TIERS[k].tools.includes(w), `${k} 档的写工具 ${w} 不在本档 tools 里`)
  }
  // 只读部署不该拦掉读类工具，也不该把"导出到本地磁盘"当成写 Gitee
  for (const k of ['exec', 'project', 'manager']) {
    for (const read of ['list_enterprise_documents', 'get_enterprise_document_page', 'download_enterprise_document']) {
      assert.ok(!TIERS[k].writes.includes(read), `${read} 是读类（下载只写本地磁盘），不该被只读部署拦下`)
    }
    for (const w of ['update_enterprise_issue', 'update_enterprise_document_page', 'create_enterprise_issue']) {
      assert.ok(TIERS[k].writes.includes(w), `${w} 会改 Gitee，必须进 ${k} 档的 writes`)
    }
  }
  console.log(`  ✓ 写工具子集：执行 ${TIERS.exec.writes.length} / 负责人 ${TIERS.project.writes.length} / 管理者 ${TIERS.manager.writes.length}（读类不在内）`)

  // 文档工具必须在册（fork 新增，曾整批漏掉会被门禁误杀）
  for (const t of ['create_doc_node', 'create_wiki', 'list_doc_nodes', 'attach_doc_file']) {
    assert.ok(mgrTools.has(t), `管理者档缺文档工具 ${t}——会导致门禁误杀`)
  }
  assert.ok(execTools.has('create_doc_node'), '执行档应能在可写目录建文档')
  assert.ok(!execTools.has('delete_doc_node'), '执行档不得删文档')
  // 上游那一半（v0.2.x 并入）：读类三档都有，改页面/批量导入在执行档
  for (const rd of ['list_enterprise_documents', 'list_enterprise_document_pages', 'get_enterprise_document_page']) {
    assert.ok(execTools.has(rd), `三档都应能读文档：${rd}`)
  }
  assert.ok(execTools.has('update_enterprise_document_page'), '执行档应能改自己可写目录里的页面')
  assert.ok(execTools.has('upload_enterprise_document_files'), '执行档应能导入文档')
  console.log('  ✓ 文档工具已并入矩阵（我们 9 个 + 上游 6 个：读类三档全有，改页面/导入在执行档）')

  // ══ 9. 人格注入 ════════════════════════════════════════════════════════
  assert.equal(promptContexts[0].name, 'gitee-role')
  assert.equal(typeof promptContexts[0].text, 'function')
  assert.equal(typeof promptContexts[0].text({}), 'string')

  const roleTool = ctx.tools.find((t) => t.name === 'gitee_role')
  const roleText = (await roleTool.execute({}, {})).text
  assert.match(roleText, /当前身份与人格/)
  assert.match(roleText, /项目执行 · 负责人档/)

  const after = promptContexts[0].text({})
  assert.ok(after.includes('<gitee-role'), '解析后应注入角色上下文块')
  assert.ok(after.includes('tier="project"'), '注入块应带能力档')
  assert.ok(after.includes('project-management enabled="true"'), '负责人档应开启项目管理')
  assert.ok(after.includes('<analyses'), '分析功能也应注入')
  console.log(`  ✓ 人格注入：${after.length} 字符（含 scope/can/cannot/analyses）`)

  // 解析失败注入空串
  const failCtx = fakeCtx()
  const failHost = fakeCtx()
  applyHost(failHost, { allowFixtureFallback: false, scriptPath: '/nonexistent/gq-does-not-exist.mjs' })
  applyAgent(
    { ...failCtx, giteeChat: failHost.rec.provided.giteeChat },
    { injectPersona: true, enforceTier: true },
  )
  assert.equal(failCtx.rec.promptContexts.length, 1, '即使取数不可用，注入点仍应注册')
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(failCtx.rec.promptContexts[0].text({}), '', '解析失败不得把半截身份灌进提示词')
  console.log('  ✓ 解析失败 → 注入空串（不污染提示词）')

  // ══ 10. 逐项目开合 ═════════════════════════════════════════════════════
  const managed = (await roleTool.execute({ program: 1001 }, {})).text
  assert.match(managed, /负责人是你 → 该项目开启项目管理与分析/)
  const unmanaged = (await roleTool.execute({ program: 1002 }, {})).text
  assert.match(unmanaged, /不是负责人 → 该项目按执行档处理/)
  assert.match(unmanaged, /未开启（仅执行）/)
  assert.ok(promptContexts[0].text({}).includes('project-management enabled="true"'),
    '逐项目判定不得污染注入用的基础人格')
  console.log('  ✓ 逐项目开合：我负责的开启、其他降为执行；且不污染基础人格')

  // ══ 11. 能力档门禁 ═════════════════════════════════════════════════════
  const guard = ctx.rec.guards[0]
  assert.equal(rawMcpToolName('mcp__gitee_ent__create_enterprise_issue'), 'create_enterprise_issue')
  // ⚠️ 只认**本部署那个 server**。别家 MCP server 的工具
  // 同样以 `mcp__` 开头，裸名却不在三张档位表里 —— 早先"只看 mcp__"会让门禁拿
  // Gitee 的表去审它们，把 `mcp__openviking__remember` 误判成越权（2026-09-17）。
  assert.equal(rawMcpToolName('mcp__gitee__list_programs'), undefined,
    'serverName 与本部署不符的 MCP 工具不归本门禁管')
  assert.equal(rawMcpToolName('mcp__openviking__remember'), undefined, '第三方 MCP 工具不归本门禁管')
  assert.equal(rawMcpToolName('gitee_board'), undefined, '非 MCP 工具不应被识别')
  // 前缀可配（跟 preset 的 serverName 走）：换了 serverName 就按新前缀认。
  assert.equal(rawMcpToolName('mcp__my_gitee__list_programs', 'mcp__my_gitee__'), 'list_programs',
    '前缀是参数，不是写死的常量')

  assert.equal(guard({ name: 'gitee_board' }), undefined, '本插件自己的工具不该被门禁拦')
  assert.equal(guard({ name: 'bash' }), undefined)
  assert.equal(guard({ name: 'mcp__gitee_ent__list_enterprise_issues' }), undefined, '档内工具应放行')
  // 回归：同一个 preset 里别家 MCP server 的工具，门禁必须放行 —— 它管不着。
  assert.equal(guard({ name: 'mcp__openviking__write' }), undefined,
    'OpenViking 的记忆写入不该被 Gitee 门禁拦')
  assert.equal(guard({ name: 'mcp__openviking__remember' }), undefined,
    'OpenViking 的 remember 不该被 Gitee 门禁拦')
  const denied = guard({ name: 'mcp__gitee_ent__merge_enterprise_pull' })
  assert.ok(typeof denied === 'string' && denied.includes('不具备该操作的权限'))
  assert.ok(typeof guard({ name: 'mcp__gitee_ent__create_program' }) === 'string', '负责人档不得建项目')
  console.log('  ✓ 能力档门禁：档内放行 / 越权拒绝 / 别家 MCP 与自有工具不拦')

  // ══ 11b. 只读部署（allowWrites=false）必须连 MCP 一起拦 ════════════════
  //
  // 这条补的是一个真实缺口：`allowWrites` 原本只管界面写按钮与 `/write` 路由，
  // 管不到 MCP —— 而 preset 的 `--enabled-toolsets` 是静态的、不随部署变。
  // 于是"只读部署"在 MCP 那侧是空的：AI 照样能建工作项、改状态。
  const roCtx = fakeCtx()
  const roHost = fakeCtx()
  // 必须带 allowFixtureFallback：否则角色解析不出来，门禁会因为「人格未解析」提前放行
  applyHost(roHost, { allowWrites: false, allowFixtureFallback: true })
  applyAgent(
    { ...roCtx, giteeChat: roHost.rec.provided.giteeChat },
    { injectPersona: true, enforceTier: true },
  )
  await new Promise((resolve) => setTimeout(resolve, 800))
  const roGuard = roCtx.rec.guards[0]
  assert.ok(roGuard !== undefined, '只读部署也要挂门禁')
  const roDenied = roGuard({ name: 'mcp__gitee_ent__create_enterprise_issue' })
  assert.ok(typeof roDenied === 'string' && roDenied.includes('只读模式'),
    `只读部署应拦下 MCP 写操作，实际：${roDenied}`)
  assert.ok(roGuard({ name: 'mcp__gitee_ent__update_enterprise_document_page' }) !== undefined,
    '只读部署应拦下"改文档页正文"')
  // 读类与"导出到本地磁盘"不该被拦（导出不改 Gitee）
  assert.equal(roGuard({ name: 'mcp__gitee_ent__list_enterprise_issues' }), undefined, '只读部署不得拦读操作')
  assert.equal(roGuard({ name: 'mcp__gitee_ent__download_enterprise_document' }), undefined,
    'download_enterprise_document 只写本地磁盘、不改 Gitee，不该被只读模式拦')
  assert.equal(roGuard({ name: 'mcp__gitee_ent__get_enterprise_document_page' }), undefined)
  // 只读部署同样只拦 Gitee 那一个 server：别家 MCP 的写不归它管
  assert.equal(roGuard({ name: 'mcp__openviking__write' }), undefined,
    '只读部署只拦 Gitee 的写，别家 MCP 不受影响')
  // 即使关掉 enforceTier，只读这一层也要在（两者触发条件不同）
  const roOnlyCtx = fakeCtx()
  applyAgent(
    { ...roOnlyCtx, giteeChat: roHost.rec.provided.giteeChat },
    { injectPersona: false, enforceTier: false },
  )
  await new Promise((resolve) => setTimeout(resolve, 800))
  const roOnlyGuard = roOnlyCtx.rec.guards[0]
  assert.ok(roOnlyGuard !== undefined, 'enforceTier=false 时只读门禁仍须存在')
  assert.ok(typeof roOnlyGuard({ name: 'mcp__gitee_ent__update_enterprise_issue' }) === 'string',
    '只读门禁不该依赖 enforceTier')
  // 而可写部署不受影响：同样的调用放行
  assert.equal(guard({ name: 'mcp__gitee_ent__create_enterprise_issue' }), undefined,
    '可写部署下档内写工具应放行（别把只读门禁做成无条件拦截）')
  console.log('  ✓ 只读部署门禁：拦 MCP 写 / 放读与本地导出 / 不依赖 enforceTier / 可写部署不受影响')

  // ══ 12. /role 路由 ═════════════════════════════════════════════════════
  const roleRes = await call(handler, { method: 'GET', url: '/api/gitee-chat/role' })
  assert.equal(roleRes.status, 200)
  assert.equal(roleRes.json.persona, 'executor')
  assert.equal(roleRes.json.tier, 'project')
  console.log(`  ✓ GET /role → persona=${roleRes.json.persona} / tier=${roleRes.json.tier}`)

  // ══ 11b. 固定分析：纯函数、确定性、可断言 ═══════════════════════════════
  const { computeAnalysis } = await import('../scripts/gitee/gq.mjs')

  const NOW = Date.parse('2026-06-01T00:00:00Z')
  const day = (n) => new Date(NOW + n * 86400000).toISOString()
  /** 造一个工作项。 */
  const mkIssue = (o) => ({
    id: o.id ?? 1, ident: o.ident ?? 'IK0001', title: o.title ?? 't', state: o.state ?? 'open',
    priority: o.priority ?? 2, priorityHuman: '中', programId: o.programId ?? 1,
    assignee: o.assignee ?? '', assigneeId: 0,
    deadline: o.deadline ?? '', planStartedAt: o.planStartedAt ?? day(-30),
    finishedAt: o.finishedAt ?? '', startedAt: o.startedAt ?? '', createdAt: o.createdAt ?? day(-30),
    updatedAt: o.updatedAt ?? day(-1),
    estimatedMinutes: o.estimatedMinutes ?? 0, registeredMinutes: o.registeredMinutes ?? 0,
    labels: o.labels ?? [{ name: 'a' }, { name: 'b' }, { name: 'c' }].map((x) => x.name),
    typeTitle: '任务', typeId: 100, milestone: o.milestone ?? null,
    hasMilestone: (o.milestone ?? null) !== null, parentId: 0, rootId: 0, commentsCount: 0,
  })
  const programs = [{ id: 1, name: 'P1' }, { id: 2, name: 'P2' }]

  // 健康满分：无逾期、无未指派、无停滞
  const clean = computeAnalysis({
    programs,
    issues: [
      mkIssue({ id: 1, assignee: '甲', deadline: day(10) }),
      mkIssue({ id: 2, assignee: '乙', state: 'closed', deadline: day(-5) }),
    ],
    now: NOW,
  })
  assert.equal(clean.health.find((x) => x.programId === 1).score, 100, '无问题项目应满分')
  assert.equal(clean.totals.overdue, 0)
  assert.equal(clean.totals.nonCompliant, 0)
  console.log('  ✓ 固定分析：干净数据 → 健康度 100、零逾期、零不合规')

  // 逾期扣分 + 延期清单排序
  const late = computeAnalysis({
    programs,
    issues: [
      mkIssue({ id: 1, ident: 'A', assignee: '甲', deadline: day(-3) }),
      mkIssue({ id: 2, ident: 'B', assignee: '甲', deadline: day(-20) }),
      mkIssue({ id: 3, ident: 'C', assignee: '乙' }),
    ],
    now: NOW,
  })
  const p1 = late.health.find((x) => x.programId === 1)
  assert.ok(p1.score < 100, '有逾期必须扣分')
  assert.equal(late.totals.overdue, 2)
  assert.deepEqual(late.slips.map((x) => x.ident), ['B', 'A'], '延期清单应按逾期天数倒序')
  assert.equal(late.slips[0].overdueDays, 20)
  console.log(`  ✓ 固定分析：逾期扣分（${p1.score} 分）、延期清单按天数倒序`)

  // 规范体检：标签数与负责人/截止/计划时间
  const nonCompliant = computeAnalysis({
    programs,
    issues: [
      mkIssue({ id: 1, ident: 'NOLABEL', assignee: '甲', deadline: day(5), labels: [] }),
      mkIssue({ id: 2, ident: 'ONELABEL', assignee: '甲', deadline: day(5), labels: ['x'] }),
      mkIssue({ id: 3, ident: 'NOWNER', assignee: '', deadline: '' }),
      mkIssue({ id: 4, ident: 'OK', assignee: '甲', deadline: day(5) }),
    ],
    now: NOW,
  })
  const problems = Object.fromEntries(nonCompliant.compliance.map((x) => [x.ident, x.problems]))
  assert.ok(problems.NOLABEL.includes('无标签'))
  assert.ok(problems.ONELABEL.some((p) => p.startsWith('标签数 1')))
  assert.ok(problems.NOWNER.includes('无负责人') && problems.NOWNER.includes('无截止日期'))
  assert.equal(problems.OK, undefined, '3 标签 + 有负责人 + 有截止 应合规')
  assert.equal(nonCompliant.totals.nonCompliant, 3)
  console.log(`  ✓ 固定分析：规范体检命中 ${nonCompliant.totals.nonCompliant} 项（无标签/标签数不足/无负责人/无截止）`)

  // 停滞判定（进行中但久未更新）
  const stalling = computeAnalysis({
    programs,
    issues: [
      mkIssue({ id: 1, ident: 'STALE', assignee: '甲', state: 'progressing', deadline: day(5), updatedAt: day(-30) }),
      mkIssue({ id: 2, ident: 'FRESH', assignee: '甲', state: 'progressing', deadline: day(5), updatedAt: day(-2) }),
      mkIssue({ id: 3, ident: 'OPENSTALE', assignee: '甲', state: 'open', deadline: day(5), updatedAt: day(-30) }),
    ],
    now: NOW,
  })
  assert.deepEqual(stalling.stalled.map((x) => x.ident), ['STALE'], '只有进行中且久未更新才算停滞')
  assert.equal(stalling.stalled[0].idleDays, 30)
  console.log('  ✓ 固定分析：停滞判定（进行中 >14 天未动；待办的久未动不算）')

  // 成员负载
  const loads = computeAnalysis({
    programs,
    issues: Array.from({ length: 9 }, (_, i) =>
      mkIssue({ id: i + 1, ident: `L${i}`, assignee: '忙人', deadline: i < 3 ? day(-1) : day(5) })),
    now: NOW,
  })
  const busy = loads.workload.find((w) => w.name === '忙人')
  assert.equal(busy.open, 9)
  assert.equal(busy.overdue, 3)
  assert.equal(busy.level, 'overloaded', '≥8 未完成且 ≥2 逾期应判过载')
  assert.equal(loads.totals.overloadedOwners, 1)
  console.log('  ✓ 固定分析：成员负载（9 未完成 / 3 逾期 → 过载）')

  // 确定性：同输入同输出
  const again2 = computeAnalysis({
    programs,
    issues: [mkIssue({ id: 1, ident: 'A', assignee: '甲', deadline: day(-3) })],
    now: NOW,
  })
  const again3 = computeAnalysis({
    programs,
    issues: [mkIssue({ id: 1, ident: 'A', assignee: '甲', deadline: day(-3) })],
    now: NOW,
  })
  assert.deepEqual(again2, again3, '固定分析必须是确定性的（同输入同输出）')
  console.log('  ✓ 固定分析确定性：同输入 → 完全相同的输出')

  // payload 里必须带上分析
  assert.ok(payload.analysis, '/payload 必须包含固定分析')
  assert.ok(Array.isArray(payload.analysis.health) && payload.analysis.health.length > 0)
  assert.ok(payload.analysis.thresholds.stallDays > 0)
  console.log('  ✓ /payload 携带固定分析（' + payload.analysis.health.length + ' 个项目健康度）')

  // ══ 12b. 会话 → preset 判定（整屏视图与写路由的门禁依据）═════════════════
  //
  // 🔴 这里守的是**可移植性**：判定不能依赖 preset 的名字。
  // 早先用 `preset.startsWith('gitee-')`——同事把自己的 preset 叫「我的项目助手」
  // 就整个失效。现在按事实判定：读组合文本，看有没有挂本插件的 agent 行。
  assert.ok(hostCtx.rec.listeners['agent-preset/selected'], 'host 半应监听 agent-preset/selected')

  // 故意让「Gitee 模式」的 preset 叫一个完全不像的名字
  hostCtx.rec.compositions['我的项目助手'] = "name: 我的项目助手\nagent:\n  - id: x\n    name: 'dsh-gitee-chat/agent'\n"
  hostCtx.rec.compositions['ptc'] = "name: PTC\nagent:\n  - name: '@deepseek-ai/dsh-mcp-client'\n"
  hostCtx.emit('agent-preset/selected', 'sess-gitee', '我的项目助手')
  hostCtx.emit('agent-preset/selected', 'sess-ptc', 'ptc')

  const sGitee = await call(handler, { method: 'GET', url: '/api/gitee-chat/session?sessionId=sess-gitee' })
  assert.equal(sGitee.json.gitee, true, '名字与 gitee 无关、但组合里挂了本插件 agent 行的 preset 必须判定为 Gitee 模式')
  assert.equal(sGitee.json.preset, '我的项目助手')

  const sPtc = await call(handler, { method: 'GET', url: '/api/gitee-chat/session?sessionId=sess-ptc' })
  assert.equal(sPtc.json.gitee, false, 'PTC 会话必须判定为非 Gitee——整屏视图据此不渲染看板')
  assert.equal(sPtc.json.preset, 'ptc')

  const sUnknown = await call(handler, { method: 'GET', url: '/api/gitee-chat/session?sessionId=nope' })
  assert.equal(sUnknown.json.gitee, null, '未知会话应为 null（视图按未启用处理，不误渲染）')

  // 组合读不到（服务缺失 / 权限不足）→ 未知，而不是猜
  const sNoComposition = await call(handler, { method: 'GET', url: '/api/gitee-chat/session?sessionId=sess-gone' })
  hostCtx.emit('agent-preset/selected', 'sess-gone', '不存在的preset')
  const sGone = await call(handler, { method: 'GET', url: '/api/gitee-chat/session?sessionId=sess-gone' })
  assert.equal(sGone.json.gitee, null, '组合读不到时必须给 null（未知），不得猜成 true 也不得静默成 false')
  void sNoComposition
  console.log('  ✓ 会话判定：按组合事实判定（与 preset 命名无关）/ PTC=false / 未知=null')
  console.log('  ✓ 组合读不到 → null（未知），绝不猜')

  // ── 0.1.7 的服务形状：结构化清单优先，文本作退路 ─────────────────────────
  //
  // 🔴 真实事故（2026-09-28）：0.1.6 的 `agentPresets.read(id)` 在 0.1.7
  // 改成了 `readDocument(id) → {content}`。旧代码调 `read` 拿到 undefined、被 catch 吞掉
  // → 判定"未知" → 界面**永远**显示「本会话未使用 Gitee 模式」，哪怕当前 preset 就是
  // gitee-manager。方法变名不报错，所以这三条都必须钉住：
  hostCtx.rec.inventory = [
    { id: 'inv-gitee', rows: [{ moduleName: 'dsh-gitee-chat/agent', enabled: true }] },
    { id: 'inv-off', rows: [{ moduleName: 'dsh-gitee-chat/agent', enabled: false }] },
    { id: 'inv-broken', broken: 'row mount failed', rows: [] },
  ]
  // 故意**不给**这三个 preset 组合文本：走通了就说明用的确实是结构化清单那条路
  hostCtx.emit('agent-preset/selected', 'sess-inv', 'inv-gitee')
  hostCtx.emit('agent-preset/selected', 'sess-inv-off', 'inv-off')
  hostCtx.emit('agent-preset/selected', 'sess-inv-broken', 'inv-broken')
  assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/session?sessionId=sess-inv' })).json.gitee, true,
    '结构化清单里挂了 agent 行 → true（不必读文本）')
  assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/session?sessionId=sess-inv-off' })).json.gitee, false,
    '结构化清单里 agent 行 enabled:false → false')
  assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/session?sessionId=sess-inv-broken' })).json.gitee, null,
    '结构化清单报 broken（行读不出来）→ null（未知），不猜')
  hostCtx.rec.inventory = []
  console.log('  ✓ 0.1.7 结构化清单：挂了 → true / enabled:false → false / broken → null')

  // 回归：服务只剩 0.1.6 那个 `read()` 时的现场 —— 必须给"未知"，而不是静默 false
  const legacyHost = fakeCtx()
  legacyHost.rec.legacyReadOnly = true
  legacyHost.rec.compositions['gitee-manager'] = "name: x\nagent:\n  - name: 'dsh-gitee-chat/agent'\n"
  applyHost(legacyHost, {})
  legacyHost.emit('agent-preset/selected', 'lg', 'gitee-manager')
  const legacySess = await call(legacyHost.rec.routes[0].handler,
    { method: 'GET', url: '/api/gitee-chat/session?sessionId=lg' })
  assert.equal(legacySess.json.preset, 'gitee-manager', 'preset id 仍然读得到（它来自 agent-preset/selected 事件）')
  assert.equal(legacySess.json.gitee, null,
    '服务只有旧 read() 时必须 null（未知）—— 这正是 0.1.7 升级后那两个 Gitee 模式"看着没生效"的现场')
  console.log('  ✓ 服务只有旧 read() → null（复现 0.1.7 升级现场，不得静默 false）')

  // 会话销毁后清理
  hostCtx.emit('session/disposed', null, { id: 'sess-gitee' })
  const sAfterDispose = await call(handler, { method: 'GET', url: '/api/gitee-chat/session?sessionId=sess-gitee' })
  assert.equal(sAfterDispose.json.gitee, null, '会话销毁后应回到未知')
  console.log('  ✓ 会话销毁后清理（不残留判定）')

  // ══ 12c. 工作项下钻路由（整屏视图右侧）═════════════════════════════════
  const issuesRes = await call(handler, { method: 'GET', url: '/api/gitee-chat/issues?program=1001' })
  assert.equal(issuesRes.status, 200, JSON.stringify(issuesRes.json))
  assert.equal(issuesRes.json.ok, true)
  assert.equal(issuesRes.json.programId, 1001)
  assert.ok(issuesRes.json.issues.length > 0, '应返回该项目的工作项')
  assert.ok(issuesRes.json.kpi.total === issuesRes.json.issues.length)
  assert.equal(typeof issuesRes.json.issues[0].overdue, 'boolean', '每项应带逾期判定')
  console.log(`  ✓ GET /issues → 项目 1001 的 ${issuesRes.json.issues.length} 个工作项（含逾期标记）`)

  const badIssues = await call(handler, { method: 'GET', url: '/api/gitee-chat/issues' })
  assert.equal(badIssues.status, 400, '缺 program 应 400')
  console.log('  ✓ GET /issues 缺参数 → 400')

  // ══ 12d. 工作项详情（F-09）═══════════════════════════════════════════════
  const detailRes = await call(handler, { method: 'GET', url: '/api/gitee-chat/issue?ident=DM0001' })
  assert.equal(detailRes.status, 200, JSON.stringify(detailRes.json))
  assert.equal(detailRes.json.detail.ident, 'DM0001')
  assert.ok(detailRes.json.detail.description.includes('## 前置依赖'), '详情必须带描述原文')
  assert.ok(Array.isArray(detailRes.json.dependencies), '必须解析出前置依赖')
  assert.ok(Array.isArray(detailRes.json.comments), '必须带评论（讨论）')
  // 「## 前置依赖」是描述里的固定分段，必须被脚本解析出来而不是丢给模型
  assert.ok(detailRes.json.dependencies.some((d) => d.ref === 'ME-02' && d.kind === 'wbs'),
    '应解析出 WBS 编码依赖 ME-02（真实数据里最常用的写法）')
  assert.ok(detailRes.json.dependencies.some((d) => d.ref === 'ME-02' && d.known && d.ident === 'DM0002'),
    'WBS 短码必须能按标题前缀反查到工作项 DM0002')
  assert.ok(detailRes.json.blockers.length > 0, '依赖未完成时必须标为阻塞')
  console.log(`  ✓ GET /issue → 描述 + ${detailRes.json.dependencies.length} 个前置依赖（${detailRes.json.blockers.length} 个阻塞）+ ${detailRes.json.comments.length} 条评论`)

  const badIdent = await call(handler, { method: 'GET', url: '/api/gitee-chat/issue?ident=!!' })
  assert.equal(badIdent.status, 400, '非法 ident 应 400')
  console.log('  ✓ GET /issue 非法 ident → 400')

  const statesRes = await call(handler, { method: 'GET', url: '/api/gitee-chat/states?type=100' })
  assert.equal(statesRes.status, 200)
  assert.ok(statesRes.json.states.length > 0)
  assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/states' })).status, 400)
  console.log(`  ✓ GET /states → ${statesRes.json.states.length} 个可选状态（改状态用）；缺参数 400`)

  const membersRes = await call(handler, { method: 'GET', url: '/api/gitee-chat/members?program=1001' })
  assert.equal(membersRes.status, 200)
  assert.ok(membersRes.json.members.length > 0)
  assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/members' })).status, 400)
  console.log(`  ✓ GET /members → ${membersRes.json.members.length} 个成员（改派用）；缺参数 400`)

  // ══ 12e. 写通道（G-05 / F-10）—— 唯一写入口 + 会话门禁 ═══════════════════
  //
  // 🔴 冒烟测试**绝不真的写 Gitee**。所以这里分两层验证：
  //   1. 路由层的会话门禁（不通过时根本到不了脚本）；
  //   2. 写通道自身的校验，用**桩执行器**（不会发任何网络请求）。
  const wNoSession = await call(handler, {
    method: 'POST', url: '/api/gitee-chat/write',
    body: JSON.stringify({ op: 'comment', ident: 'DM0001', body: 'hi' }),
  })
  assert.equal(wNoSession.status, 403, '缺少 sessionId 的写请求必须拒绝')
  assert.equal(wNoSession.json.code, 'forbidden')

  const wPtcSession = await call(handler, {
    method: 'POST', url: '/api/gitee-chat/write',
    body: JSON.stringify({ op: 'comment', ident: 'DM0001', body: 'hi', sessionId: 'sess-ptc' }),
  })
  assert.equal(wPtcSession.status, 403, '非 Gitee 会话的写请求必须拒绝')
  assert.match(wPtcSession.json.message, /未使用 Gitee 模式/)

  // 会话门禁通过后，非法 op 在写通道里被挡住（400），且**不会**碰脚本
  const wBadOp = await call(handler, {
    method: 'POST', url: '/api/gitee-chat/write',
    body: JSON.stringify({ op: 'drop-database', ident: 'DM0001', sessionId: 'sess-ptc2' }),
  })
  assert.equal(wBadOp.status, 403, '门禁先于业务校验：非 Gitee 会话一律 403')
  hostCtx.emit('agent-preset/selected', 'sess-ptc2', '我的项目助手')
  const wBadOp2 = await call(handler, {
    method: 'POST', url: '/api/gitee-chat/write',
    body: JSON.stringify({ op: 'drop-database', ident: 'DM0001', sessionId: 'sess-ptc2' }),
  })
  assert.equal(wBadOp2.status, 400, '未知写操作必须 400（只有三种 op 被允许）')

  const wBadIdent = await call(handler, {
    method: 'POST', url: '/api/gitee-chat/write',
    body: JSON.stringify({ op: 'set-state', ident: '../../etc/passwd', stateId: 1, sessionId: 'sess-ptc2' }),
  })
  assert.equal(wBadIdent.status, 400, '非法工作项编号必须 400')

  const wEmptyComment = await call(handler, {
    method: 'POST', url: '/api/gitee-chat/write',
    body: JSON.stringify({ op: 'comment', ident: 'DM0001', body: '   ', sessionId: 'sess-ptc2' }),
  })
  assert.equal(wEmptyComment.status, 400, '空评论必须 400')
  console.log('  ✓ 写路由门禁：无 sessionId 403 / 非 Gitee 会话 403 / 未知 op 400 / 非法编号 400')

  // 唯一写入口的单元验证：桩执行器，可断言「参数长什么样」而不发任何请求
  const writeCalls = []
  const stubRunner = {
    scriptPath: '/stub', scriptExists: () => true, fixtureFallback: false,
    async execJsonWithInput(args, stdin) {
      writeCalls.push({ args, stdin })
      if (args[0] === 'set-state') return { ok: true, op: 'set-state', ident: args[2], stateId: Number(args[4]), state: 'progressing', stateTitle: '进行中' }
      if (args[0] === 'comment') return { ok: true, op: 'comment', ident: args[2], noteId: 9300001 }
      return { ok: true, op: 'assign', ident: args[2], assigneeId: Number(args[4]), owner: '成员甲' }
    },
  }
  const writer = createIssueWriter({ runner: stubRunner, enabled: true })
  const w1 = await writer.write({ op: 'set-state', ident: 'dm0001', stateId: 9000002 })
  assert.equal(w1.state, 'progressing')
  assert.deepEqual(writeCalls[0].args, ['set-state', '--ident', 'DM0001', '--state-id', '9000002'])
  const w2 = await writer.write({ op: 'comment', ident: 'DM0001', body: '  测试评论  ' })
  assert.equal(w2.noteId, 9300001)
  assert.equal(writeCalls[1].stdin, '测试评论', '评论正文走 stdin（不塞 argv），且要去掉首尾空白')
  assert.deepEqual(writeCalls[1].args, ['comment', '--ident', 'DM0001', '--body-file', '-'])
  const w3 = await writer.write({ op: 'assign', ident: 'DM0001', assigneeId: 901 })
  assert.equal(w3.owner, '成员甲')
  assert.equal(writer.recent().length, 3, '写通道应留下进程内流水')
  assert.ok(writer.recent().every((r) => r.ok), '三次写都应记为成功')
  await assert.rejects(
    () => writer.write({ op: 'comment', ident: 'DM0001', body: 'x'.repeat(9000) }),
    /评论过长/,
  )
  assert.equal(writeCalls.length, 3, '被校验拒绝的请求不得触达脚本')
  console.log('  ✓ 唯一写入口：三种 op 的参数形状正确、正文走 stdin、超长与非法入参在到达脚本前被拒')

  const readonlyWriter = createIssueWriter({ runner: stubRunner, enabled: false })
  assert.equal(readonlyWriter.enabled(), false)
  await assert.rejects(() => readonlyWriter.write({ op: 'comment', ident: 'DM0001', body: 'x' }), /关闭了写通道/)
  console.log('  ✓ 只读部署：写通道关闭后任何写请求都被拒绝并说明原因')

  // ══ 12f. 第二批固定分析（E-07 ~ E-10）—— 纯函数，零额外调用 ═════════════
  const a2 = payload.analysis
  for (const key of ['progress', 'capacity', 'milestones', 'delivery']) {
    assert.ok(a2[key], `/payload 的固定分析必须包含 ${key}`)
  }
  assert.equal(a2.thresholds.weeklyCapacity, 10)
  assert.equal(a2.thresholds.trendWeeks, 8)

  // 受控数据集：每个结论都能手算出来，断言才有意义
  const MILE = { id: 7, title: 'M1', state: 'open', start_date: day(-40).slice(0, 10), due_date: day(-3).slice(0, 10), program_id: 1 }
  const ext = computeExtendedAnalysis({
    programs,
    now: NOW,
    issues: [
      // 晚开工 5 天、未完成、本周截止
      mkIssue({ id: 1, ident: 'LATE', assignee: '甲', deadline: day(2), planStartedAt: day(-20), startedAt: day(-15), milestone: MILE }),
      // 按期开工、未完成
      mkIssue({ id: 2, ident: 'ONTIME', assignee: '甲', deadline: day(2), planStartedAt: day(-20), startedAt: day(-20) }),
      // 已完成且按期交付
      mkIssue({ id: 3, ident: 'DONE', assignee: '乙', state: 'closed', deadline: day(-1), planStartedAt: day(-20), startedAt: day(-20), finishedAt: day(-2), milestone: MILE }),
      // 无截止（不参与容量分桶）
      mkIssue({ id: 4, ident: 'NOPLAN', assignee: '乙', deadline: '' }),
      // 8 周窗口之外创建：不应出现在趋势里
      mkIssue({ id: 5, ident: 'OLD', assignee: '乙', deadline: day(30), createdAt: day(-400) }),
    ],
  })

  // 进度偏差：样本只算「计划开始与实际开始都在」的项
  assert.equal(ext.progress.totals.measured, 3, '只有 3 项同时有计划与实际开始时间')
  assert.equal(ext.progress.totals.lateStarts, 1, '只有 LATE 晚开工')
  assert.equal(ext.progress.totals.onTimeStartRate, 67, '按期开工率 = 2/3')
  assert.equal(ext.progress.totals.avgStartDelay, 1.7, '平均开工偏差 = 5/3 ≈ 1.7 天')
  assert.equal(ext.progress.totals.finishedMeasured, 1)
  assert.equal(ext.progress.totals.avgFinishDelay, -1, 'DONE 比截止早 1 天完成 → -1')
  assert.equal(ext.progress.totals.openWithoutPlan, 1, 'NOPLAN 未完成且无截止')
  assert.deepEqual(ext.progress.worst.map((r) => r.ident), ['LATE'], '最差清单只含晚开工且未完成的项')
  console.log(`  ✓ 固定分析②·进度偏差：按期开工率 ${ext.progress.totals.onTimeStartRate}% / 平均开工偏差 ${ext.progress.totals.avgStartDelay}d / 无截止 ${ext.progress.totals.openWithoutPlan} 项`)

  // 里程碑：同一里程碑下 1 完成 1 未完成、已过 due_date → missed
  assert.equal(ext.milestones.totals.count, 1)
  assert.equal(ext.milestones.totals.coveredIssues, 2, '两个工作项挂了里程碑')
  assert.equal(ext.milestones.totals.missed, 1, '过了 due_date 仍有未完成 → missed')
  assert.equal(ext.milestones.rows[0].rate, 50)
  assert.equal(ext.milestones.rows[0].verdict, 'missed')
  console.log('  ✓ 固定分析②·里程碑：已达成/逾期未达/有风险的判定口径正确（含达成率）')

  // 容量：分桶必须覆盖所有「有截止的未完成项」，一项不漏、一项不多
  const planned = ext.capacity.rows.reduce((sum, r) => sum + r.planned, 0)
  const openWithDeadline = 4 // LATE / ONTIME / NOPLAN(day(30)) / OLD(day(30))
  assert.equal(planned + ext.capacity.noDeadline, openWithDeadline, '容量分桶 + 无截止 = 全部未完成项')
  assert.equal(ext.capacity.noDeadline, 1, 'NOPLAN 应计入「无截止」')
  assert.equal(ext.capacity.hoursTracked, false, '样例数据未登记工时 → 必须明说工时口径不可用')
  console.log(`  ✓ 固定分析②·容量：${ext.capacity.rows.length} 个周分桶 / 无截止 ${ext.capacity.noDeadline} / 工时口径 ${ext.capacity.hoursTracked ? '可用' : '未登记'}`)

  // 交付趋势：窗口外的创建工作项不进统计
  assert.equal(ext.delivery.weeks, 8)
  assert.equal(ext.delivery.totals.created, 4, 'OLD（400 天前创建）不得进入 8 周窗口')
  assert.equal(ext.delivery.totals.finished, 1, '只有 DONE 在窗口内完成')
  assert.equal(ext.delivery.totals.net, 3)
  assert.equal(ext.delivery.series.reduce((sum, x) => sum + x.created, 0), 4)
  console.log(`  ✓ 固定分析②·交付趋势：窗口内新增 ${ext.delivery.totals.created} / 完成 ${ext.delivery.totals.finished} / 净增 ${ext.delivery.totals.net}`)

  // 确定性：同输入同输出
  const extB = computeExtendedAnalysis({ programs, now: NOW, issues: [
    mkIssue({ id: 1, ident: 'LATE', assignee: '甲', deadline: day(2), planStartedAt: day(-20), startedAt: day(-15), milestone: MILE }),
    mkIssue({ id: 2, ident: 'ONTIME', assignee: '甲', deadline: day(2), planStartedAt: day(-20), startedAt: day(-20) }),
    mkIssue({ id: 3, ident: 'DONE', assignee: '乙', state: 'closed', deadline: day(-1), planStartedAt: day(-20), startedAt: day(-20), finishedAt: day(-2), milestone: MILE }),
    mkIssue({ id: 4, ident: 'NOPLAN', assignee: '乙', deadline: '' }),
    mkIssue({ id: 5, ident: 'OLD', assignee: '乙', deadline: day(30), createdAt: day(-400) }),
  ] })
  assert.deepEqual(ext, extB, '第二批固定分析也必须是确定性的')
  console.log('  ✓ 固定分析②确定性：同输入 → 完全相同的输出')

  // 描述模板解析（前置依赖的解析口径）
  const tpl = parseTemplate('## 目标\n做点事\n\n## 前置依赖\n- 无\n\n## 交付物\n- 一份文档\n')
  assert.equal(tpl.dependencyRefs.length, 0, '「- 无」必须识别为没有依赖')
  const tpl2 = parseTemplate('## 前置依赖\n- DM0002\n- 见 https://x/y?issue=DM0003\n- 还有 DM0004 要做完\n')
  assert.deepEqual(tpl2.dependencyRefs.map((x) => x.ref), ['DM0002', 'DM0003', 'DM0004'],
    '应同时识别 Gitee 编号与 ?issue= 链接，且保持描述里的先后顺序')
  assert.ok(tpl2.dependencyRefs.every((x) => x.kind === 'ident'))
  // 🔴 真实数据里最常用的写法：WBS 编码（带连字符），曾经被整段漏掉
  const tpl3 = parseTemplate('## 前置依赖\n- HE-03 零件尺寸确定\n- DEMO900-ME-02 结构布局确定\n')
  assert.deepEqual(tpl3.dependencyRefs.map((x) => [x.ref, x.kind]), [['HE-03', 'wbs'], ['DEMO900-ME-02', 'wbs']],
    'WBS 编码必须被识别为依赖引用（只认 Gitee 编号会把「有依赖」显示成「没有依赖」）')
  assert.equal(tpl3.dependencyRefs[0].label, '零件尺寸确定', '引用后面的说明文字要留着，反查不到时兜底显示')
  assert.equal(parseTemplate('随便一段没有分段的描述').hasTemplate, false)
  // 标题前缀 → 编码；短码按 `-` 分段做后缀匹配
  assert.equal(codeOfTitle('【DEMO900-ME-02】设计结构适配'), 'DEMO900-ME-02')
  assert.equal(codeOfTitle('普通标题'), '')
  assert.equal(codeMatches('DEMO900-ME-02', 'ME-02'), true, '描述写短码、标题写全名 —— 必须能对上')
  assert.equal(codeMatches('DEMO900-ME-02', 'DEMO900-ME-02'), true)
  assert.equal(codeMatches('DEMO900-ME-02', 'HE-02'), false, '不同前缀的编码不得误配')
  console.log('  ✓ 描述模板解析：编号 / WBS 编码（含短码后缀匹配）/ ?issue= 链接 / 「无」/ 无分段')

  // 阈值可覆盖（部署级配置，不改代码）
  const custom = resolveThresholds({
    GITEE_CHAT_STALL_DAYS: '3', GITEE_CHAT_REQUIRED_LABELS: '0', GITEE_CHAT_WEEKLY_CAPACITY: '4',
  })
  assert.equal(custom.stallDays, 3)
  assert.equal(custom.requiredLabels, 0, '标签数设 0 表示关闭该检查')
  assert.equal(custom.weeklyCapacity, 4)
  assert.equal(custom.overloadOpen, THRESHOLD_DEFAULTS.overloadOpen, '未覆盖的阈值保持默认')
  // 关闭标签检查后，未完成项不得再因标签数被判不合规
  const noLabels = computeAnalysis({
    programs, issues: [mkIssue({ id: 1, ident: 'A', assignee: '甲', deadline: day(3), labels: ['只有一个'] })],
    now: NOW, thresholds: custom,
  })
  assert.equal(noLabels.compliance.length, 0, 'requiredLabels=0 时不得按标签数判不合规')
  console.log('  ✓ 阈值可配置：停滞/容量可覆盖，标签数设 0 即关闭该检查（别人家的规范不必与本案相同）')

  // ══ 12g. 可移植性：不依赖 preset 命名 / 不写死企业 ═══════════════════════
  assert.equal(compositionMountsRow("name: x\n  - name: 'dsh-gitee-chat/agent'\n", 'dsh-gitee-chat/agent'), true)
  assert.equal(compositionMountsRow('name: x\n  - name: "dsh-gitee-chat/agent"\n', 'dsh-gitee-chat/agent'), true)
  assert.equal(compositionMountsRow('name: x\n  - name: dsh-gitee-chat/agent\n', 'dsh-gitee-chat/agent'), true)
  assert.equal(compositionMountsRow('name: x\n  # name: dsh-gitee-chat/agent\n', 'dsh-gitee-chat/agent'), false,
    '注释里的同名行不得被当成挂了插件')
  assert.equal(compositionMountsRow("name: 'other/agent'\n", 'dsh-gitee-chat/agent'), false)
  // 显式 presetIds 优先（部署说了算，不读盘）
  const explicitHost = fakeCtx()
  applyHost(explicitHost, { presetIds: ['my-mode'], allowWrites: false })
  explicitHost.emit('agent-preset/selected', 's1', 'my-mode')
  explicitHost.emit('agent-preset/selected', 's2', '我的项目助手')
  const explicitHandler = explicitHost.rec.routes[0].handler
  assert.equal((await call(explicitHandler, { method: 'GET', url: '/api/gitee-chat/session?sessionId=s1' })).json.gitee, true)
  assert.equal((await call(explicitHandler, { method: 'GET', url: '/api/gitee-chat/session?sessionId=s2' })).json.gitee, false,
    '给了显式 presetIds 时不再按组合文本判定')
  assert.equal(explicitHost.rec.provided.giteeChat.writer.enabled(), false, 'allowWrites=false 必须传到写通道')
  console.log('  ✓ 可移植性：preset 判定与命名解耦（含注释不误判）；presetIds 显式覆盖生效')

  // ══ 12h. skill 按插件标准随包加载（不是拷到 $DSH_HOME/skills）═══════════
  //
  // 🔴 这一节守的是"安装方式"本身：skill 真源在插件包里，由本包 bundle 补丁
  // （0.4.5 起是 cordis.skills.patch.yml）挂一个 skill provider
  // 指向 <包>/skills。踩过的两个坑都在断言里：
  //   · providerName 必须换名（宿主的 provider 叫 filesystem，同名即启动失败）
  //   · !!js 元素必须返回**字符串**（返回数组会变成 [[path]]，schema 直接报错）
  const patchText = bundlePatchTextOf()
  assert.ok(patchText.includes('id: gitee-chat-skills'), '插件补丁必须声明 gitee-chat-skills 行')
  assert.ok(patchText.includes("providerName: 'gitee-chat-skills'"),
    'skill provider 必须换名：宿主已有一个叫 filesystem 的，同名会让整棵插件树启动失败')
  assert.ok(patchText.includes('includeDefaultRoots: false'),
    'skill provider 必须关掉默认根，避免与宿主 provider 重复扫 project/user 根')

  // SKILL.md 的 frontmatter 必须合法（name + description，且 name 与目录名一致）
  const skillPath = join(root, 'skills', 'dsh-gitee-chat', 'SKILL.md')
  // 换行先归一成 LF：Windows 结账（core.autocrlf=true，Git for Windows 的默认值）
  // 会把工作区文本变成 CRLF，而下面几条断言是逐行锚定的（`^---$` / `^name:`）。
  // 守卫不该依赖结账时的行尾 —— 否则 windows 矩阵在 CI 上必红，而 Linux 本地全绿。
  const skillText = (await readFile(skillPath, 'utf8')).replace(/\r\n/g, '\n')
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(skillText)
  assert.ok(fm !== null, 'SKILL.md 必须有 YAML frontmatter')
  assert.match(fm[1], /^name: dsh-gitee-chat$/m, 'SKILL.md 的 name 必须与目录名一致')
  assert.match(fm[1], /^description: .{40,}$/m, 'SKILL.md 必须有像样的 description（检索靠它）')
  // 这个 skill 是"教 AI 装/配"的，必须真的讲清四步与两条硬规则
  for (const needle of ['setup.mjs detect', 'setup.mjs apply', 'setup.mjs verify', 'cordis.patch.yml', '绝不']) {
    assert.ok(skillText.includes(needle), `SKILL.md 缺少「${needle}」`)
  }
  console.log('  ✓ skill：随包分发，SKILL.md frontmatter 合法，补丁行声明齐全')

  // !!js 表达式：成功分支解析到本包 skills/，失败分支 fail-soft 回落到不存在的路径
  const exprMatch = /customSkillDirs:\s*\n\s*-\s*!!js\s*"([^"]+)"/.exec(patchText)
  assert.ok(exprMatch !== null, '补丁里必须有一条 customSkillDirs 的 !!js 表达式')
  const evaluate = (baseUrl) => new Function('baseUrl',
    `with ({ baseUrl }) { return eval(${JSON.stringify(exprMatch[1])}) }`)(baseUrl)

  // 失败分支：baseUrl 指向一个解析不到本包的目录 → 必须返回字符串、不许抛。
  // 🔴 这里必须用**本平台合法**的 file URL：win32 下 `fileURLToPath('file:///tmp/…')`
  // 会抛 ERR_INVALID_FILE_URL_PATH（`file:///tmp/x` 不是合法的 win32 文件 URL），
  // 而表达式的 catch 分支里还要再 fileURLToPath 一次 —— 异常直接从 catch 里冒出来。
  // 那是这个夹具的错，不是表达式的错：真实的 baseUrl 永远是 DSH 给的 profile 目录 URL。
  const noSuchProfile = join(tmpdir(), 'gq-no-such-profile')
  const fallback = evaluate(`${pathToFileURL(noSuchProfile).href}/`)
  assert.equal(typeof fallback, 'string', '解析失败时必须 fail-soft 返回字符串（抛错会让整个 DSH 起不来）')
  assert.ok(fallback.includes('no-skills'), `失败分支应回落到哨兵路径，实际 ${fallback}`)
  assert.equal(pathExists(fallback), false, '失败分支回落的路径不应存在')

  // 成功分支：造一个"profile 里有本包"的目录 → 必须解析到 <包>/skills
  const fakeBase = await mkdtemp(join(tmpdir(), 'gq-skill-anchor-'))
  await mkdir(join(fakeBase, 'node_modules'), { recursive: true })
  await linkDir(root, join(fakeBase, 'node_modules', 'dsh-gitee-chat'))
  const resolved = evaluate(`${pathToFileURL(fakeBase).href}/`)
  assert.equal(resolved, join(root, 'skills'),
    '成功分支必须解析到 <包>/skills（customSkillDirs 的元素是**根目录**，不是 skill 自身目录）')
  assert.equal(pathExists(join(resolved, 'dsh-gitee-chat', 'SKILL.md')), true,
    '解析出的根目录下必须有 dsh-gitee-chat/SKILL.md —— 否则 skill 在线上永远发现不了')
  await rm(fakeBase, { recursive: true, force: true })
  console.log('  ✓ skill 挂载表达式：成功分支解析到 <包>/skills 且 SKILL.md 可发现；失败分支 fail-soft 不抛错')

  // ══ 12i. setup.mjs 的四个动词都能跑（AI 靠它做到"使用者无操作"）══════════
  for (const [args, needle] of [
    [['detect', '--json'], '"dshHome"'],
    [['questions', '--json'], '"ifUnanswered"'],
    [['apply', '--answers', '{"allowWrites":false}', '--dry-run', '--json'], '"patch"'],
  ]) {
    const { stdout } = await run(process.execPath, [join(root, 'scripts/setup.mjs'), ...args], {
      cwd: root, timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    })
    assert.ok(stdout.includes(needle), `setup ${args[0]} 的输出缺少 ${needle}`)
  }
  // dry-run 必须不落盘
  const patchBefore = bundlePatchTextOf()
  assert.ok(patchBefore.includes('id: gitee-chat-skills'), 'dry-run 不得改动插件补丁')
  // questions 必须"不回答也能装"：每个问题都有 ifUnanswered
  const { stdout: qOut } = await run(process.execPath, [join(root, 'scripts/setup.mjs'), 'questions', '--json'], {
    cwd: root, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  })
  const q = JSON.parse(qOut)
  assert.equal(q.canRunWithDefaults, true, '必须允许"使用者什么都不答"直接 apply')
  assert.ok(q.questions.every((x) => 'ifUnanswered' in x), '每个问题都必须有未回答时的兜底值')
  assert.ok(q.questions.every((x) => Array.isArray(x.options) && x.options.length > 0), '每个问题都要给选项')
  console.log(`  ✓ setup：detect / questions / apply --dry-run 均可用；${q.questions.length} 个问题全部带默认值与兜底值`)

  // ══ 12j. apply 真的改文件时只动自己那一段（隔离 DSH_HOME 端到端）═══════
  //
  // 🔴 这一节守的是"AI 替使用者改 profile 补丁"的安全性：补丁是人手维护的文件，
  // 里面已经有别人的配置。断言：别人的配置一个字节都不能变、重跑幂等、
  // 删掉哨兵后本脚本就不再接管。
  const isoHome = await mkdtemp(join(tmpdir(), 'gq-setup-home-'))
  const isoProfile = join(isoHome, 'profiles', 'iso')
  await mkdir(isoProfile, { recursive: true })
  await writeFile(join(isoProfile, 'cordis.yml'), '[]\n')
  await writeFile(join(isoProfile, 'package.json'), JSON.stringify({
    name: 'iso-profile', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-gitee-chat'] } },
  }, null, 2) + '\n')
  // 别人的配置：注释 + 一条完全无关的条目。apply 必须原样保留它们。
  const FOREIGN_HEAD = '# 我的补丁层\n# 这条注释很重要\n'
  const FOREIGN_ROW = "- id: some-other-plugin\n  config:\n    keepMe: 'yes'\n    n: 42\n"
  await writeFile(join(isoProfile, 'cordis.patch.yml'), `${FOREIGN_HEAD}\n${FOREIGN_ROW}`)

  const runSetup = async (args) => {
    const { stdout } = await run(process.execPath, [join(root, 'scripts/setup.mjs'), ...args], {
      cwd: root, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, DSH_HOME: isoHome },
    })
    return stdout
  }

  const applyOut = JSON.parse(await runSetup([
    'apply', '--json',
    '--answers', JSON.stringify({ profile: 'iso', enterpriseId: 4242, allowWrites: false, requiredLabels: 0, weeklyCapacity: 7 }),
  ]))
  assert.equal(applyOut.ok, true, `apply 应成功：${JSON.stringify(applyOut.warnings)}`)
  assert.equal(applyOut.patch.mode, 'insert', '首次 apply 应是「新增本插件段落」')

  const after1 = await readFile(join(isoProfile, 'cordis.patch.yml'), 'utf8')
  assert.ok(after1.startsWith(FOREIGN_HEAD), '别人的头部注释必须原样保留（连位置都不能变）')
  assert.ok(after1.includes(FOREIGN_ROW), '别人的条目必须原样保留')
  assert.ok(after1.includes('# >>> gitee-chat'), '必须写入哨兵起始行')
  assert.ok(after1.includes('# <<< gitee-chat <<<'), '必须写入哨兵结束行')
  // 答案必须真的落进配置，而不是写了个默认值
  assert.match(after1, /enterpriseId: 4242/, 'enterpriseId 应写入答案值')
  assert.match(after1, /allowWrites: false/, 'allowWrites 应写入答案值')
  assert.match(after1, /requiredLabels: 0/, 'requiredLabels 应写入答案值（0 = 关闭标签检查）')
  assert.match(after1, /weeklyCapacity: 7/, 'weeklyCapacity 应写入答案值')
  assert.ok(applyOut.patch.backup !== null, '改前必须备份原文件')
  assert.equal(await readFile(applyOut.patch.backup, 'utf8'), `${FOREIGN_HEAD}\n${FOREIGN_ROW}`,
    '备份内容必须与改动前完全一致')
  // profile 补丁的 config 是整体替换 → 必须是完整配置，不能只写几个键
  for (const key of ['apiBase', 'scriptTimeoutMs', 'allowFixtureFallback', 'roleTtlSeconds', 'mode',
    'userAgent', 'presetIds', 'agentRowName', 'thresholds', 'stallDays', 'trendWeeks', 'milestoneRiskDays']) {
    assert.ok(after1.includes(key), `完整配置必须包含 ${key}（profile 补丁的 config 是整体替换，少一个键就重置成默认值）`)
  }
  // 本地企业配置也写了（不用重启就能切的那种）
  const isoLocal = JSON.parse(await readFile(join(isoHome, '.gitee-chat', 'config.json'), 'utf8'))
  assert.equal(isoLocal.enterpriseId, 4242, '本地企业配置应同步写入')

  // 幂等：同样的答案再跑一次，文件不应变化
  const second = JSON.parse(await runSetup([
    'apply', '--json',
    '--answers', JSON.stringify({ profile: 'iso', enterpriseId: 4242, allowWrites: false, requiredLabels: 0, weeklyCapacity: 7 }),
  ]))
  assert.equal(second.patch.changed, false, '同答案重跑不应改动文件（幂等）')
  assert.equal(await readFile(join(isoProfile, 'cordis.patch.yml'), 'utf8'), after1, '重跑后文件必须逐字节一致')

  // 改一个答案 → 只替换哨兵之间，别人那段仍在
  await runSetup(['apply', '--json', '--answers', JSON.stringify({ profile: 'iso', enterpriseId: 7 })])
  const after3 = await readFile(join(isoProfile, 'cordis.patch.yml'), 'utf8')
  assert.match(after3, /enterpriseId: 7/, '新答案应生效')
  assert.ok(after3.includes(FOREIGN_ROW), '替换本插件段落时别人的条目仍须保留')
  assert.equal(after3.split('# >>> gitee-chat').length - 1, 1, '哨兵不应重复堆叠')

  // 删掉哨兵 → 本脚本不再接管那一段（交还给使用者）
  await writeFile(join(isoProfile, 'cordis.patch.yml'),
    `${FOREIGN_HEAD}\n${FOREIGN_ROW}\n\n- id: gitee-chat\n  config:\n    enterpriseId: 99\n`)
  const adopted = JSON.parse(await runSetup([
    'apply', '--json', '--answers', JSON.stringify({ profile: 'iso', enterpriseId: 7 }),
  ]))
  assert.equal(adopted.patch.mode, 'replace', '没有哨兵时应识别出既有的 - id: gitee-chat 段落并替换')
  const after4 = await readFile(join(isoProfile, 'cordis.patch.yml'), 'utf8')
  assert.ok(after4.includes(FOREIGN_ROW), '替换既有段落时别人的条目仍须保留')
  assert.equal(after4.includes('enterpriseId: 99'), false, '旧的段落内容必须被换掉')

  // 🔴 scriptPath 绝不能写进补丁：写空串会覆盖包内默认值 → `node '' …` → 静默零输出
  assert.equal(/^\s{4}scriptPath:/m.test(after1), false,
    'scriptPath 不得作为生效键写入补丁（省略 = 用包内默认；写空串曾导致整块看板「取数失败」）')
  assert.match(after1, /#\s*scriptPath:/, 'scriptPath 应以注释形式给出，让人知道有这个开关')

  // 🔴 detect 报给 AI 的"现状"必须是干净的值：行内注释不能被当成值的一部分
  // （`requiredLabels: 0   # 0 = 关闭` 曾被解析成字符串，AI 据此答"阈值不对"就会答错）
  const isoDetect = JSON.parse(await runSetup(['detect', '--json']))
  const isoProfileInfo = isoDetect.profiles.find((p) => p.name === 'iso')
  assert.ok(isoProfileInfo !== undefined, 'detect 应列出隔离 profile')
  const seenGlyph = isoProfileInfo.currentConfig
  assert.equal(seenGlyph.present, true, 'detect 应看到补丁里本插件那一段')
  const seen = seenGlyph.config
  assert.ok(seen !== null, 'detect 应能读回自己写下的 config')
  assert.equal(typeof seen.thresholds.requiredLabels, 'number',
    `requiredLabels 必须是数字，实际 ${JSON.stringify(seen.thresholds.requiredLabels)}（行内注释没剥干净）`)
  assert.equal(seen.thresholds.requiredLabels, 3,
    '阈值应读回答案值（此处已因 12j 最后一次 apply 未带该答案而回落默认 3）')
  assert.equal(typeof seen.thresholds.weeklyCapacity, 'number', '带行内注释的阈值都要能读成数字')
  assert.equal(seen.thresholds.weeklyCapacity, 10, '未作答时回落默认 10，且必须是数字')
  assert.equal(typeof seen.thresholds.milestoneRiskDays, 'number', '末尾那一行也带注释，不能漏')
  assert.equal(seen.enterpriseId, 7, '标量也要读回答案值（此处已被 12j 改成 7）')
  assert.equal(seen.allowWrites, true, '布尔值要读成 true 而不是字符串')
  assert.equal(seen.apiBase, 'https://api.gitee.com/enterprises', '带引号的标量要去引号')
  assert.equal(seen.scriptPath, undefined, '补丁里没有 scriptPath 键时不应凭空造一个')

  await rm(isoHome, { recursive: true, force: true })
  console.log('  ✓ setup apply：只动自己的哨兵段 / 保留别人的配置与注释 / 改前备份 / 幂等 / 无哨兵时接管既有段落')
  console.log('  ✓ detect 回读：不写 scriptPath / 行内注释不污染阈值（回归：「取数失败」根因）')

  // ══ 12j-bis. agent 半的可解析性：`link:` 安装的死穴（2026-09-21 同事机实证）══
  //
  // 契约：插件被 `link:` 装进 profile 时，模块 realpath 落在 profiles/** 之外，
  // Node 的父目录回溯够不到 DSH 的依赖闭包（`$DSH_HOME/profiles/node_modules`，
  // 里面是指向 harness 自身安装的链接），于是 agent 半那句运行时裸导入
  // `@deepseek-ai/dsh-tools` 抛 `Cannot find package`。它**只在起会话组装 preset
  // 时**被加载 → 界面表现是「选了工作区没反应」（会话建不起来，前端静默退回）。
  //
  // 所以这里用**临时 fixture 真跑子进程**（不 mock 解析行为）：复现失败 → 补一跳
  // → 再探成功；并守住反面 —— 真目录装法本来就解析得到，**不该**被补链。
  const { probeAgentImport, repairAgentResolution } = await import('../scripts/setup.mjs')

  /** 造一份最小 fixture 的公共部分：依赖闭包 + 一个带裸导入的插件包。 */
  const writeStubClosure = async (base) => {
    const closure = join(base, 'profiles', 'node_modules')
    const stub = join(closure, '@deepseek-ai', 'dsh-tools')
    await mkdir(stub, { recursive: true })
    await writeFile(join(stub, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-tools', version: '0.0.0-test', type: 'module', main: 'index.js',
    }))
    await writeFile(join(stub, 'index.js'), 'export function defineTool(o) { return o }\n')
    return closure
  }
  const writePluginDir = async (dir) => {
    await mkdir(join(dir, 'lib'), { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({
      name: 'dsh-gitee-chat', version: '0.0.0-test', type: 'module',
      exports: { '.': './lib/index.js', './agent': './lib/agent.js' },
    }))
    await writeFile(join(dir, 'lib', 'index.js'), 'export const host = 1\n')
    // agent 半：一个**运行时**裸导入 —— 正是同事机上报错的那个
    await writeFile(join(dir, 'lib', 'agent.js'),
      "import { defineTool } from '@deepseek-ai/dsh-tools'\nexport const probe = typeof defineTool\n")
  }

  // A) `link:` 装法 —— 必须失败，且必须能自愈
  const fixA = await mkdtemp(join(tmpdir(), 'gitee-resolve-link-'))
  const closureA = await writeStubClosure(fixA)
  const pluginA = join(fixA, 'pkgs', 'fake')
  await writePluginDir(pluginA)
  const webA = join(fixA, 'profiles', 'web')
  await mkdir(join(webA, 'node_modules'), { recursive: true })
  await writeFile(join(webA, 'package.json'), JSON.stringify({
    name: 'web', private: true, dependencies: { 'dsh-gitee-chat': 'link:../../pkgs/fake' },
  }))
  await linkDir(pluginA, join(webA, 'node_modules', 'dsh-gitee-chat'))

  const probeBefore = await probeAgentImport(webA)
  assert.equal(probeBefore.ok, false, 'link: 装法下 agent 半应当解析失败（探针没探到就是白装）')
  assert.match(String(probeBefore.error), /@deepseek-ai\/dsh-tools/,
    `失败原因必须指名那个裸导入，实际：${probeBefore.error}`)

  const repair = repairAgentResolution(webA, { closureRoot: closureA })
  assert.equal(repair.action, 'linked', `link: 装法应当补一跳，实际 ${repair.action}：${repair.note ?? ''}`)
  assert.ok(pathExists(join(pluginA, 'node_modules', '@deepseek-ai', 'dsh-tools')),
    '补的那一跳必须真指向闭包里的包（而不是空目录）')
  const probeAfter = await probeAgentImport(webA)
  assert.equal(probeAfter.ok, true, '补一跳之后必须解析成功')
  assert.equal(repairAgentResolution(webA, { closureRoot: closureA }).action, 'skipped',
    '已补过就不该重复动（幂等）')
  await rm(fixA, { recursive: true, force: true })

  // B) 真目录装法（`file:` / 正常 pnpm 装）—— 本来就通，不该被补链
  const fixB = await mkdtemp(join(tmpdir(), 'gitee-resolve-file-'))
  const closureB = await writeStubClosure(fixB)
  const webB = join(fixB, 'profiles', 'web')
  await mkdir(join(webB, 'node_modules'), { recursive: true })
  await writeFile(join(webB, 'package.json'), JSON.stringify({
    name: 'web', private: true, dependencies: { 'dsh-gitee-chat': 'file:../../pkgs/fake' },
  }))
  await writePluginDir(join(webB, 'node_modules', 'dsh-gitee-chat'))
  assert.equal((await probeAgentImport(webB)).ok, true,
    '真目录装法应当靠父目录回溯命中 profiles/node_modules')
  assert.equal(repairAgentResolution(webB, { closureRoot: closureB }).action, 'skipped',
    '真目录装法不该被补链')
  await rm(fixB, { recursive: true, force: true })

  console.log('  ✓ agent 半可解析性：link: 复现 Cannot find package → 自动补一跳 → 通过；file: 装法不补')

  // C) 接线：`apply` 必须真的触发自愈（不然上面那两条只是"函数能跑"）
  const agentHealHome = await mkdtemp(join(tmpdir(), 'gitee-heal-home-'))
  await writeStubClosure(agentHealHome)
  const agentHealPlugin = join(agentHealHome, 'plugins', 'dsh-gitee-chat')
  await writePluginDir(agentHealPlugin)
  const agentHealProfile = join(agentHealHome, 'profiles', 'iso')
  await mkdir(join(agentHealProfile, 'node_modules'), { recursive: true })
  await writeFile(join(agentHealProfile, 'cordis.yml'), '[]\n')
  await writeFile(join(agentHealProfile, 'package.json'), JSON.stringify({
    name: 'iso-profile', private: true,
    dependencies: { 'dsh-gitee-chat': `link:${agentHealPlugin}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-gitee-chat'] } },
  }, null, 2) + '\n')
  await linkDir(agentHealPlugin, join(agentHealProfile, 'node_modules', 'dsh-gitee-chat'))

  const { stdout: agentHealOut } = await run(process.execPath, [
    join(root, 'scripts/setup.mjs'), 'apply', '--json',
    '--answers', JSON.stringify({ profile: 'iso', enterpriseId: 1, allowWrites: true, requiredLabels: 0 }),
  ], {
    cwd: root, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, DSH_HOME: agentHealHome },
  })
  const agentHealed = JSON.parse(agentHealOut)
  assert.equal(agentHealed.agentHalf.present, true, 'fixture 里插件是装着的，探针必须探到')
  assert.equal(agentHealed.agentHalf.repair?.action, 'linked', `apply 必须自动补那一跳，实际 ${agentHealed.agentHalf.repair?.action}：${agentHealed.agentHalf.repair?.note ?? ''}`)
  assert.equal(agentHealed.agentHalf.ok, true, '补完之后 agent 半必须可 import')
  assert.ok(pathExists(join(agentHealPlugin, 'node_modules', '@deepseek-ai', 'dsh-tools')), '补的跳要真的落在包内')
  assert.ok((agentHealed.nextSteps ?? []).some((s) => String(s).includes('补一跳')),
    'nextSteps 要主动说明补过一跳（否则用户不知道为什么变了）')

  // 补丁注释里的 MCP 那一行必须说"随包"，不能说"未找到" ——
  // 随包二进制落在 $DSH_HOME/.gitee-chat/bin/，本来就不在 PATH 上；旧代码只看 PATH，
  // 于是同一轮 apply 里"刚落地 48 个工具的二进制"和注释里"MCP 可执行: 未找到"同时出现。
  const healPatch = readFileSync(join(agentHealProfile, 'cordis.patch.yml'), 'utf8')
  assert.match(healPatch, /# {3}MCP 可执行 : .+随包分发/,
    '补丁注释要报三级回落（env → 随包 → PATH）解析出来的那份，而不是"PATH 上有没有"')
  assert.ok(!healPatch.includes('未找到（MCP 工具会挂不上）'),
    '同一轮 apply 刚落地随包二进制，注释不能自相矛盾地说"未找到"')

  await rm(agentHealHome, { recursive: true, force: true })
  console.log('  ✓ apply 自愈接线：link: + 够不到闭包 → 自动补一跳 → agent 半可 import，并在 nextSteps 说明')
  console.log('  ✓ 补丁注释里的 MCP：报"随包分发"，不与同一轮落地动作自相矛盾')

  // ══ 12j-quater. 真机 Windows 上暴露的两个 setup.mjs 误报（回归）═══════════
  //
  // 都不是洁癖，是同事机器上真的发生了：装完插件，`detect`/`verify` 说企业 MCP 没装、
  // 还劝你去 `go install` 那个其实**随包分发**的 MCP；同时
  // `verify` 对 `file:`（官方推荐装法）稳定报「skill 未生效 ❌」。
  const { which, inspectSkill } = await import('../scripts/setup.mjs')

  // ① which()：PATH 分隔符写死 ':'、且不看 PATHEXT。
  //    用例在 Linux 上跑：env / platform 是注入的，所以不需要真机。
  const winBin = await mkdtemp(join(tmpdir(), 'gitee-which-'))
  await writeFile(join(winBin, 'git.EXE'), '')
  // Windows 文件系统大小写不敏感、PATHEXT 给的是大写，两者照样配得上；
  // Linux 的 fixture 必须按 PATHEXT 的大小写写，才能模拟这个行为。
  await writeFile(join(winBin, 'runner.COM'), '')
  await writeFile(join(winBin, 'notes.txt'), '')
  // 靠前的条目里也真放一个 git.EXE：这才既验了「按 ';' 切 + 按顺序找」，又不会像早先
  // 写死 `C:\Program Files\Git\cmd` 那样，在**真的装了 Git 的机器**上被那个目录抢先命中
  // ——Windows runner 与 Windows 开发机都装了 Git，写死就必红（which() 返回真 git 是对的）。
  const winBinFirst = await mkdtemp(join(tmpdir(), 'gitee-which-first-'))
  await writeFile(join(winBinFirst, 'git.EXE'), '')
  const winEnv = { PATH: `C:\\Windows\\System32;${winBinFirst};${winBin}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  assert.equal(which('git', winEnv, 'win32'), join(winBinFirst, 'git.EXE'),
    'Windows PATH 是 ";" 分隔、按顺序找，可执行文件带 PATHEXT 后缀（git.exe），都要处理')
  assert.equal(which('runner', winEnv, 'win32'), join(winBin, 'runner.COM'),
    '带 .COM 后缀的程序也要认得 —— 只试 .exe 就不够了')
  assert.equal(which('notes', winEnv, 'win32'), null,
    '不在 PATHEXT 里的后缀不算可执行程序（.txt 不该命中）')
  assert.equal(which('git', winEnv, 'linux'), null,
    '负例（这就是真机上的误报）：同一串按 ":" 切会被盘符切碎，什么也找不到')
  assert.equal(which('git', { PATH: winBin }, 'win32'), join(winBin, 'git.EXE'),
    'PATHEXT 环境变量缺失时要回落到 Windows 默认后缀表')
  assert.equal(which('git', { PATH: `"${winBin}";C:\\x`, PATHEXT: '.EXE' }, 'win32'), join(winBin, 'git.EXE'),
    'PATH 里带引号的条目（"C:\\Program Files\\..."）要先去掉引号')
  await rm(winBin, { recursive: true, force: true })
  await rm(winBinFirst, { recursive: true, force: true })

  // ② inspectSkill()：判据必须是"解析出来的目录里有没有 SKILL.md"，
  //    而不是"解析结果 == 源码目录"（后者只对 link: 成立）。
  const skillSrc = await mkdtemp(join(tmpdir(), 'gitee-skill-src-'))
  await mkdir(join(skillSrc, 'skills', 'dsh-gitee-chat'), { recursive: true })
  await writeFile(join(skillSrc, 'skills', 'dsh-gitee-chat', 'SKILL.md'), '# fixture\n')
  await writeFile(join(skillSrc, 'package.json'), JSON.stringify({ name: 'dsh-gitee-chat', version: '0.0.0-test' }))
  // 用**真补丁**，顺带证明那个 !!js 表达式确实是本函数能解析的形状。
  // inspectSkill 读 dsh.bundle.patch 声明的全部文件；这个假包没有该字段，会
  // 回退到包根 cordis.patch.yml —— 所以把真 skills 补丁写进那个文件名。
  await writeFile(join(skillSrc, 'cordis.patch.yml'), readFileSync(join(root, 'cordis.skills.patch.yml'), 'utf8'))

  const mkSkillProfile = async (mode) => {
    const profile = await mkdtemp(join(tmpdir(), `gitee-skill-${mode}-`))
    await mkdir(join(profile, 'node_modules'), { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'web', private: true }))
    const installed = join(profile, 'node_modules', 'dsh-gitee-chat')
    if (mode === 'link') {
      await linkDir(skillSrc, installed)
    } else {
      // file: / 正常 pnpm 装 —— 包被**复制**进来，不是软链
      await mkdir(join(installed, 'skills', 'dsh-gitee-chat'), { recursive: true })
      await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'dsh-gitee-chat', version: '0.0.0-test' }))
      // 'broken' 故意不写 SKILL.md
      if (mode !== 'broken') await writeFile(join(installed, 'skills', 'dsh-gitee-chat', 'SKILL.md'), '# copy\n')
    }
    return { profile, anchor: `${pathToFileURL(profile).href}/` }
  }

  const fileProfile = await mkSkillProfile('file')
  const asFile = inspectSkill(skillSrc, fileProfile.anchor)
  assert.equal(asFile.effective, true,
    `file: 装法（官方推荐）必须判为生效，实际解析到 ${asFile.resolvesTo}`)
  assert.equal(asFile.installedAs, 'file', 'file: 装法解析到的是副本')
  assert.notEqual(asFile.resolvesTo, asFile.dir,
    'file: 装法下解析结果必然 ≠ 源码目录 —— 旧判据（===）正是这样误报「未生效」的')
  assert.ok(asFile.resolvedSkillFile.startsWith(join(fileProfile.profile, 'node_modules')),
    `生效判据应当指着**真正被加载的那份**，实际 ${asFile.resolvedSkillFile}`)

  const linkProfile = await mkSkillProfile('link')
  const asLink = inspectSkill(skillSrc, linkProfile.anchor)
  assert.equal(asLink.effective, true, 'link: 装法同样必须判为生效')
  assert.equal(asLink.installedAs, 'link', 'link: 装法解析回源码目录')
  assert.equal(asLink.resolvesToSource, true, 'link: 下解析结果就是源码目录')

  const brokenProfile = await mkSkillProfile('broken')
  const asBroken = inspectSkill(skillSrc, brokenProfile.anchor)
  assert.equal(asBroken.effective, false,
    '负例：副本里没有 SKILL.md 时必须报未生效 —— 守卫不能只会说"好"')
  assert.equal(asBroken.rowDeclared, true, '未生效的原因应当是"解析到了但没有文件"，而不是"没声明"')

  await rm(skillSrc, { recursive: true, force: true })
  for (const p of [fileProfile, linkProfile, brokenProfile]) await rm(p.profile, { recursive: true, force: true })

  const realSkill = inspectSkill()
  assert.equal(realSkill.fileExists, true)
  assert.equal(realSkill.rowDeclared, true, '真补丁里必须有 gitee-chat-skills 行')

  console.log('  ✓ Windows 误报回归：which() 认 ";"+PATHEXT（":" 切法作为负例被钉死）；'
    + 'skill 按"解析结果里有 SKILL.md"判生效（file: 副本 ✓ / link: ✓ / 缺文件 ✗）')

  // ══ 12l. 随包 MCP 后端（让同事不需要 Go 环境）════════════════════════════
  //
  // 这一节守三件事，每一件都是"出错时不会报错、只会静默退化"的那一类：
  //   1. **入库的二进制真的提供能力矩阵声明的工具** —— preset 的
  //      `--enabled-toolsets` 是过滤器不是校验器，名字对不上只会静默少工具。
  //      上游 npm 版就没有 create_program（建项目），换过去不会报错。
  //   2. **三处路径算法必须一致** —— preset 的 `!!js` 表达式、宿主
  //      `materializedPath()`、setup 的 `mcpTargetPath()`。不一致只会"悄悄
  //      回落到 PATH 上的旧二进制"。
  //   3. **manifest 与仓库里的文件逐字节一致** —— 拷坏/换错要能发现。
  const manifestPath = join(root, 'vendor', 'mcp-gitee-ent', 'manifest.json')
  assert.ok(pathExists(manifestPath), '缺 vendor/mcp-gitee-ent/manifest.json；跑 node scripts/build-mcp.mjs')
  const mcpManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  assert.ok(Array.isArray(mcpManifest.tools) && mcpManifest.tools.length > 0,
    'manifest 必须记录二进制的真实工具清单（这是"换错二进制"的唯一探针）')
  assert.equal(mcpManifest.tools.length, mcpManifest.toolCount, 'toolCount 应与 tools 长度一致')
  assert.equal(mcpManifest.toolCount, 48, `二进制应有 48 个工具（上游 37 + fork 独有 11），实际 ${mcpManifest.toolCount}`)


  // 🔴 最关键的一条：能力矩阵声明的工具，入库二进制必须都给
  const declaredToolsets = presetToolsetsFromFile(presetPatchPath('gitee-manager'))
  assert.equal(declaredToolsets.length, 48, `gitee-manager 的 --enabled-toolsets 应为 manager 档的 48 个，实际 ${declaredToolsets.length}`)
  const provided = new Set(mcpManifest.tools)
  const toolGap = declaredToolsets.filter((t) => !provided.has(t))
  assert.deepEqual(toolGap, [],
    `随包二进制缺少能力矩阵声明的工具：${toolGap.join(', ')}（别换成上游 npm 版——它没有 create_program）`)
  for (const t of ['create_program', 'create_doc_node', 'create_wiki']) {
    assert.ok(provided.has(t), `随包二进制必须有 ${t}（fork 相对上游多出来的那批）`)
  }
  // 上游 npm 版**没有** create_program：用一个假的清单验证缺口能被测出来
  const fakeManifest = { tools: mcpManifest.tools.filter((t) => t !== 'create_program') }
  assert.deepEqual(toolGapOf(fakeManifest, declaredToolsets), ['create_program'],
    '换错二进制时必须能报出 create_program 缺失（否则建项目会静默消失）')
  assert.equal(toolGapOf(null, declaredToolsets), null, '清单不可用时应返回 null 而不是空数组（别假装没问题）')

  // 溯源：出问题时"这份二进制到底是谁编的、基于哪版上游"必须能一眼答出来
  assert.match(mcpManifest.forkCommit, /^[0-9a-f]{40}$/, 'manifest 必须记录 fork commit')
  assert.match(mcpManifest.goVersion, /^go version go/, 'manifest 必须记录 Go 版本')
  assert.equal(typeof mcpManifest.upstreamBase, 'string', 'manifest 必须记录上游基线版本')
  assert.match(mcpManifest.sourceFingerprint, /^[0-9a-f]{64}$/,
    'manifest 必须记录 Go 源码指纹 —— 没它就无法发现「改了源码忘了重编」'
      + '（Go 构建不可复现，所以只能靠指纹而不是重新编译来比对）')
  assert.ok(mcpManifest.sourceFileCount > 0, '记录指纹覆盖了多少个文件')

  // 互补关系要**记录在案**，不能只活在人的记忆里
  assert.ok(Array.isArray(mcpManifest.forkOnlyTools) && mcpManifest.forkOnlyTools.length === 11,
    `fork 独有工具应记录 11 个，实际 ${mcpManifest.forkOnlyTools?.length}`)
  assert.ok(Array.isArray(mcpManifest.mergedUpstreamTools) && mcpManifest.mergedUpstreamTools.length === 6,
    '从上游并进来的工具应记录为 6 个（两边的知识库能力是互补+两处重叠）')
  // 并进来的必须真的在（曾经的失败模式就是"静默少工具"）
  const mergedGone = mcpManifest.mergedUpstreamTools.filter((t) => !provided.has(t))
  assert.deepEqual(mergedGone, [], `入库二进制缺少已并入的上游工具：${mergedGone.join(', ')}`)
  // 版本注入：握手自报的必须等于 manifest 记的，否则 -X 没生效
  assert.equal(mcpManifest.reportedVersion, mcpManifest.binaryVersion,
    `二进制自报版本 ${mcpManifest.reportedVersion} ≠ manifest 的 ${mcpManifest.binaryVersion}（-X 注入没生效）`)
  assert.match(mcpManifest.binaryVersion, /^\d+\.\d+\.\d+/, 'binaryVersion 应是真实版本号而不是 dev')
  // 「我们独有的」必须都在真实工具清单里（记录与事实对得上）
  const forkOnlyMissing = mcpManifest.forkOnlyTools.filter((t) => !provided.has(t))
  assert.deepEqual(forkOnlyMissing, [], `fork 独有工具记录与事实不符：${forkOnlyMissing.join(', ')}`)
  console.log(`  ✓ 溯源完整：上游基线 ${mcpManifest.upstreamBase} · 二进制 ${mcpManifest.binaryVersion}`
    + ` · 源码指纹 ${mcpManifest.sourceFingerprint.slice(0, 12)}…`
    + ` · 独有 ${mcpManifest.forkOnlyTools.length} / 已并入 ${mcpManifest.mergedUpstreamTools.length}`)

  // 三处路径算法一致：宿主 / setup / preset 表达式（落在**用户级 bin**）
  assert.equal(platformKey('linux', 'x64'), 'linux-x64')
  assert.equal(platformKey('win32', 'x64'), 'win32-x64')
  assert.equal(userBinDir('linux', {}, '/home/x'), join('/home/x', '.local', 'bin'))
  assert.equal(userBinDir('linux', { XDG_BIN_HOME: '/opt/b' }, '/home/x'), '/opt/b')
  assert.equal(userBinDir('win32', {}, 'C:/u/b'), join('C:/u/b', '.local', 'bin'))
  assert.equal(materializedPath('linux', {}, '/home/x'), join('/home/x', '.local', 'bin', 'mcp-gitee-ent'))
  assert.equal(materializedPath('linux', { XDG_BIN_HOME: '/opt/b' }, '/home/x'), join('/opt/b', 'mcp-gitee-ent'))
  assert.equal(binaryName('win32'), 'mcp-gitee-ent.exe')
  assert.match(materializedPath('win32', {}, 'C:/u/b'), /\.local[\\/]bin[\\/]mcp-gitee-ent\.exe$/,
    'Windows 上是 %USERPROFILE%\\.local\\bin 且带 .exe')
  // PATH 判定：Windows 不区分大小写、忽略分隔符与尾斜杠
  assert.equal(isOnPath('/opt/b', { PATH: '/usr/bin:/opt/b/' }, 'linux'), true)
  assert.equal(isOnPath('/opt/c', { PATH: '/usr/bin:/opt/b' }, 'linux'), false)
  assert.equal(isOnPath('C:/Tools', { PATH: 'C:\\Windows;C:\\TOOLS\\' }, 'win32'), true)

  // preset 的 !!js 表达式：在 vm 里按平台求值，必须与宿主算出的路径逐字一致
  for (const [platform, env, homeKey] of [
    ['linux', { HOME: '/home/x' }, 'HOME'],
    ['linux', { HOME: '/home/x', XDG_BIN_HOME: '/opt/b' }, 'HOME'],
    ['win32', { USERPROFILE: 'C:/u/b' }, 'USERPROFILE'],
  ]) {
    for (const preset of ['gitee-manager', 'gitee-exec']) {
      const expr = presetCommandExpression(presetPatchPath(preset))
      assert.ok(expr !== null, `${preset} 的 mcp 行应写成 command: !!js "…" 的形式`)
      const expected = materializedPath(platform, env, env[homeKey]).replace(/\\/g, '/')
      const got = evaluateExpression(expr, { env, platform, materialized: 'user' }).replace(/\\/g, '/')
      assert.equal(got, expected,
        `${preset} 在 ${platform} 上算出的路径与宿主 materializedPath() 不一致（会悄悄回落到 PATH）`)
      // 新位置没有、PATH 上也没有 → 回落到裸名，而不是一个不存在的绝对路径
      const fallback = evaluateExpression(expr, { env, platform, materialized: false })
      assert.equal(fallback, 'mcp-gitee-ent', `${preset} 未落地时应回落到 PATH 上的 mcp-gitee-ent`)
    }
  }
  // MCP_GITEE_ENT_BIN 优先级最高（自己带二进制的同事）
  const overrideExpr = presetCommandExpression(presetPatchPath('gitee-manager'))
  assert.equal(evaluateExpression(overrideExpr, {
    env: { MCP_GITEE_ENT_BIN: '/my/bin', HOME: '/home/x' }, platform: 'linux', materialized: 'user',
  }), '/my/bin')
  // 表达式只在 command: 那一行、且整句被引号包住（含 `: ` 的 plain 标量会被 YAML 截断）
  for (const preset of ['gitee-manager', 'gitee-exec']) {
    const text = readPresetPatchText(preset)
    const line = text.split('\n').find((l) => l.trim().startsWith('command:'))
    assert.match(line, /command: !!js "/, `${preset} 的 command 必须是双引号包住的 !!js（含 ': '，plain 标量会被截断）`)
    assert.equal(text.includes('command: mcp-gitee-ent'), false,
      `${preset} 不应再写裸的命令名（那样就用不上随包二进制了）`)
  }
  console.log(`  ✓ 随包 MCP：${mcpManifest.toolCount} 个工具 · ${Object.keys(mcpManifest.platforms).join('/')}`
    + ` · 与能力矩阵一致（${declaredToolsets.length} 个声明全覆盖）`)

  // manifest 与仓库里的文件逐字节一致
  for (const [key, entry] of Object.entries(mcpManifest.platforms)) {
    const file = join(root, 'vendor', 'mcp-gitee-ent', entry.file)
    assert.ok(pathExists(file), `${key} 声明的 ${entry.file} 不在仓库里`)
    assert.equal(statSync(file).size, entry.size, `${entry.file} 大小与 manifest 不符`)
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), entry.sha256,
      `${entry.file} sha256 与 manifest 不符（被换过或拷坏了）`)
  }
  console.log('  ✓ 随包 MCP 二进制与 manifest 逐字节一致（sha256 全部命中）')

  // 隔离 DSH_HOME + 用户级 bin 里真的落地一次：apply 之后 preset 表达式必须能取到那个文件。
  //
  // ⚠️ 落点由**平台**决定，不能只按 POSIX 那份写：Windows 是 `%USERPROFILE%\.local\bin`
  // 且二进制带 `.exe`（见 src/host/mcpBinary.ts 的 userBinDir / binaryName），而 Node 的
  // `homedir()` 在 Windows 上读 `USERPROFILE`、**不认 `HOME`** —— 两个都得塞进 env，
  // 否则子进程拿的是真机主目录：既把 16 MiB 二进制拷进用户真实的 `~/.local/bin`，
  // 又去临时目录里找一个永远不会出现的文件（Windows 上稳定红）。
  const mcpHome = await mkdtemp(join(tmpdir(), 'gq-mcp-home-'))
  const mcpUserBin = join(mcpHome, 'userbin')
  const mcpApplyEnv = {
    ...process.env, DSH_HOME: mcpHome, HOME: mcpHome, USERPROFILE: mcpHome, XDG_BIN_HOME: mcpUserBin,
  }
  const mcpWin = process.platform === 'win32'
  const mcpLandingDir = mcpWin ? join(mcpHome, '.local', 'bin') : mcpUserBin
  const mcpBinName = mcpWin ? 'mcp-gitee-ent.exe' : 'mcp-gitee-ent'
  try {
    const mcpProfile = join(mcpHome, 'profiles', 'mcp')
    await mkdir(mcpProfile, { recursive: true })
    await writeFile(join(mcpProfile, 'cordis.yml'), '[]\n')
    await writeFile(join(mcpProfile, 'package.json'), JSON.stringify({
      name: 'mcp-profile', private: true,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-gitee-chat'] } },
    }, null, 2) + '\n')
    // 先造一个垃圾 .tmp-*（与产品清理用的 `<target>.tmp-<pid>` 同形），验证落地会顺手清掉它
    await mkdir(mcpLandingDir, { recursive: true })
    await writeFile(join(mcpLandingDir, `${mcpBinName}.tmp-99999`), 'stale tmp')

    const applied = JSON.parse(await run(process.execPath, [join(root, 'scripts/setup.mjs'), 'apply', '--json',
      '--answers', JSON.stringify({ profile: 'mcp', enterpriseId: 1 })], {
      cwd: root, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      env: mcpApplyEnv,
    }).then((r) => r.stdout))
    assert.equal(applied.mcp.ok, true, `apply 应落地随包 MCP 二进制：${JSON.stringify(applied.mcp)}`)
    const landed = join(mcpLandingDir, mcpBinName)
    assert.ok(pathExists(landed), `apply 后 ${landed} 应存在（落在用户级 bin）`)
    // Windows 的文件系统没有可执行位（statSync 恒 0o666），"能不能执行"由 `.exe` 后缀决定；
    // 产品那边也是按平台取名字的，不能拿 POSIX 的位去卡 Windows。
    if (!mcpWin) {
      assert.equal(statSync(landed).mode & 0o111, 0o111, '落地的二进制必须可执行（少了 +x 会 spawn EACCES）')
    }
    assert.equal(createHash('sha256').update(readFileSync(landed)).digest('hex'),
      mcpManifest.platforms[platformKey()].sha256, '落地的必须就是随包那份')
    assert.equal(pathExists(join(mcpLandingDir, `${mcpBinName}.tmp-99999`)), false,
      '落地前应顺手清掉上一轮留下的 .tmp-* 垃圾')
    // 幂等：再跑一次不应重拷（copied=false）
    const again = JSON.parse(await run(process.execPath, [join(root, 'scripts/setup.mjs'), 'apply', '--json',
      '--answers', JSON.stringify({ profile: 'mcp', enterpriseId: 1 })], {
      cwd: root, timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
      env: mcpApplyEnv,
    }).then((r) => r.stdout))
    assert.equal(again.mcp.copied, false, '内容一致时不应重复拷贝（幂等）')
    assert.equal(again.mcp.ok, true)
    console.log('  ✓ apply 落地随包 MCP 二进制到用户级 bin：可执行、sha256 一致、幂等')
  } finally {
    await rm(mcpHome, { recursive: true, force: true })
  }

  // 宿主装配期的**自愈**路径（ensureMaterialized）：装机后目录被清、换了新版本、
  // 目标被换成上游版、或本平台没随包，都在这里定死。
  const healHome = await mkdtemp(join(tmpdir(), 'gq-mcp-heal-'))
  const healBin = join(healHome, '.local', 'bin')
  const healOpts = { platform: 'linux', env: {}, home: healHome }
  try {
    const first = ensureMaterialized(healOpts)
    assert.equal(first.source, 'vendored', `有随包覆盖时应用随包二进制：${first.detail}`)
    assert.equal(first.copied, true, '第一次应真的拷过去')
    assert.equal(first.command, join(healBin, 'mcp-gitee-ent'), '落在用户级 bin')
    assert.equal(first.onPath, false, '环境里没有 PATH 时必须报"不在 PATH 上"')
    assert.ok(pathExists(first.command), '自愈后文件必须存在')

    const second = ensureMaterialized(healOpts)
    assert.equal(second.copied, false, '内容一致时必须复用，不能每次启动都拷 8 MiB')
    assert.equal(second.source, 'vendored')

    // XDG_BIN_HOME 优先（POSIX）：落点必须跟着它走
    const xdgBin = join(healHome, 'xdg-bin')
    const xdg = ensureMaterialized({ ...healOpts, env: { XDG_BIN_HOME: xdgBin } })
    assert.equal(xdg.command, join(xdgBin, 'mcp-gitee-ent'), 'XDG_BIN_HOME 必须赢过 ~/.local/bin')

    // 目标被换成别的东西（手工放了上游 npm 版）→ 覆盖回来，原文件让到 .bak
    await writeFile(first.command, 'not a real binary')
    const healed = ensureMaterialized(healOpts)
    assert.equal(healed.copied, true, '内容不一致时应重新落地（这就是"被换成上游版"的自愈）')
    assert.equal(createHash('sha256').update(readFileSync(healed.command)).digest('hex'),
      mcpManifest.platforms['linux-x64'].sha256, '自愈后的内容必须等于随包那份')
    // 这段模拟的是 linux 分支，但文件确实落在**本机**文件系统上：Windows 没有可执行位
    // （chmod 只动只读位，statSync 恒 0o666），所以这一条只能在 POSIX 宿主上验。
    if (process.platform !== 'win32') {
      assert.equal(statSync(healed.command).mode & 0o111, 0o111, '自愈后仍须可执行')
    }
    assert.equal(readFileSync(`${healed.command}.bak`, 'utf8'), 'not a real binary',
      '被替换掉的那份必须备份成 .bak，不能静默丢掉别人的二进制')



    // 本平台未随包（拿一个清单里没有的组合）→ 回落 PATH，而不是给个不存在的绝对路径
    const unsupported = ensureMaterialized({ platform: 'aix', home: healHome })
    assert.equal(unsupported.source, 'path', `未随包的平台应回落到 PATH：${unsupported.detail}`)
    assert.equal(unsupported.command, 'mcp-gitee-ent')
    assert.equal(unsupported.bundledForPlatform, false)

    // onPath：落点目录进了 PATH 就必须认出来（Windows 的加 PATH 提示靠这个判断）
    //
    // ⚠️ 这一段必须按**本机平台**模拟：onPath 是纯字符串比较，PATH 分隔符随模拟平台取
    // （linux 是 ':'），而 home 是真实临时目录 —— 在 Windows 上把 `C:\…` 拼进 ':' 分隔的
    // PATH，盘符自带的那一个冒号会把它切成两段，于是"落点就在 PATH 上"永远认不出来
    // （Linux 上碰巧对得上，所以这个夹具只在 Windows 上红）。
    const hostPlatform = process.platform
    const hostSep = hostPlatform === 'win32' ? ';' : ':'
    const onPathHit = ensureMaterialized({
      platform: hostPlatform,
      env: { HOME: healHome, USERPROFILE: healHome, PATH: `${join(healHome, 'other')}${hostSep}${healBin}` },
      home: healHome,
    })
    assert.equal(onPathHit.onPath, true, 'PATH 里有落点目录时必须认出来')

    // MCP_GITEE_ENT_BIN 优先级最高，且**不该**往任何地方写东西
    const overrideHome = await mkdtemp(join(tmpdir(), 'gq-mcp-ovr-'))
    try {
      const saved = process.env.MCP_GITEE_ENT_BIN
      process.env.MCP_GITEE_ENT_BIN = '/my/own/mcp-gitee-ent'
      try {
        const overridden = ensureMaterialized({
          platform: 'linux', home: overrideHome,
        })
        assert.equal(overridden.command, '/my/own/mcp-gitee-ent', '显式指定必须赢过随包那份')
        assert.equal(overridden.source, 'path')
        assert.equal(pathExists(join(overrideHome, '.local')), false,
          '被 MCP_GITEE_ENT_BIN 接管时不该再往用户 bin 里拷东西')
      } finally {
        if (saved === undefined) delete process.env.MCP_GITEE_ENT_BIN
        else process.env.MCP_GITEE_ENT_BIN = saved
      }
    } finally {
      await rm(overrideHome, { recursive: true, force: true })
    }
    console.log('  ✓ 宿主自愈：用户级 bin 落地 / 复用不重拷 / XDG_BIN_HOME 优先 / 替换留 .bak'
      + ' / 未随包回落 PATH / 环境变量优先')
  } finally {
    await rm(healHome, { recursive: true, force: true })
  }

  // 只读探测：/ping 必须报出 MCP 状态，且 GET 不能产生副作用
  const pingBody = (await call(handler, { method: 'GET', url: '/api/gitee-chat/ping' })).json
  assert.equal(pingBody.mcp.platform, platformKey(), '/ping 应报出本机平台')
  assert.equal(typeof pingBody.mcp.bundled, 'boolean', '/ping 应报出随包是否覆盖本平台')
  assert.equal(typeof pingBody.mcp.matchesManifest, 'boolean')
  console.log('  ✓ /ping 携带随包 MCP 状态（platform/bundled/installed/matchesManifest）')

  // ══ 13b. 知识库文档：四态判定 / 缓存布局 / MCP 委派════════════
  //
  // 这一节守的是两条纪律：
  //   ① 变更单位是「页」—— 四态判定必须是可断言的纯函数；
  //   ② MCP 是文档能力的**唯一实现** —— 插件侧不得出现任何文档端点。
  {
    // ── 四态判定（version × sha 两个正交信号）──────────────────────────
    const V1 = 'aaaaaaa1', V2 = 'bbbbbbb2', S1 = 'sha-1', S2 = 'sha-2'
    assert.equal(classifyPageState({ remoteVersion: V1, manifestVersion: V1, manifestSha: S1, localSha: S1 }), 'synced')
    assert.equal(classifyPageState({ remoteVersion: V2, manifestVersion: V1, manifestSha: S1, localSha: S1 }), 'remote-ahead')
    assert.equal(classifyPageState({ remoteVersion: V1, manifestVersion: V1, manifestSha: S1, localSha: S2 }), 'local-dirty')
    assert.equal(classifyPageState({ remoteVersion: V2, manifestVersion: V1, manifestSha: S1, localSha: S2 }), 'conflict')
    assert.equal(classifyPageState({ remoteVersion: V1, manifestVersion: V1, manifestSha: S1, localSha: undefined }), 'missing')
    assert.equal(classifyPageState({ remoteVersion: V1, manifestVersion: undefined, manifestSha: undefined, localSha: undefined }), 'not-cached')
    assert.equal(classifyPageState({ remoteVersion: '', manifestVersion: V1, manifestSha: S1, localSha: S1 }), 'not-cached',
      '远程没给版本时不得假装能判定')
    console.log('  ✓ 文档四态：一致 / 远程已更新 / 本地已改 / 冲突 / 本地缺失 / 未缓存（version×sha 正交）')

    // ── 文档整体状态 = 最严重的那个（冲突不会被多数同步页淹没）──────────
    assert.equal(rollupDocState(['synced', 'synced', 'remote-ahead']), 'remote-ahead')
    assert.equal(rollupDocState(['synced', 'conflict', 'synced']), 'conflict')
    assert.equal(rollupDocState(['synced', 'local-dirty', 'conflict']), 'conflict')
    assert.equal(rollupDocState([]), 'not-cached')
    console.log('  ✓ 文档整体状态取最严重者（冲突不被淹没）')

    // ── 只拉该拉的：synced / local-dirty / conflict 一个都不拉 ───────────
    assert.deepEqual(planPull([
      { pageId: 1, state: 'synced' },
      { pageId: 2, state: 'remote-ahead' },
      { pageId: 3, state: 'local-dirty' },
      { pageId: 4, state: 'conflict' },
      { pageId: 5, state: 'missing' },
    ]), [2, 5], '只有远程已更新与本地缺失才该拉；本地已改/冲突永不自动覆盖')
    console.log('  ✓ 按需拉取计划：本地已改与冲突的页**永不自动拉取**')

    // ── 缓存布局：单企业扁平、多企业嵌套 ────────────────────────────────
    //
    // 缓存根用 join() 造（不写死 '/root/docs'）：enterpriseLayer 内部按平台拼路径，
    // Windows 上 join('/root/docs','e200') 是 `\root\docs\e200`，拿 POSIX 字面量断言
    // 会在 Windows 开发机上恒红（Linux 上碰巧一致）。
    const docsRoot = join(tmpdir(), 'gq-docs-fixture')
    const flat = enterpriseLayer(docsRoot, 100, { schema: 1, enterprises: [100], documents: { '1': { enterpriseId: 100, programId: 1, name: 'a' } } })
    assert.equal(flat, docsRoot, '只有一家企业时不额外嵌套（保持直觉路径）')
    const nested = enterpriseLayer(docsRoot, 200, { schema: 1, enterprises: [100, 200], documents: { '1': { enterpriseId: 100, programId: 1, name: 'a' } } })
    assert.equal(nested, join(docsRoot, 'e200'), '缓存里已有别家文档时必须嵌套，避免同名撞车')
    assert.equal(safeSlug('示例产品 设计文档/v2'), '示例产品-设计文档-v2')
    assert.equal(pageRelPath({ name: '01-总体设计', type: 'page' }), '01-总体设计.md')
    assert.equal(pageRelPath({ name: '01-接口', type: 'folder' }), '01-接口')
    console.log('  ✓ 缓存布局：单企业扁平 / 多企业嵌套 / slug 与页路径转义')

    // ── 文档配置：默认根 + `~` 展开（不展开会在 cwd 下建一个名叫 `~` 的目录）──
    assert.match(resolveConfig().docs.root, /gitee[\\/]docs$/, '默认缓存根 = $DSH_HOME/gitee/docs')
    assert.equal(resolveConfig().docs.mcpToolPrefix, 'mcp__gitee_ent__')
    assert.ok(!resolveConfig({ docs: { root: '~/x/docs' } }).docs.root.includes('~'),
      '`~` 必须展开成主目录，否则会在工作目录下建一个名为 `~` 的文件夹')
    assert.equal(resolveConfig({ docs: { root: '/abs/docs' } }).docs.root, '/abs/docs')
    console.log('  ✓ 文档配置：默认根 $DSH_HOME/gitee/docs · 前缀可配 · `~` 会展开')

    // ── MCP 返回解包：**桥接层的真实信封形状**优先（一次真实事故的守卫）────
    //
    // 🔴 DSH 的 MCP 桥接返回的是 `value = { content: [ {type:'text', text:'<JSON>'} ] }`，
    // **不是**工具返回的 JSON 本身。早先这里按"value 存在就用它"处理，于是
    // `record.data` / `record.documents` / `record.total_count` 全部 undefined，
    // 界面永远显示"顶层 0 项"**且不报错** —— 知识库列表为空的真正原因。
    // 下面第一条就是这个形状：**它是回归守卫，别删**。
    const bridgeShape = { isError: false, value: { content: [{ type: 'text', text: '{"total_count":4,"data":[{"id":1,"name":"x"}]}' }] } }
    assert.deepEqual(unwrapToolResult('t', bridgeShape), { total_count: 4, data: [{ id: 1, name: 'x' }] },
      '必须拆开桥接信封 value.content，取出里面的 JSON —— 否则列表恒为空且不报错')
    assert.deepEqual(
      unwrapToolResult('t', { isError: false, value: { content: [{ type: 'text', text: '{}' }], structuredContent: { total_count: 7 } } }),
      { total_count: 7 },
      '有 structuredContent 时优先用它（MCP 声明了 output schema 的情况）')
    assert.deepEqual(unwrapToolResult('t', { isError: false, value: { documents: [] } }), { documents: [] },
      'value 本身就是载荷时（将来的桥接）也要能直接用')
    assert.deepEqual(unwrapToolResult('t', { isError: false, content: [{ type: 'text', text: '{"total_count":0}' }] }), { total_count: 0 },
      '退回顶层 content 文本块时要能按 JSON 解析')
    assert.throws(() => unwrapToolResult('t', { isError: true, content: [{ type: 'text', text: '权限不足' }] }), (e) => e instanceof DocError && e.code === 'tool-failed')
    assert.throws(() => unwrapToolResult('t', { isError: false, content: [{ type: 'text', text: '不是 JSON' }] }), (e) => e instanceof DocError && e.code === 'bad-response')
    console.log('  ✓ MCP 解包：桥接信封 / structuredContent / value 直给 / content / 报错 / 非 JSON 六条路都有明确结论')

    // ── 全链路（客户端形状 → 委派 → 解包 → 节点行）────────────────────────
    //
    // 上面那条只测了 unwrap；这里测**整条 host 链路**：用假的 MCP 桥接返回
    // 真实抓到的报文，走 createMcpDocs → createDocService，看最终节点行对不对。
    // 这就是"顶层 0 项"那次事故的端到端回归守卫 —— 单测 unwrap 也能过，
    // 但链路里任何一环（参数名、字段名、映射）错了都会被它抓住。
    {
      const topPayload = JSON.stringify({
        total_count: 2,
        data: [
          { id: 9100001, name: '[PRD] 参数表', parent_id: 0, file_type: 'DocDirectory', file_path: '项目知识库', file_id: 0, updated_at: '2026-08-26T08:33:40+08:00' },
          { id: 9100002, name: '设备参数文档.md', parent_id: 9100001, file_type: 'AttachFile', file_path: '项目知识库/x/设备参数文档.md', file_id: 9200001, updated_at: '2026-08-26T08:34:15+08:00' },
        ],
      })
      const seen = []
      const fakeTools = {
        async execute(exec) {
          seen.push({ name: exec.name, args: exec.arguments, hasAgent: exec.agent !== undefined })
          return { isError: false, value: { content: [{ type: 'text', text: topPayload }] } }
        },
      }
      const docsClient = createMcpDocs({
        agentOf: () => ({ id: 'sess-smoke' }),
        tools: () => fakeTools,
        toolPrefix: 'mcp__gitee_ent__',
        enterpriseId: 11111111,
      })
      const svc = createDocService({ docs: docsClient, cacheRoot: join(sandboxHome, 'gitee', 'docs') })
      const tree = await svc.listNodes('sess-smoke', 9500001, 0)
      assert.equal(seen.length, 1)
      assert.equal(seen[0].name, 'mcp__gitee_ent__list_doc_nodes', '列表必须走 list_doc_nodes（不是 tile）')
      assert.equal(seen[0].args.enterprise_id, 11111111)
      assert.equal(seen[0].args.parent_id, 0, 'parent_id 必须传 0（该范围顶层）')
      assert.equal(seen[0].args.program_id, 9500001, 'program_id 必须透传')
      assert.equal(seen[0].hasAgent, true, '必须带 agent 作用域，否则 MCP 工具不可见')
      assert.equal(tree.total, 2, '解包后必须是 2 个节点（曾是 0 —— 信封没拆）')
      const [dir, file] = tree.roots[0].nodes
      assert.equal(dir.directory, true)
      assert.equal(dir.readable, true, '文件夹可展开')
      assert.equal(file.fileId, 9200001, 'file_id 必须带出来（读内容要用它，不是节点 id）')
      assert.equal(file.ext, 'md', '扩展名从文件名推出')
      assert.equal(file.directory, false)
      console.log('  ✓ 全链路：client → 委派(list_doc_nodes+agent) → 解包 → 节点行（fileId/ext/可读性都对）')
    }

    // ── 附件落盘：目录必须先存在（第二次真实事故的守卫）────────────────────
    //
    // 🔴 `ResolveWritableDirectory` 对 output_directory 做 `EvalSymlinks` + `Stat`：
    // **目录不存在就直接拒绝**（报 "lstat /home/…/.dsh/gitee: no such file or directory"），
    // `workspace` 参数同理。插件原先没建缓存目录 → 点附件必然报 param_error。
    // 这条断言从"缓存根还不存在"起步，确认编排层自己把它建出来。
    {
      const freshRoot = join(sandboxHome, 'attach-fresh', 'gitee', 'docs')
      assert.equal(pathExists(freshRoot), false, '起点必须是"缓存根还不存在"')
      let sawDirExists = false
      const svc = createDocService({
        docs: { enterpriseId: 11111111, async listNodes() { return [] }, async downloadAttachFile() { throw new Error('不该走到这里') } },
        cacheRoot: freshRoot,
        readAttachmentContent: async (input) => {
          // 模拟 MCP 侧的校验：目录不存在就报 param_error。
          sawDirExists = pathExists(input.cacheDir)
          return { savedPath: join(input.cacheDir, 'x.md'), bytes: 12, contentType: 'text/plain', ext: 'md', content: '# hi', truncated: false }
        },
      })
      const out = await svc.attachment('sess-smoke', { nodeId: 9100003, fileId: 9200002, name: '设备参数文档-矫正版.md', programId: 9500001 })
      assert.equal(sawDirExists, true, '调 MCP 之前缓存目录必须已经建好，否则会 param_error')
      assert.ok(out.cacheDir.includes(join('pj-9500001', '9100003-设备参数文档-矫正版')),
        `目录名应去掉扩展名且带节点 id，实际 ${out.cacheDir}`)
      console.log('  ✓ 附件落盘：编排层先建缓存目录（否则 MCP 的 output_directory 校验必拒）')
    }

    // ── A1：缓存的变更感知（附件不可变，只问"远端那份还是不是我下的那份"）──
    //
    // 这是"按需缓存"真正生效的地方：命中就**一次 MCP 都不发**。
    // 上一版每次点附件都无条件重下（`overwrite: true`），缓存等于白存。
    {
      // 纯函数真值表：附件只有四态（没有 local-dirty / conflict —— 我们从不改本地附件）
      const m = { schema: 1, enterpriseId: 11111111, nodeId: 1, fileId: 9, name: 'a.md', updatedAt: 'T1', size: 100, bytes: 100, fileName: 'a.md', fetchedAt: 'F' }
      assert.equal(classifyAttachState(undefined, false, { updatedAt: 'T1', size: 100 }), 'not-cached')
      assert.equal(classifyAttachState(m, false, { updatedAt: 'T1', size: 100 }), 'missing', '清单在但文件没了')
      assert.equal(classifyAttachState(m, true, { updatedAt: 'T1', size: 100 }), 'synced')
      assert.equal(classifyAttachState(m, true, { updatedAt: 'T2', size: 100 }), 'remote-ahead', 'updated_at 变 → 远端已更新')
      assert.equal(classifyAttachState(m, true, { updatedAt: 'T1', size: 999 }), 'remote-ahead', 'size 变 → 远端已更新')
      // 远端事实拿不到时**不能**判成"变了"，否则会永远重下
      assert.equal(classifyAttachState(m, true, { updatedAt: '', size: 0 }), 'synced',
        'updatedAt/size 缺失时必须按"一致"处理，否则每次点都白下一遍')
      assert.equal(classifyAttachState(m, true, { updatedAt: 'T2', size: 0 }), 'remote-ahead',
        '但只缺 size 时，updatedAt 仍然算数')
      console.log('  ✓ A1 真值表：not-cached / missing / synced / remote-ahead（附件无 local-dirty / conflict）')

      // 全链路：第二次点同一个附件**不得**再调 MCP
      const root2 = join(sandboxHome, 'attach-a1', 'gitee', 'docs')
      let downloads = 0
      const svc = createDocService({
        docs: {
          enterpriseId: 11111111,
          async listNodes() { return [] },
          async downloadAttachFile() { throw new Error('不该走到这里') },
        },
        cacheRoot: root2,
        readAttachmentContent: async (input) => {
          downloads += 1
          // 模拟 MCP 真的把文件写进 output_directory
          await writeFile(join(input.cacheDir, 'p.md'), '# 正文第一版\n', 'utf8')
          return {
            savedPath: join(input.cacheDir, 'p.md'), bytes: 18,
            contentType: 'text/plain', ext: 'md', content: '# 正文第一版\n', truncated: false,
          }
        },
      })
      const node = { nodeId: 7001, fileId: 8001, name: 'p.md', programId: 9500001 }
      const first = await svc.attachment('sess-smoke', { ...node, updatedAt: 'T1', size: 18 })
      assert.equal(downloads, 1, '第一次必须下载')
      assert.equal(first.fromCache, false)
      assert.equal(first.state, 'synced')

      const second = await svc.attachment('sess-smoke', { ...node, updatedAt: 'T1', size: 18 })
      assert.equal(downloads, 1, '🔴 第二次**不得**再调 MCP —— 命中缓存就该直接读本地')
      assert.equal(second.fromCache, true, '必须如实上报"这次读的是本地缓存"')
      assert.equal(second.state, 'synced')
      assert.match(String(second.content), /正文第一版/)

      const ahead = await svc.attachment('sess-smoke', { ...node, updatedAt: 'T2', size: 18 })
      assert.equal(downloads, 1, '远端变了也**不自动覆盖** —— 只报告')
      assert.equal(ahead.state, 'remote-ahead')
      assert.match(String(ahead.content), /正文第一版/, '远端已更新时给的仍是本地那份')

      const forced = await svc.attachment('sess-smoke', { ...node, updatedAt: 'T2', size: 18, refresh: true })
      assert.equal(downloads, 2, 'refresh=true 才真的重下')
      assert.equal(forced.state, 'synced')

      // 列表上就要能看出缓存状态（读 JSON + 一次 stat，不发请求）
      assert.ok(readAttachManifest(join(root2, 'pj-9500001', '7001-p')).nodeId === 7001,
        '落盘后必须留下 .gitee-attach.json，否则下次没有比对依据')
      console.log('  ✓ A1 全链路：第二次点同一个附件不再调 MCP · 远端变更只报告不覆盖 · refresh 才重下')
    }

    // ── 路由：入参校验与会话作用域的失败必须可行动 ──────────────────────
    const nodesNoSession = await call(handler, { method: 'GET', url: '/api/gitee-chat/doc/nodes' })
    assert.equal(nodesNoSession.status, 400)
    assert.match(nodesNoSession.json.message, /sessionId/)
    assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/doc/nodes?sessionId=s&parentId=-1' })).status, 400)
    assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/doc/nodes?sessionId=s&program=0' })).status, 400)
    console.log('  ✓ 知识库节点路由入参校验：缺 sessionId / 负 parentId / 非法 program → 400')

    const docsNoSession = await call(handler, { method: 'GET', url: '/api/gitee-chat/docs' })
    assert.equal(docsNoSession.status, 400)
    assert.match(docsNoSession.json.message, /sessionId/)
    const docsBadProgram = await call(handler, { method: 'GET', url: '/api/gitee-chat/docs?sessionId=s&program=0' })
    assert.equal(docsBadProgram.status, 400)
    const searchNoQuery = await call(handler, { method: 'GET', url: '/api/gitee-chat/docs/search?sessionId=s' })
    assert.equal(searchNoQuery.status, 400)
    assert.match(searchNoQuery.json.message, /q=/)
    assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/doc?sessionId=s' })).status, 400)
    assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/doc/page?sessionId=s&documentId=1' })).status, 400)
    assert.equal((await call(handler, { method: 'POST', url: '/api/gitee-chat/doc/sync', body: JSON.stringify({ sessionId: 's' }) })).status, 400)
    console.log('  ✓ 文档路由入参校验：缺 sessionId / 非法 program / 缺关键词 / 缺 id → 400')

    // 冒烟用的假 ctx 没有 tools 注册表 —— 委派层必须**明说**原因，不能静默空白
    const noTools = await call(handler, { method: 'GET', url: '/api/gitee-chat/docs?sessionId=sess-gitee' })
    assert.equal(noTools.status, 409, '没有活 agent 时先报会话未加载（比"没有 tools"更贴近使用者的处境）')
    assert.match(noTools.json.message, /会话|agent/)
    const nodesNoAgent = await call(handler, { method: 'GET', url: '/api/gitee-chat/doc/nodes?sessionId=sess-gitee' })
    assert.equal(nodesNoAgent.status, 409, '节点树这条路也必须给同样可行动的失败原因')
    console.log('  ✓ 文档委派失败给可行动原因（会话未加载 / 无 tools 注册表），不静默空白')

    // ── 回归守卫：知识库列表**必须**走节点树，不能再用 WikiInfo 的 tile ──
    //
    // 上一版把列表绑到 `list_enterprise_documents`（`/doc_nodes/tile`，硬编码
    // `file_type=WikiInfo`），而本企业一篇 WikiInfo 都没有 → 列表永远空白，
    // 而且**不报错**（最难查的一类）。这条断言把"用错数据源"钉死：
    // 节点树这条路必须存在且可路由；`/docs`（WikiInfo）保留但界面不再依赖它。
    assert.equal(typeof resolveConfig().docs, 'object')
    const srcMcpDocs = readFileSync(join(root, 'src', 'host', 'mcpDocs.ts'), 'utf8')
    assert.match(srcMcpDocs, /list_doc_nodes/, '节点树必须经 list_doc_nodes 取数')
    const srcService = readFileSync(join(root, 'src', 'host', 'docService.ts'), 'utf8')
    assert.match(srcService, /async listNodes\(/, '编排层必须提供节点树入口')
    assert.match(srcService, /readAttachmentContent/, '附件内容读取必须是显式的可选依赖（在不在=能力开关）')
    const srcPanel = readFileSync(join(root, 'src', 'client', 'DocPanel.tsx'), 'utf8')
    assert.match(srcPanel, /fetchDocNodes/, '面板必须走节点树接口')
    assert.match(srcPanel, /内容待接入/, '内容读不了时必须诚实标注，不能给点了没反应的入口')
    console.log('  ✓ 回归守卫：知识库列表走节点树（list_doc_nodes），且不可读时诚实标注')

    // ══ J 层：仓库 + 仓库 WIKI ═══════════════════════════════════════════
    //
    // 这一层有两条**方向相反**的纪律，都要钉住：
    //   1. 仓库**列表**仍然只走 MCP（插件不拼 `/projects` 端点）；
    //   2. WIKI **正文**是唯一例外 —— Gitee 没有列仓库 WIKI 的 HTTP 接口
    //      （实测企业 API 全 404、开放 API `/repos/{owner}/{repo}/wikis` 是 405），
    //      只有 git 形态 `{path_with_namespace}.wiki.git`。例外只能出现在
    //      `host/wikiCache.ts` 这一个文件里，别的取数口出现 git 就是越界。

    // 1) 委派：仓库列表必须经 MCP，且把两个口径如实翻译成 Gitee 的参数
    {
      const seen = []
      const repoClient = createMcpDocs({
        agentOf: () => ({ marker: 'agent' }),
        tools: () => ({
          async execute(exec) {
            seen.push(exec)
            return {
              isError: false,
              value: {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    total_count: 2,
                    data: [
                      // 真实抓到的形状：**name 与 path 不一样**（用 name 拼地址会 404）
                      { id: 9400001, name: 'demo-docs', path: 'docs', path_with_namespace: 'example-org/docs', public: 0, wiki_enabled_with_content: true },
                      { id: 9400002, name: 'demo-base', path: 'demo-base', path_with_namespace: 'example-org/demo-base', public: 0, wiki_enabled_with_content: false },
                    ],
                  }),
                }],
              },
            }
          },
        }),
        toolPrefix: 'mcp__gitee_ent__',
        enterpriseId: 11111111,
      })
      const scoped = await repoClient.listRepositories('sess-gitee', { programId: 9500003 })
      assert.equal(seen[0].name, 'mcp__gitee_ent__list_enterprise_repositories', '仓库列表必须走 MCP 工具')
      assert.equal(seen[0].arguments.program_id, 9500003, '选中项目时必须传 program_id 过滤')
      assert.equal(scoped.length, 2, '解包后必须是 2 个仓库（信封没拆的话是 0）')
      assert.equal(scoped[0].path, 'docs', 'path 必须原样带出来（拼 wiki 地址要用它）')
      assert.equal(scoped[0].name, 'demo-docs', 'name 与 path 不同，不能互相顶替')
      assert.equal(scoped[0].wiki, true, 'wiki_enabled_with_content 必须透传（少了它就不敢去克隆）')
      assert.equal(scoped[1].wiki, false, 'false 必须还是 false，不能"默认可用"')

      await repoClient.listRepositories('sess-gitee', { scope: 'internal-open' })
      assert.equal(seen[1].arguments.scope, 'internal-open', '未选项目时必须传 scope=internal-open（企业内部开源）')
      assert.equal(seen[1].arguments.program_id, undefined, '未选项目时不得同时传 program_id')
      console.log('  ✓ J 层委派：仓库列表经 MCP · 两种口径参数正确 · wiki 标记透传（name ≠ path）')
    }

    // 2) 编排：口径决定 mode 与提示，且仓库行补上可见性
    {
      const fakeDocs = {
        enterpriseId: 11111111,
        async listRepositories(_s, options) {
          assert.ok(options.programId !== undefined || options.scope !== undefined, '两种口径必须二选一')
          return [{
            repoId: 9400003, name: 'demo-pad', path: 'demo-pad', pathWithNamespace: 'example-org/demo-pad',
            description: '', public: 2, defaultBranch: 'master', membersCount: 1, lastPushAt: '', repoSize: 0,
            outsourced: false, statusName: '开始', wiki: false,
          }]
        },
      }
      const fakeWiki = { cacheRoot: '/tmp/x', async workspaceLink() { return null } }
      const repoService = createRepoService({ docs: fakeDocs, wiki: fakeWiki, cwdOf: () => '' })
      const withProject = await repoService.repos('sess-gitee', 9500001, '示例项目甲')
      assert.equal(withProject.mode, 'project')
      assert.match(withProject.notice, /项目/)
      const openOnly = await repoService.repos('sess-gitee', null)
      assert.equal(openOnly.mode, 'internal-open')
      assert.match(openOnly.notice, /企业内部开源/, '未选项目时的口径必须写在提示里，否则没人知道为什么只有几个仓库')
      assert.equal(openOnly.repos[0].visibility, '企业内部开源', 'public=2 必须被翻译成人话')
      console.log('  ✓ J 层编排：两种口径 → mode/notice/可见性都对（public=2 → 企业内部开源）')
    }

    // 3) 路径换算与防穿越（纯函数 + 文件系统，不需要 git、不需要网络）
    {
      assert.equal(safeRepoSegment('example-org/docs'), 'example-org__docs', '斜杠不能进单个目录名')
      assert.match(toWorkspacePath('/cwd/.dsh/gitee-docs', '/root/docs', '/root/docs/pj-1/a.md'), /[\\/]\.dsh[\\/]gitee-docs[\\/]pj-1[\\/]a\.md$/,
        '工作区路径按平台拼（Windows 是反斜杠），断言得两种分隔符都认')
      assert.equal(toWorkspacePath('/cwd/.dsh/gitee-docs', '/root/docs', '/etc/passwd'), null,
        '缓存根之外的路径不得被换算成工作区路径（否则等于给越权开了口子）')

      const wikiRoot = await mkdtemp(join(tmpdir(), 'gq-wiki-'))
      const clone = join(wikiRoot, 'example-org__docs')
      await mkdir(join(clone, 'sub'), { recursive: true })
      await writeFile(join(clone, 'Home.md'), '# 首页\n')
      await writeFile(join(clone, 'sub', '接口.md'), '# 接口\n')
      const wiki = createWikiCache({ cacheRoot: wikiRoot, token: () => 'x' })
      const listed = wiki.files(clone).map((f) => f.path).sort()
      assert.deepEqual(listed, ['Home.md', 'sub/接口.md'], '必须递归列出 WIKI 里的文件')
      assert.equal(wiki.read(clone, 'Home.md')?.title, 'Home', '标题 = 去掉扩展名的文件名')
      assert.equal(wiki.read(clone, '../outside.md'), undefined, '`..` 必须被挡在克隆目录之外')
      assert.equal(wiki.read(clone, 'nope.md'), undefined)

      // 工作区软链接：必须建出来、指向缓存根、且**幂等**
      const cwd = join(wikiRoot, 'ws')
      await mkdir(cwd, { recursive: true })
      const link1 = await wiki.workspaceLink(cwd)
      assert.equal(link1, join(cwd, '.dsh', 'gitee-docs'))
      assert.equal(readlinkSync(link1), wikiRoot, '软链接必须指向缓存根（侧边栏只读得到工作区内的路径）')
      assert.equal(await wiki.workspaceLink(cwd), link1, '第二次调用必须幂等')

      // 已经存在但不是软链接时**绝不覆盖**（可能是用户自己的东西）
      const clash = join(wikiRoot, 'ws2')
      await mkdir(join(clash, '.dsh', 'gitee-docs'), { recursive: true })
      const wiki2 = createWikiCache({ cacheRoot: wikiRoot, token: () => 'x' })
      assert.equal(await wiki2.workspaceLink(clash), null, '目标已存在且不是软链接时必须放弃，不能覆盖')
      console.log('  ✓ J 层 WIKI：递归列文件 · 标题/防穿越 · 工作区软链接（幂等 + 不覆盖已有目录）')
    }

    // 4) 越界守卫：git 只允许出现在 wikiCache 里
    for (const rel of ['src/host/mcpDocs.ts', 'src/host/docService.ts', 'src/host/repoService.ts']) {
      const src = readFileSync(join(root, rel), 'utf8')
      assert.ok(!/from 'node:child_process'/.test(src),
        `${rel} 不得自己跑子进程取数 —— 文档/仓库取数只走 MCP（wikiCache.ts 是唯一例外）`)
    }
    assert.match(readFileSync(join(root, 'src', 'host', 'wikiCache.ts'), 'utf8'), /\.wiki\.git/,
      '仓库 WIKI 的取数形态必须写在 wikiCache.ts 里（这是唯一的例外点）')
    console.log('  ✓ J 层边界：子进程取数只出现在 wikiCache.ts，其余取数口仍然只走 MCP')

    // 5) 预览分工守卫：本插件只内联预览 .md，其它交给侧边栏
    for (const rel of ['src/client/DocPanel.tsx', 'src/client/RepoPanel.tsx']) {
      const src = readFileSync(join(root, rel), 'utf8')
      const decl = src.match(/INLINE_PREVIEW_EXT = new Set\(\[([^\]]*)\]\)/)
      assert.ok(decl, `${rel} 必须有 INLINE_PREVIEW_EXT（内联预览白名单）`)
      const exts = decl[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter((s) => s !== '')
      assert.ok(exts.length > 0 && exts.every((e) => e === 'md' || e === 'markdown'),
        `${rel} 只允许内联预览 .md/.markdown —— 其余类型交给侧边栏，别在这里长预览器（实际 ${exts.join(',')}）`)
      // 🔴 **有侧边栏就必须交给它**，不能因为"没拿到工作区路径"就悄悄改成自己渲染。
      // 这是需求原话（"如果有侧边栏就以侧边栏打开"）的直接编码 ——
      // 上一版把 `workspacePath !== null` 当成前置条件，于是 cwd 解析失败时
      // 界面看起来"正常"（渲染了 .md），实际**根本没调侧边栏** —— 最难查的那类。
      assert.ok(!/workspacePath !== null\s*&&\s*sidebarOpenFile/.test(src),
        `${rel} 不得把"拿到工作区路径"当作调用侧边栏的前置条件（有侧边栏就该调）`)
      assert.match(src, /sidebarOpenFile\(sessionId, target,/,
        `${rel} 必须无条件尝试 sidebarOpenFile（路径优先工作区软链接，拿不到再退回真实路径）`)
      assert.match(src, /sidebarAvailable\(\)/, `${rel} 未交付时必须说明是"没装"还是"调了但没成"`)
    }
    const sidebarSrc = readFileSync(join(root, 'src', 'client', 'sidebar.ts'), 'utf8')
    assert.match(sidebarSrc, /context\?\.get\?\.\('betterSidebar'\)/,
      '侧边栏服务必须**每次现取**：客户端插件各自加载，不保证谁先注册')
    assert.ok(!/let service: BetterSidebarLike/.test(sidebarSrc),
      '不得在 apply 时把侧边栏服务缓存下来 —— 先加载就会永远认为"没有侧边栏"')
    assert.match(sidebarSrc, /includes\('openFile'\)/,
      '侧边栏能力必须用 features 能力位判定（老版本没有 openFile 时要优雅降级）')
    console.log('  ✓ 预览分工：只内联 .md · 侧边栏每次现取（抗加载顺序）· 有侧边栏就一律交给它')

    // 5b) 🔒 A7：WikiInfo 那组路由是**有意休眠**，不是没做完
    //
    // 用户 2026-09-15 拍板"暂时不做，等研究明白"。它服务的是本企业**一篇都没有**的
    // WikiInfo 形态。这条守卫有两个方向：
    //   · 别被当成死代码顺手清掉（那 5 条路由必须还在）；
    //   · 也别被当成没做完又重做一遍（"有意休眠"那句话必须还写在那儿）。
    // 同时确认 AI 那条路**没有**跟着被冻掉：WikiInfo 的 MCP 工具仍在三档里。
    {
      const routeSrc = readFileSync(join(root, 'src', 'host', 'routes.ts'), 'utf8')
      for (const r of ["'/docs'", "'/docs/search'", "'/doc'", "'/doc/page'", "'/doc/sync'"]) {
        assert.ok(routeSrc.includes(`route === ${r}`), `WikiInfo 休眠路由 ${r} 不应被删除（A7 决策：冻结而非清理）`)
      }
      assert.match(routeSrc, /A7 决策/, '必须写明这是有意休眠及理由，否则下一个人会当成漏做')
      const apiSrc = readFileSync(join(root, 'src', 'client', 'api.ts'), 'utf8')
      for (const f of ['fetchDocs', 'searchDocs', 'fetchDoc', 'fetchDocPage', 'postDocSync']) {
        assert.ok(apiSrc.includes(`function ${f}`), `休眠的客户端函数 ${f} 不应被删除`)
      }
      // AI 那条路是活的：WikiInfo 工具仍在三档里（冻结的只是插件 UI 接线）
      for (const t2 of ['list_enterprise_documents', 'list_enterprise_document_pages', 'get_enterprise_document_page']) {
        assert.ok(TIERS.manager.tools.includes(t2), `${t2} 必须仍在管理者档 —— 冻的是 UI 接线，不是能力`)
        assert.ok(TIERS.exec.tools.includes(t2), `${t2} 必须仍在执行档`)
      }
      console.log('  ✓ A7 休眠路径：5 条路由 + 5 个函数仍在且写明理由；AI 侧 WikiInfo 工具未受影响')
    }

    // 5c) A2：缓存管理（附件与仓库 WIKI **分开**统计；清缓存不碰 Gitee）
    {
      const root3 = join(sandboxHome, 'cache-stats')
      await mkdir(join(root3, 'pj-1001', '7001-a'), { recursive: true })
      await mkdir(join(root3, '_common', '7002-b'), { recursive: true })
      await mkdir(join(root3, 'wiki', 'ns__docs', '.git'), { recursive: true })
      await writeFile(join(root3, 'pj-1001', '7001-a', 'a.md'), 'x'.repeat(100))
      await writeFile(join(root3, '_common', '7002-b', 'b.md'), 'y'.repeat(50))
      await writeFile(join(root3, 'wiki', 'ns__docs', 'Home.md'), 'z'.repeat(30))
      // `.git` 是克隆的实现细节，不该算进"WIKI 有多少页"
      await writeFile(join(root3, 'wiki', 'ns__docs', '.git', 'HEAD'), 'ref: refs/heads/master')
      const st = cacheStats(root3)
      assert.equal(st.attachments.count, 2, `附件侧应数到 2 个文件，实际 ${st.attachments.count}`)
      assert.equal(st.attachments.bytes, 150, '附件字节数')
      assert.equal(st.wikis.count, 1, 'WIKI 侧只数内容文件，.git 里的不算')
      assert.equal(st.wikis.bytes, 30)
      assert.equal(st.truncated, false)
      assert.equal(humanBytes(150), '150 B')
      assert.equal(humanBytes(2048), '2.0 KB')
      console.log('  ✓ A2 用量统计：附件与仓库 WIKI 分开报 · .git 不计入 WIKI 页数')
    }

    // 6) 路由入参校验（J 层）
    assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/doc/repos' })).status, 400)
    assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/doc/repos?sessionId=s&program=0' })).status, 400)
    assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/doc/wiki?sessionId=s' })).status, 400)
    assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/doc/wiki?sessionId=s&repoId=1' })).status, 400)
    assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/doc/wiki/page?sessionId=s&repoId=1&repoPath=a/b' })).status, 400,
      '缺 path 必须 400')
    console.log('  ✓ J 层路由入参校验：缺 sessionId / 非法 program / 缺 repoPath / 缺 path → 400')

    // 7) 缓存管理路由（A2）
    assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/doc/cache' })).status, 400)
    assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/doc/cache?sessionId=s&program=0' })).status, 400)
    const forgetNoTarget = await call(handler, {
      method: 'POST', url: '/api/gitee-chat/doc/cache/forget', body: JSON.stringify({ sessionId: 's' }),
    })
    assert.equal(forgetNoTarget.status, 400)
    assert.match(forgetNoTarget.json.message, /target/)
    const forgetNoNode = await call(handler, {
      method: 'POST', url: '/api/gitee-chat/doc/cache/forget', body: JSON.stringify({ sessionId: 's', target: 'attachment' }),
    })
    assert.equal(forgetNoNode.status, 400)
    assert.match(forgetNoNode.json.message, /nodeId/)
    // 清一个根本没缓存过的节点：必须回 200 + removed:false，**不是错误** ——
    // 缓存管理里"本来就没有"是正常结果，报 4xx 会让界面把它当成故障。
    const forgetNothing = await call(handler, {
      method: 'POST', url: '/api/gitee-chat/doc/cache/forget',
      body: JSON.stringify({ sessionId: 's', target: 'attachment', nodeId: 999999, name: 'nope.md', programId: 9500001 }),
    })
    assert.equal(forgetNothing.status, 200)
    assert.equal(forgetNothing.json.removed, false, '本来就没缓存 → removed:false，不是错误')
    console.log('  ✓ A2 路由：入参校验 400 · "本来就没缓存"回 200/removed:false（不当故障）')

    // ── P1′：附件内容读取（本 fork 独有的 download_attach_file）──────────
    //
    // 这是"看得见文件名但读不出内容"的唯一解法：`list_doc_nodes` 只给文件名，
    // 正文/二进制必须靠这个工具；而它**必须在三档的读取集里**，否则门禁会把它拦掉。
    const manifestNow = JSON.parse(readFileSync(join(root, 'vendor', 'mcp-gitee-ent', 'manifest.json'), 'utf8'))
    assert.ok(manifestNow.tools.includes('download_attach_file'),
      '随包清单必须声明 download_attach_file（否则插件不会启用附件读取）')
    assert.ok(manifestNow.forkOnlyTools.includes('download_attach_file'),
      '它必须是 fork 独有的工具之一（上游没有）')
    const gqSrc = readFileSync(join(root, 'scripts', 'gitee', 'gq.mjs'), 'utf8')
    assert.match(gqSrc, /'download_attach_file'/, 'TIERS 的读取集必须包含它，否则 --enabled-toolsets 会把它过滤掉')
    console.log(`  ✓ 附件读取工具已随包（二进制 ${manifestNow.toolCount} 个工具 · fork 独有 ${manifestNow.forkOnlyTools.length} 个）`)

    // 附件读取路由的入参校验
    assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/doc/attachment' })).status, 400)
    assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/doc/attachment?sessionId=s&nodeId=1' })).status, 400)
    assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/doc/attachment?sessionId=s&nodeId=0&fileId=1' })).status, 400)
    const attachNoAgent = await call(handler, { method: 'GET', url: '/api/gitee-chat/doc/attachment?sessionId=sess-gitee&nodeId=1&fileId=2' })
    assert.equal(attachNoAgent.status, 409, '没有活 agent 时也要给可行动原因')
    console.log('  ✓ 附件读取路由：缺参 / 非法 id → 400；会话未加载 → 409 可行动')

    // ── 文档写：走唯一写入口，且乐观锁参数一个都不能少 ──────────────────
    const docWriter = createIssueWriter({ runner: stubRunner, enabled: true })
    await assert.rejects(() => docWriter.write({ op: 'doc-page-update', ident: '', documentId: 1, pageId: 2, content: 'x', commitMessage: 'm' }),
      /expectedVersion/, '缺 expectedVersion 必须在到达 MCP 之前被拒')
    await assert.rejects(() => docWriter.write({ op: 'doc-page-update', ident: '', documentId: 1, pageId: 2, content: 'x', expectedVersion: 'v1' }),
      /commitMessage/, '缺 commitMessage 必须在到达 MCP 之前被拒')
    await assert.rejects(() => docWriter.write({ op: 'doc-page-update', ident: '', documentId: 1, pageId: 2, content: '   ', expectedVersion: 'v1', commitMessage: 'm' }),
      /content 不能为空/, '空正文会清空页面，UI 入口直接挡掉')
    await assert.rejects(() => docWriter.write({ op: 'doc-page-update', ident: '', documentId: 0, pageId: 2, content: 'x', expectedVersion: 'v1', commitMessage: 'm' }),
      /documentId/)
    assert.equal(docWriter.recent().length, 4, '被拒的文档写也要留流水（审计要求"每次都留痕"）')
    assert.ok(docWriter.recent().every((r) => !r.ok), '这四条都应记为失败')
    console.log('  ✓ 文档写经唯一写入口：乐观锁与提交说明缺一不可，且失败也留审计流水')

    // ── 人格：<docs> 规则块必须在（模型的试错成本在这几条上最高）─────────
    //
    // ⚠️ 这组断言曾经"在主块里找 WikiInfo 的词"，而主块早已不是 WikiInfo ——
    // 那时只要把词留在主块里就能过，**恰恰是错的结构**。
    // 现在分成两半：主路径的词在主块里找；WikiInfo 的词**只在 `<wikiinfo>` 子块里**找。
    const personaText = after
    assert.match(personaText, /<docs>/, '人格必须带 <docs> 规则块')
    const pI = personaText.indexOf('<docs>')
    const pJ = personaText.indexOf('</docs>')
    const pWiki = personaText.indexOf('<wikiinfo>')
    const pWikiEnd = personaText.indexOf('</wikiinfo>')
    assert.ok(pI >= 0 && pJ > pI, '<docs> 必须闭合')
    assert.ok(pWiki > pI && pWikiEnd > pWiki, '<wikiinfo> 必须在 <docs> 内且闭合')
    const main = personaText.slice(pI, pWiki) + personaText.slice(pWikiEnd, pJ)
    const wiki = personaText.slice(pWiki, pWikiEnd)
    // 主路径（节点树 + 附件）的话只在主块里找
    for (const word of ['list_program_doc_nodes', 'list_doc_nodes', 'download_attach_file', 'wiki_enabled_with_content']) {
      assert.ok(main.includes(word), `<docs> 主路径必须写到 ${word}`)
    }
    // WikiInfo 的话只在条件块里找 —— 写到主块就等于又把它当成了主路径
    for (const word of ['expected_version', 'commit_message', 'list_enterprise_document_pages', '不自动合并', '不能按项目过滤']) {
      assert.ok(wiki.includes(word), `<wikiinfo> 条件块必须写到 ${word}`)
      assert.ok(!main.includes(word), `${word} 不得出现在主块里（那会让本企业恒为 0 的路看起来是主路径）`)
    }
    console.log('  ✓ 人格 <docs>：主块=节点树+附件 · <wikiinfo>=页级 version/乐观锁/不自动合并（严格分区）')

    // ── /ping 必须报出文档缓存状态（排障第一站）─────────────────────────
    const pingDocs = (await call(handler, { method: 'GET', url: '/api/gitee-chat/ping' })).json
    assert.ok(pingDocs.docs, '/ping 应携带文档缓存状态')
    assert.match(pingDocs.docs.cacheRoot, /gitee[\\/]docs$/, '默认缓存根应是 $DSH_HOME/gitee/docs')
    console.log(`  ✓ /ping 携带文档缓存状态（${pingDocs.docs.cacheRoot}）`)
  }

  // ══ 13. 未知路由 ═══════════════════════════════════════════════════════
  assert.equal((await call(handler, { method: 'GET', url: '/api/gitee-chat/nope' })).status, 404)
  console.log('  ✓ 未知路由 404')

  console.log('\n全部通过 ✅')
}

main().catch((error) => {
  console.error('\n冒烟失败 ❌')
  console.error(error)
  process.exit(1)
})
