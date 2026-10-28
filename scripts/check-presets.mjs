/**
 * preset 交付自检 + 可移植性体检（`--doctor`）。
 *
 * **preset 不再是"拷到用户根的文件"**：DSH 0.1.7 起移除了 `@deepseek-ai/dsh-agent-presets`
 * （复数，扫 `$DSH_HOME/.agent-presets/` 的那个包），preset 改成声明式的
 * `@deepseek-ai/dsh-agent-preset`（单数）行，由 bundle 的 patch 交付 ——
 * 随发行版的 standard/ptc/minimal/cordis 就是这么发的（`dsh-web-app/presets/*.patch.yml`）。
 *
 * 所以本包也把 preset 写成了 `presets/gitee-*.patch.yml`，并在 `package.json` 的
 * `dsh.bundle.patch` 里列出来：**仓库里那份就是运行时生效的那份**，没有"搬运"这一步，
 * 也就没有"仓库与运行时悄悄漂移"这回事。这个脚本因此从"安装器"变成了"校验器"：
 *
 *   node scripts/check-presets.mjs --check    # 交付判据，CI/门禁用（`npm run check` 里跑）
 *   node scripts/check-presets.mjs --doctor   # 换机器 / 换同事前的可移植性体检（说人话）
 *
 * 曾经的 `install-presets.mjs`（把目录拷到 `~/.dsh/.agent-presets/`）已删除：
 * 在新机制下那份文件**没有任何消费者**，装上也不会出现在 preset 列表里
 * —— 2026-09-28 在 DSH 0.1.7-rc.2 上实测（见 DESIGN.md §29）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceRoot = join(root, 'presets')
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** 本插件的 agent 行名（preset 组合里必须挂的那一行，会话判定的唯一事实依据）。 */
const AGENT_ROW = 'dsh-gitee-chat/agent'

/** 交付一个 preset 用的行名 —— 单数，与旧机制 `dsh-agent-presets`（复数）不是一回事。 */
const PRESET_ROW = '@deepseek-ai/dsh-agent-preset'

/**
 * 本包 `dsh.bundle.patch` 声明的补丁文件的**合并文本**（字符串或数组都认）。
 *
 * 为什么不写死文件名：bundle 补丁不止一个文件 —— 0.4.5 起 host 行在
 * `cordis.patch.yml`、skill 行在 `cordis.skills.patch.yml`（它必须带 config，
 * 而 host 那个文件必须留成纯 insert 供插件市场热挂载，见 DESIGN.md §35），
 * preset 在 `presets/*.patch.yml`。所以"某一行在不在补丁里"这类判据要看**全部**。
 */
function bundlePatchText() {
  let declared
  try {
    declared = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))?.dsh?.bundle?.patch
  } catch {
    return ''
  }
  const list = Array.isArray(declared) ? declared : typeof declared === 'string' ? [declared] : []
  const files = list.length > 0 ? list : ['./cordis.patch.yml']
  let out = ''
  for (const rel of files) {
    const path = join(root, String(rel))
    if (!existsSync(path)) continue
    out += `\n# ── ${rel} ──\n` + readFileSync(path, 'utf8')
  }
  return out
}

/**
 * 组合里出现的**插件行名**（`name:` 的值）。
 * 只取看起来像模块说明符的（含 `/` 或以 `@` 开头），跳过标题之类的普通文本。
 */
function rowNamesOf(text) {
  const out = []
  for (const m of text.matchAll(/^[ \t]*(?:-[ \t]+)?name:[ \t]*['"]?([^'"\n]+?)['"]?[ \t]*$/gm)) {
    const value = m[1].trim()
    if (value.includes('/') || value.startsWith('@')) out.push(value)
  }
  return out
}

/** 交付一行的解析判据。
 *
 * **别拿本仓的 `node_modules` 当判据**：`link:` 装法下它是一条指向
 * `$DSH_HOME/profiles/node_modules/@deepseek-ai` 的旁路，那个目录是**旧安装留下的快照**
 * （含已删除包的悬空软链、缺新包的软链）。DSH 真正的运行时解析器以**安装闭包**为准
 * （`createRuntimeResolution({ installAnchor })`，锚点是全局 dsh 自己的依赖树），
 * 所以这里先按安装闭包判，再退回本仓。
 */
const resolveFromInstall = (() => {
  try {
    const anchor = createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')
    return createRequire(anchor)
  } catch {
    return null
  }
})()

function rowResolvable(row) {
  try {
    createRequire(import.meta.url).resolve(row)
    return true
  } catch { /* 本仓解析不了不算失败，见上 */ }
  if (resolveFromInstall !== null) {
    try {
      resolveFromInstall.resolve(row)
      return true
    } catch { /* 安装闭包也没有才算解析不到 */ }
  }
  return false
}

/**
 * 从一个 preset patch 文件里取出声明（`--check` 与冒烟共用同一套判据）。
 *
 * 判据形状（照 `dsh-web-app/presets/minimal.patch.yml`）：
 *   - insert:
 *       - id: preset-gitee-exec
 *         name: '@deepseek-ai/dsh-agent-preset'
 *         config:
 *           id: gitee-exec
 *           plugins: …
 *
 * @param {string} text patch 文件内容
 * @param {string} file 文件名（报错用）
 * @returns {{ok: boolean, problems: string[], id: string|null, order: number|null, plugins: string}}
 */
export function readPresetPatch(text, file) {
  const problems = []
  const inserts = [...text.matchAll(/^[ \t]*-\s*id:\s*(preset-[A-Za-z0-9_-]+)[ \t]*$/gm)].map((m) => m[1])
  if (inserts.length !== 1) {
    problems.push(`${file}: 应当恰好声明一个 preset 行（「- id: preset-<名字>」），实际 ${inserts.length} 个`)
  }
  if (!new RegExp(`^[ \\t]*name:[ \\t]*['"]?${PRESET_ROW.replace(/[/@]/g, (c) => `\\${c}`)}['"]?[ \\t]*$`, 'm').test(text)) {
    problems.push(`${file}: 没有用 \`${PRESET_ROW}\` 这一行（旧机制是复数的 \`dsh-agent-presets\`，在 0.1.7 上已不存在）`)
  }
  const id = /config:[\s\S]*?^[ \t]*id:[ \t]*['"]?([A-Za-z0-9_-]+)['"]?[ \t]*$/m.exec(text)?.[1] ?? null
  const order = Number(/^[ \t]*order:[ \t]*(\d+)[ \t]*$/m.exec(text)?.[1] ?? NaN)
  if (!rowNamesOf(text).includes(AGENT_ROW)) {
    problems.push(`${file}: 组合里没有挂 ${AGENT_ROW} —— 该 preset 的会话不会显示「Gitee 项目」标签页，写路由也会被拒`)
  }
  return {
    ok: problems.length === 0,
    problems,
    id,
    order: Number.isNaN(order) ? null : order,
    plugins: text,
  }
}

/** 交付判据：preset 文件齐备 + 已列进 bundle patch + 每个都挂了 agent 行。 */
function checkDelivery() {
  const problems = []
  const notes = []
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const declared = pkg.dsh?.bundle?.patch
  const patches = Array.isArray(declared) ? declared : typeof declared === 'string' ? [declared] : []
  if (patches.length === 0) problems.push('package.json 没有 dsh.bundle.patch：bundle 补丁不会被组合')

  const files = existsSync(sourceRoot)
    ? readdirSync(sourceRoot).filter((f) => f.endsWith('.patch.yml')).sort()
    : []
  if (files.length === 0) problems.push(`仓库里没有 preset 补丁：${sourceRoot}/*.patch.yml`)

  const ids = []
  for (const file of files) {
    const rel = `./presets/${file}`
    if (!patches.includes(rel)) {
      problems.push(`${rel} 没有列进 package.json 的 dsh.bundle.patch —— 文件在仓库里，但装到别人机器上不会被组合`)
    }
    const text = readFileSync(join(sourceRoot, file), 'utf8')
    const parsed = readPresetPatch(text, file)
    problems.push(...parsed.problems)
    if (parsed.id !== null) ids.push(parsed.id)
    // preset 引用的插件行，逐个看能不能解析（换机器最容易挂的地方）
    for (const row of rowNamesOf(text)) {
      if (row === AGENT_ROW || row === PRESET_ROW || row.startsWith('cordis:')) continue
      if (!rowResolvable(row)) {
        notes.push(`组合里引用的插件解析不到：${row}`
          + '（安装闭包与本仓都没有；装到目标机器上仍可能可用，但先在 README 的"换一台机器"里确认这一项）')
      }
    }
    // MCP 行：`command:` 是 !!js 表达式，名字可能只出现在字符串里
    if (!/^[ \t]*command:[^\n]*mcp-gitee-ent/m.test(text)) {
      notes.push(`${file}: 没看到指向 mcp-gitee-ent 的 \`command:\` —— 该 preset 的 MCP 工具会挂不上`)
    }
  }
  for (const rel of patches) {
    if (rel === './cordis.patch.yml') continue
    if (rel.startsWith('./presets/') && !files.includes(rel.slice('./presets/'.length))) {
      problems.push(`package.json 列了 ${rel}，但文件不存在（缺文件会让整棵插件树起不来）`)
    }
  }
  return { problems, notes, files, ids, patches }
}

/** 本仓/本机的其余体检项（与 preset 交付无关，但换机器前值得一眼看完）。 */
function checkEnvironment() {
  const problems = []
  const notes = []

  for (const entry of ['lib/index.js', 'lib/agent.js', 'lib/client.js', 'scripts/gitee/gq.mjs']) {
    if (!existsSync(join(root, entry))) problems.push(`缺少构建产物/脚本：${entry}（先跑 npm run build）`)
  }

  // 随包 MCP 二进制：0.5.1 起落在**用户级 bin**（POSIX `$XDG_BIN_HOME`→`~/.local/bin`，
  // Windows `%USERPROFILE%\.local\bin`）；0.5.0 的旧私有副本仍算"过渡期间可用"，
  // 都没有才看 PATH。
  const ext = process.platform === 'win32' ? '.exe' : ''
  const xdg = process.env.XDG_BIN_HOME
  const binDir = process.platform === 'win32'
    ? join(homedir(), '.local', 'bin')
    : (typeof xdg === 'string' && xdg.trim() !== '' ? xdg.trim() : join(homedir(), '.local', 'bin'))
  const userBin = join(binDir, `mcp-gitee-ent${ext}`)
  const legacyBin = join(dshHome, '.gitee-chat', 'bin', `mcp-gitee-ent${ext}`)
  if (!existsSync(userBin) && !existsSync(legacyBin)) {
    const sep = process.platform === 'win32' ? ';' : ':'
    const onPath = (process.env.PATH ?? '').split(sep).some((dir) => existsSync(join(dir, `mcp-gitee-ent${ext}`)))
    if (!onPath) {
      notes.push(`既没有随包 MCP 二进制落地（\`${userBin}\`），PATH 里也没有 \`mcp-gitee-ent\`。`
        + 'MCP 工具会挂不上（「Gitee 项目」标签页本身仍可用）。'
        + '正常安装会自动落地；手工拷包时跑 `node scripts/build-mcp.mjs --check`。')
    }
  }

  // token：**绝不打印内容**，只说在哪儿找得到
  const tokenCandidates = [
    join(dshHome, '.gitee-chat', 'token'),
    join(dshHome, 'gitee-chat-token'),
    join(homedir(), '.gitee-token'),
  ]
  const envToken = ['GITEE_ENT_MCP_ACCESS_TOKEN', 'GITEE_ACCESS_TOKEN', 'GITEE_TOKEN']
    .some((k) => typeof process.env[k] === 'string' && process.env[k].trim() !== '')
  const tokenFile = tokenCandidates.find((p) => existsSync(p))
  if (!envToken && tokenFile === undefined) {
    notes.push('没有找到 Gitee token。取数会报「未配置 token」，界面会明确提示而不是显示空数据。'
      + '**推荐在界面里填**：应用「设置 → Gitee 企业项目」（0.4.1 起，存完即时生效）；'
      + `也可以自己放：环境变量或 ${tokenCandidates.join(' / ')}`)
  }

  // skill：随包分发，由**本包 bundle 补丁**挂 provider 指向 <包>/skills。
  // 0.4.5 起这一行单独在 cordis.skills.patch.yml（它必须带 config，而
  // cordis.patch.yml 要留成纯 insert 给插件市场热挂载用，见 DESIGN.md §35），
  // 所以按 dsh.bundle.patch 声明的文件一起找，不写死文件名。
  const skillFile = join(root, 'skills', 'dsh-gitee-chat', 'SKILL.md')
  const patchText = bundlePatchText()
  if (!existsSync(skillFile)) problems.push(`缺少 skill 真源：${skillFile}`)
  if (!patchText.includes('id: gitee-chat-skills')) {
    problems.push('本包的 bundle 补丁里没有 gitee-chat-skills 行：skill 不会被加载，'
      + 'AI 也就不知道该怎么问使用者、怎么改配置')
  } else if (!patchText.includes("providerName: 'gitee-chat-skills'")) {
    problems.push('skill provider 没换名：宿主已有名为 filesystem 的 provider，同名会让整棵插件树启动失败')
  }

  // 旧机制遗留：`$DSH_HOME/.agent-presets/gitee-*` 现在没有任何消费者，留着只会误导
  const staleRoot = join(dshHome, '.agent-presets')
  if (existsSync(staleRoot)) {
    const stale = readdirSync(staleRoot).filter((n) => n.startsWith('gitee-') && !n.includes('.bak-'))
    if (stale.length > 0) {
      notes.push(`旧机制的遗留目录：${stale.map((n) => join(staleRoot, n)).join(' / ')}`
        + ' —— DSH 0.1.7 起不再读 `$DSH_HOME/.agent-presets/`，这些目录可以删掉（删前确认没有别的手工 preset）')
    }
  }

  // 企业选择：多企业时必须显式指定，否则取数报错（这是刻意的）
  const configPath = join(dshHome, '.gitee-chat', 'config.json')
  let enterpriseId = 0
  try {
    enterpriseId = Number(JSON.parse(readFileSync(configPath, 'utf8')).enterpriseId) || 0
  } catch { /* 未配置 */ }

  return { problems, notes, enterpriseId, configPath, envToken, tokenFile }
}

/**
 * 回归守卫：preset 里的 `!!js` 表达式必须求值成字符串（2026-09-30 的真事故）。
 *
 * 事故形态：MCP 行的 token 写成
 *   `GITEE_ENT_MCP_ACCESS_TOKEN: !!js process.env.A || process.env.B || process.env.C`
 * 桌面版 DSH 从开始菜单启动，不继承 shell 里 export 的变量 ⇒ 三个变量都没有 ⇒ 求值成
 * `undefined` ⇒ dsh-mcp-client 的 `env: z.dict(String)` 拒绝 ⇒ mcp-gitee 这一行 mount
 * 失败（失败是终态，不会自愈）⇒ 整个 preset 永久「加载失败」，并被 preset 列表过滤掉。
 * 修法是让表达式自己回落读 token 文件，并且**永远返回字符串**（见 presets/*.patch.yml 注释）。
 *
 * 这里不重新解释一遍 YAML，而是用与 cordis-plugin-loader 逐字相同的求值器当面跑，
 * 并在**受控环境**（临时目录 + 清空环境变量）下断言 —— 判据与线上行为同源。
 */
const EVALUATOR = new Function('ctx', 'expr', '  with (ctx) { return eval(expr) }  ')

/** 受控求值时要清空/覆盖的键（含 os.homedir() 在 win32 上真正读的那个）。 */
const CONTROLLED_KEYS = [
  'USERPROFILE', 'HOME', 'DSH_HOME',
  'GITEE_ENT_MCP_ACCESS_TOKEN', 'GITEE_ACCESS_TOKEN', 'GITEE_TOKEN',
  'GITEE_ENT_ID', 'GITEE_CHAT_ENTERPRISE_ID',
]

function withControlledEnv(values, fn) {
  const saved = CONTROLLED_KEYS.map((k) => [k, process.env[k]])
  for (const k of CONTROLLED_KEYS) delete process.env[k]
  for (const [k, v] of Object.entries(values)) process.env[k] = v
  try {
    return fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** 取出 `键: !!js "表达式"` —— 必须是双引号整句，plain 标量会被 YAML 在冒号后截断。 */
function jsExprOf(text, key) {
  const m = new RegExp(`^[ \\t]*${key}:[ \\t]*!!js[ \\t]*"([\\s\\S]*?)"[ \\t]*$`, 'm').exec(text)
  return m === null ? null : m[1]
}

function checkPresetExpressions() {
  const problems = []
  const notes = []
  const temp = mkdtempSync(join(tmpdir(), 'gitee-preset-check-'))
  try {
    // 负例先行：旧写法（三变量皆无 ⇒ undefined）必须被判出来，否则守卫等于没有。
    const legacy = [
      'process.env.GITEE_ENT_MCP_ACCESS_TOKEN',
      'process.env.GITEE_ACCESS_TOKEN',
      'process.env.GITEE_TOKEN',
    ].join(' || ')
    const legacyValue = withControlledEnv(
      { USERPROFILE: join(temp, 'empty'), HOME: join(temp, 'empty'), DSH_HOME: join(temp, 'empty') },
      () => EVALUATOR({}, legacy),
    )
    if (typeof legacyValue === 'string') {
      console.error('自检失败：旧写法的 token 表达式竟然求值成了字符串（应当得到 undefined），守卫等于没有')
      process.exit(1)
    }

    // 受控样本：token 文件带尾换行（读取方必须 trim）、config.json 固定一个企业。
    const empty = join(temp, 'empty')
    mkdirSync(join(temp, '.gitee-chat'), { recursive: true })
    writeFileSync(join(temp, '.gitee-chat', 'token'), ' file-token-BBB \n', 'utf8')
    writeFileSync(join(temp, '.gitee-chat', 'config.json'), JSON.stringify({ enterpriseId: 11111111 }), 'utf8')

    const files = existsSync(sourceRoot) ? readdirSync(sourceRoot).filter((f) => f.endsWith('.patch.yml')).sort() : []
    for (const file of files) {
      const text = readFileSync(join(sourceRoot, file), 'utf8')
      const tokenExpr = jsExprOf(text, 'GITEE_ENT_MCP_ACCESS_TOKEN')
      const entExpr = jsExprOf(text, 'GITEE_ENT_ID')
      const cmdExpr = jsExprOf(text, 'command')
      if (tokenExpr === null || entExpr === null) {
        problems.push(`${file}: GITEE_ENT_MCP_ACCESS_TOKEN / GITEE_ENT_ID 没写成 \`!!js "…"\`（双引号整句）——`
          + 'plain 标量会被 YAML 截断，而表达式求值成 undefined 会让整行 mount 失败、preset 永久「加载失败」')
        continue
      }

      const tokenCases = [
        ['无环境变量、无 token 文件（桌面版最坏情况）', { USERPROFILE: empty, HOME: empty, DSH_HOME: empty }, ''],
        ['环境变量优先，且首尾空格应被吃掉', { USERPROFILE: empty, HOME: empty, DSH_HOME: empty, GITEE_ENT_MCP_ACCESS_TOKEN: ' env-token-AAA ' }, 'env-token-AAA'],
        ['回落读设置界面写的 token 文件，尾换行应被吃掉', { USERPROFILE: temp, HOME: temp, DSH_HOME: temp }, 'file-token-BBB'],
      ]
      for (const [label, env, expected] of tokenCases) {
        const got = withControlledEnv(env, () => EVALUATOR({}, tokenExpr))
        if (typeof got !== 'string') {
          problems.push(`${file}: token 表达式在「${label}」下求值成 ${String(got)}（typeof ${typeof got}）——`
            + 'dsh-mcp-client 的 \`env\` 是 z.dict(String)，undefined 会让 mcp-gitee 整行 mount 失败')
        } else if (got !== expected) {
          problems.push(`${file}: token 表达式在「${label}」下得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(expected)}`)
        }
      }

      const entEmpty = withControlledEnv({ USERPROFILE: empty, HOME: empty, DSH_HOME: empty }, () => EVALUATOR({}, entExpr))
      if (typeof entEmpty !== 'string') {
        problems.push(`${file}: GITEE_ENT_ID 在无配置时求值成 ${String(entEmpty)}（typeof ${typeof entEmpty}），必须返回空字符串`)
      }
      const entFromFile = withControlledEnv({ USERPROFILE: temp, HOME: temp, DSH_HOME: temp }, () => EVALUATOR({}, entExpr))
      if (entFromFile !== '11111111') {
        problems.push(`${file}: GITEE_ENT_ID 没回落读 config.json 的 enterpriseId（得到 ${JSON.stringify(entFromFile)}）——`
          + 'MCP 通道与插件取数通道必须落到同一个企业')
      }

      if (cmdExpr === null) {
        problems.push(`${file}: command 没写成 \`!!js "…"\``)
      } else {
        const cmd = withControlledEnv({ USERPROFILE: temp, HOME: temp }, () => EVALUATOR({}, cmdExpr))
        if (typeof cmd !== 'string' || !/mcp-gitee-ent(\.exe)?$/.test(cmd)) {
          problems.push(`${file}: command 求值成 ${JSON.stringify(cmd)}，不像 mcp-gitee-ent 的落地路径`)
        }
      }
    }
    if (files.length > 0) {
      notes.push(`preset 的 !!js 表达式已在受控环境跑过（${files.length} 个文件 × token 3 场景 + 企业 2 场景 + command）`)
    }
  } finally {
    try { rmSync(temp, { recursive: true, force: true }) } catch { /* 临时目录清不掉不影响判据 */ }
  }
  return { problems, notes }
}

/**
 * 判据自证：拿一个**故意写坏**的 patch 试一次，抓不到就等于没守卫。
 * （冒烟里那套"负例先于断言"的规矩，这里同样适用。）
 */
function selfTest() {
  const bad = [
    "    - id: preset-gitee-exec",
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: gitee',
    '        plugins:',
    "          - id: persona",
    "            name: '@deepseek-ai/dsh-persona'",
  ].join('\n')
  const got = readPresetPatch(bad, 'synthetic.patch.yml')
  const reasons = got.problems.join(' | ')
  if (!reasons.includes(AGENT_ROW)) {
    console.error('自检失败：判据没抓到「组合里缺 agent 行」这个错，守卫等于没有')
    process.exit(1)
  }
  const stillBad = bad + `\n          - id: gitee-chat-agent\n            name: '${AGENT_ROW}'\n`
  if (readPresetPatch(stillBad, 'synthetic.patch.yml').problems.some((p) => p.includes(AGENT_ROW))) {
    console.error('自检失败：补上 agent 行之后还在报同一个错（判据过严）')
    process.exit(1)
  }
  // 复数包名必须被认出来（那正是 0.1.7 上失效的写法）
  const plurals = stillBad.replace(PRESET_ROW, '@deepseek-ai/dsh-agent-presets')
  if (!readPresetPatch(plurals, 'synthetic.patch.yml').problems.some((p) => p.includes(PRESET_ROW))) {
    console.error('自检失败：判据没抓到旧机制的复数包名')
    process.exit(1)
  }
}

/**
 * preset 插件行引用的**子路径**导出（`@scope/pkg/sub`）是跨版本最脆的一环：
 * DSH 0.2.1-rc.3 把 `@deepseek-ai/dsh-tool-subagent-control/list-agents` 合进了包根，
 * 子路径不再导出。导入失败的行在组合里没有 fiber，注册表把整条 preset 记为 broken
 * （「never started」），表现就是**预设从新会话下拉里消失**，而且没有任何报错提示。
 * 因此这里只拦「@deepseek-ai 子路径」，根包名照旧（跨版本最稳）。
 */
function checkSubpathRows() {
  const problems = []
  const allow = new Set(['dsh-gitee-chat/agent'])
  for (const file of readdirSync(sourceRoot).filter((name) => name.endsWith('.yml'))) {
    const text = readFileSync(join(sourceRoot, file), 'utf8')
    for (const line of text.split('\n')) {
      const match = /^\s*(?:-\s*)?name:\s*'([^']+)'\s*$/.exec(line)
      if (match === null) continue
      const name = match[1]
      if (allow.has(name)) continue
      const coreSubpath = /^@deepseek-ai\/(?:(?!\/).)*\/.+$/.test(name)
      if (coreSubpath) {
        problems.push(`presets/${file} 引用了核心包子路径 ${name}：核心 0.2.1-rc.3 已不再导出该子路径，`
          + '这一行导入失败会让整条 preset 变 broken（预设从下拉里消失）。改用包根，或给该行加 disabled: true')
      }
    }
  }
  return { problems }
}

/**
 * persona 模板里的 `{{…}}` 只认宿主**已注册**的提示词变量（当前是 `provider` 与 `model`）。
 *
 * 写成未知变量不会被忽略：提示词渲染阶段会抛
 * `unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"`，
 * 整个回合直接失败 —— 而且报错发生在**运行时**，静态检查能拦就一定要拦。
 * `{{cwd}}` 曾经可用、0.2.1-rc.3 已移除（工作区路径改由注入的运行时上下文给出）。
 */
function checkPromptVariables() {
  const problems = []
  const registered = new Set(['provider', 'model'])
  for (const file of readdirSync(sourceRoot).filter((name) => name.endsWith('.yml'))) {
    const text = readFileSync(join(sourceRoot, file), 'utf8')
    text.split('\n').forEach((line, index) => {
      // 注释行不参与（说明性文字里写到变量名是合规的）。
      if (/^\s*#/.test(line)) return
      for (const match of line.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) {
        const name = match[1]
        if (registered.has(name)) continue
        problems.push(`presets/${file}:${index + 1} 用了未注册的提示词变量 {{${name}}}`
          + `（宿主只注册 ${[...registered].map((n) => `{{${n}}}`).join(' / ')}）：`
          + '渲染时会抛 unknown prompt variable，整个回合失败。改成静态文案，或删除该模板')
      }
    })
  }
  return { problems }
}

function main() {
  selfTest()
  const doctor = process.argv.includes('--doctor')
  const delivery = checkDelivery()
  const env = checkEnvironment()
  const expr = checkPresetExpressions()
  const subpaths = checkSubpathRows()
  const vars = checkPromptVariables()
  const problems = [...delivery.problems, ...env.problems, ...expr.problems, ...subpaths.problems, ...vars.problems]
  const notes = [...delivery.notes, ...env.notes, ...expr.notes]

  if (doctor) {
    console.log('▶ preset 可移植性体检\n')
    console.log(`  1. 仓库里 ${delivery.files.length} 个 preset 补丁：${delivery.ids.join('、') || '(无)'}`)
    console.log(`  2. 交付：package.json 的 dsh.bundle.patch 共 ${delivery.patches.length} 个补丁，preset ${delivery.files.length} 个都在其中`)
    console.log(`  3. 每个 preset 都挂了 ${AGENT_ROW}（会话判定的事实依据）`)
    console.log(`  4. 组合引用的插件行，本机解析不到 ${delivery.notes.filter((n) => n.includes('解析不到')).length} 个（换机器时看这条）`)
    console.log('  5. host / agent / client 三份产物 + 取数脚本')
    console.log('  6. 随包 MCP 二进制（或 PATH 上的同名命令）')
    console.log(`  7. token：${env.envToken ? '环境变量已设置' : env.tokenFile !== undefined ? `已找到 ${env.tokenFile}` : '未找到'}`)
    console.log('  8. skill：真源在包内 + 补丁行 + provider 换名')
    console.log(`  9. 企业：${env.enterpriseId > 0 ? `已固定为 ${env.enterpriseId}（${env.configPath}）` : '未指定（唯一企业自动用；多企业时会报错要求指定，绝不猜）'}`)
    console.log(' 10. preset 的 !!js 表达式：受控环境下当面求值'
      + '（token：无来源 / 环境变量 / token 文件 三场景 + 企业两场景 + command）')
    console.log('')
    if (notes.length > 0) {
      console.log('说明（不一定有问题，但换机器时值得先看一眼）：')
      for (const n of notes) console.log(`  · ${n}`)
      console.log('')
    }
    if (problems.length > 0) {
      console.error('发现必须修的问题：')
      for (const p of problems) console.error(`  ✗ ${p}`)
      process.exit(1)
    }
    console.log('体检通过 ✅（只检查本仓库与交付判据的自洽性；'
      + '线上是否可用还要看目标机器的 DSH 版本、PATH 与 token）')
    return
  }

  for (const file of delivery.files) console.log(`  ✓ presets/${file}（已列进 bundle patch，且挂了 ${AGENT_ROW}）`)
  if (problems.length > 0) {
    console.error('\npreset 交付判据不过：')
    for (const p of problems) console.error(`  ✗ ${p}`)
    process.exit(1)
  }
  console.log(`\npreset 交付自检通过 ✅（${delivery.files.length} 个 preset 随 bundle 补丁交付；`
    + '改完 preset 要重启 dsh web 才会重新组合 —— 补丁列表在装配期读）')
  if (notes.length > 0) console.log(`（另有 ${notes.length} 条说明，跑 --doctor 看）`)
}

main()
