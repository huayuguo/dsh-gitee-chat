/**
 * 随包分发的 Gitee 企业版 MCP 后端：定位、校验、落地。
 *
 * **为什么要有这个模块**：同事不该为了装一个 MCP 后端先装一套 Go。
 * 所以二进制随插件走（`vendor/mcp-gitee-ent/`），这里负责把它变成
 * 「一个稳定的、preset 能写死的路径」。
 *
 * 三方各自算同一个路径，**必须完全一致**，否则会静默降级成 PATH 上的旧二进制：
 *   1. 本模块 `materializedPath()` —— 安装/装配时把二进制拷过去；
 *   2. preset 的 `command: !!js …` —— 指向它（表达式里只能用 `process`）；
 *   3. `scripts/setup.mjs` —— 安装时先落地一份，让新会话立刻能用。
 *
 * 0.5.1 起落点是**跨平台用户级 bin**（POSIX `$XDG_BIN_HOME` → `~/.local/bin`；
 * Windows `%USERPROFILE%\.local\bin`，见 `userBinDir()`）：MCP 后端是**公开**工具，
 * 就该待在标准位置、任何 MCP 客户端都能从 PATH 调到它 —— 而不是塞在插件私有的
 * `$DSH_HOME/.gitee-chat/bin/`（那是 0.5.0 及之前的位置，0.5.1 起只作为迁移残留被清理）。
 * 早先那份原型补丁写成 `profiles/<写死的名字>/node_modules/…`，换个 profile 名就废
 * ——这是本模块存在的第二个理由。
 *
 * @module dsh-gitee-chat/host/mcpBinary
 */

import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { packageRoot } from './gq.ts'

/** 二进制在包内的位置。 */
export function vendorDir(): string {
  return join(packageRoot(), 'vendor', 'mcp-gitee-ent')
}

/** manifest 的路径。 */
export function manifestPath(): string {
  return join(vendorDir(), 'manifest.json')
}

/** manifest 的结构（由 scripts/build-mcp.mjs 生成）。 */
export interface McpManifest {
  name: string
  fork: string
  forkCommit: string
  forkDirty: boolean
  goVersion: string
  buildFlags: string
  generatedAt: string
  toolCount: number
  tools: string[]
  forkOnlyTools: string[]
  platforms: Record<string, {
    file: string
    os: string
    arch: string
    size: number
    sha256: string
  }>
}

/** 读 manifest；缺失或损坏返回 null（调用方据此降级，绝不抛）。 */
export function readManifest(): McpManifest | null {
  try {
    return JSON.parse(readFileSync(manifestPath(), 'utf8')) as McpManifest
  } catch {
    return null
  }
}

/**
 * 当前平台在 manifest 里的键。
 *
 * 与 `scripts/build-mcp.mjs` 的 `describePlatform` 必须一致：
 * windows → `win32`、amd64 → `x64`。
 * @param platform - 默认取 `process.platform`（测试可注入）。
 * @param arch - 默认取 `process.arch`。
 */
export function platformKey(platform: string = process.platform, arch: string = process.arch): string {
  const os = platform === 'windows' ? 'win32' : platform
  const cpu = arch === 'amd64' ? 'x64' : arch
  return `${os}-${cpu}`
}

/** DSH_HOME（与 setup.mjs / gq.mjs 同一条回落顺序）。 */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/**
 * 二进制文件名（Windows 带 `.exe`）。
 * @param platform - 默认取 `process.platform`（测试可注入）。
 */
export function binaryName(platform: string = process.platform): string {
  return platform === 'win32' ? 'mcp-gitee-ent.exe' : 'mcp-gitee-ent'
}

/**
 * 安装目录 —— **跨平台用户级 bin**（0.5.1 起）。
 *
 * 这是「公开 MCP 后端」该待的地方：与 `pipx` / `uv`（以及一大批 MCP server）
 * 的约定一致，装完任何 MCP 客户端都能从 PATH 直接调到它。
 *
 *   - Windows：`%USERPROFILE%\.local\bin`（pipx / uv 在 Windows 的默认 bin 目录）
 *   - 其它平台：`$XDG_BIN_HOME` → `~/.local/bin`（XDG 规范的默认用户可执行目录）
 *
 * ⚠️ Windows 上这个目录**默认不在 PATH 里**：preset 用绝对路径所以不受影响，
 * 但"别的客户端也能直接用 `mcp-gitee-ent`"需要用户自己加进 PATH ——
 * `verify` / 健康检查会给提示，插件**不擅自改环境变量**。
 *
 * @param platform - 默认取 `process.platform`（测试可注入）。
 * @param env - 默认取 `process.env`（测试可注入）。
 * @param home - 用户主目录，默认 `homedir()`（测试可注入）。
 */
export function userBinDir(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === 'win32') return join(home, '.local', 'bin')
  const xdg = env.XDG_BIN_HOME
  if (typeof xdg === 'string' && xdg.trim() !== '') return xdg.trim()
  return join(home, '.local', 'bin')
}

/**
 * 落地位置 —— **preset 里写死的那个路径**。
 *
 * 改这里必须同步改：两个 preset 补丁里的 `command: !!js …`、`scripts/setup.mjs`
 * 的 `mcpTargetPath()`。三处算出来必须一致，不一致**不会报错**，只会静默回落到
 * PATH 上的旧二进制。
 * @param platform - 默认取 `process.platform`（测试可注入）。
 * @param env - 默认取 `process.env`（测试可注入）。
 * @param home - 用户主目录，默认 `homedir()`（测试可注入）。
 */
export function materializedPath(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return join(userBinDir(platform, env, home), binaryName(platform))
}

/**
 * 0.5.0 及之前的**私有**落地位置（`$DSH_HOME/.gitee-chat/bin/…`）。
 *
 * 只用于两件事：迁移时删掉它、以及新位置落地失败时的过渡回落。
 * 不再作为安装目标。
 * @param platform - 默认取 `process.platform`（测试可注入）。
 * @param home - DSH_HOME，默认 `dshHome()`（测试可注入）。
 */
export function legacyMaterializedPath(platform: string = process.platform, home: string = dshHome()): string {
  return join(home, '.gitee-chat', 'bin', binaryName(platform))
}

/**
 * 目录是否在 PATH 上（Windows 不区分大小写；两侧都去掉尾部斜杠）。
 *
 * 用来决定要不要提示用户"把它加进 PATH"——`~/.local/bin` 在 Linux 上
 * 通常已在，Windows 的 `%USERPROFILE%\.local\bin` 通常不在。
 */
export function isOnPath(dir: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): boolean {
  const raw = env.PATH ?? env.Path ?? ''
  if (raw.trim() === '') return false
  const norm = (value: string): string => {
    const trimmed = value.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/')
    return platform === 'win32' ? trimmed.toLowerCase() : trimmed
  }
  const wanted = norm(dir)
  return raw.split(platform === 'win32' ? ';' : ':').some((entry) => entry.trim() !== '' && norm(entry) === wanted)
}

/** 文件 sha256（小写十六进制）。 */
export function sha256Of(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/** 一次落地/定位的结果。 */
export interface McpBinaryReport {
  /** `vendored` = 用的是随包二进制；`path` = 回落到 PATH 上自带的；`missing` = 都没有。 */
  source: 'vendored' | 'path' | 'missing'
  /** 实际要执行的命令（preset 也指向这里）。 */
  command: string
  /** 随包清单里是否有当前平台。 */
  bundledForPlatform: boolean
  /** 本次是否重新拷贝了（false = 已是最新，直接复用）。 */
  copied: boolean
  /** 安装目录是否在 PATH 上（不在就给用户加 PATH 的提示）。 */
  onPath: boolean
  /** 本次是否清理掉了 0.5.0 的私有副本（`$DSH_HOME/.gitee-chat/bin/…`）。 */
  legacyRemoved: boolean
  /** 人类可读的一句话，直接进 `/health` 与 `verify`。 */
  detail: string
}

/** 从 external 覆盖项里解析（`MCP_GITEE_ENT_BIN`）。 */
function overrideCommand(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.MCP_GITEE_ENT_BIN
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * 删掉 0.5.0 的私有副本（文件 + 遗留 `.tmp-*`，目录空了也一并删）。
 *
 * 迁移用：新位置装好之后才调用。**绝不抛** —— Windows 上旧会话可能正占着
 * 那个 `.exe`，删不掉就留着，下次启动再试。
 * @returns 是否真的删掉了文件。
 */
function removeLegacy(legacy: string): boolean {
  let removed = false
  try {
    sweepTmpFiles(legacy)
    if (existsSync(legacy)) {
      rmSync(legacy, { force: true })
      removed = true
    }
  } catch { /* 占用/权限：留着 */ }
  try {
    const dir = dirname(legacy)
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
  } catch { /* 目录不在/非空/占用，都无所谓 */ }
  return removed
}

/**
 * 清理落地过程中留下的临时文件（`<target>.tmp-<pid>`）。
 *
 * 落地的写盘动作是 `copy → chmod → rename`：Windows 上目标 `.exe` 可能正被
 * 运行中的 MCP 子进程占用，`rename` 失败会留下临时文件。**失败会累积**，
 * 所以每次落地前后都扫一遍（删不掉的留到下次，不抛）。
 * @param target - 最终落地路径。
 */
function sweepTmpFiles(target: string): void {
  const dir = dirname(target)
  const prefix = `${basename(target)}.tmp-`
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    try { rmSync(join(dir, name), { force: true }) } catch { /* 占用中，下次再清 */ }
  }
}

/**
 * 确保随包二进制落到 `materializedPath()`（**用户级 bin**），并返回它的状态。
 *
 * 幂等、可重复调用（装配时调一次即可自愈；每次会话不重复拷）。
 * **不抛异常**：装不上时降级并说明原因，绝不让插件树起不来。
 *
 * 迁移：新位置就位（本来就对，或这次拷成功）之后，顺手删掉 0.5.0 的私有副本
 * `$DSH_HOME/.gitee-chat/bin/…`；删不掉只记 `legacyRemoved: false`，不报错。
 *
 * @param options.platform - 注入平台（测试用）。
 * @param options.env - 注入环境（测试用）。
 * @param options.home - 注入用户主目录（测试用）。
 * @param options.dshHome - 注入 DSH_HOME，只用于定位旧私有副本（测试用）。
 */
export function ensureMaterialized(options: {
  platform?: string
  env?: NodeJS.ProcessEnv
  home?: string
  dshHome?: string
} = {}): McpBinaryReport {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const target = materializedPath(platform, env, home)
  const legacy = legacyMaterializedPath(platform, options.dshHome ?? dshHome())
  const onPath = isOnPath(dirname(target), env, platform)
  /** 早退分支共用的两个新字段。 */
  const bare = { onPath, legacyRemoved: false }

  const override = overrideCommand(env)
  if (override !== null) {
    return {
      ...bare,
      source: 'path',
      command: override,
      bundledForPlatform: false,
      copied: false,
      detail: `MCP_GITEE_ENT_BIN 指定了外部二进制：${override}`,
    }
  }

  const manifest = readManifest()
  const entry = manifest?.platforms?.[platformKey(platform, process.arch)]
  if (manifest === null || entry === undefined) {
    return {
      ...bare,
      source: 'path',
      command: 'mcp-gitee-ent',
      bundledForPlatform: false,
      copied: false,
      detail: `本平台（${platformKey(platform, process.arch)}）未随包提供二进制，`
        + '回落到 PATH 上的 mcp-gitee-ent；没有的话请装 Go 并 `go install`，'
        + '或用 MCP_GITEE_ENT_BIN 指到已有二进制。',
    }
  }

  const vendored = join(vendorDir(), entry.file)
  if (!existsSync(vendored)) {
    return {
      ...bare,
      source: 'missing',
      command: target,
      bundledForPlatform: true,
      copied: false,
      detail: `清单声明了 ${entry.file}，但文件不存在（安装不完整）。`,
    }
  }

  /** 不在 PATH 上时补一句可执行的提示（Windows 最常见）。 */
  const pathHint = onPath
    ? ''
    : `；注意 ${dirname(target)} 不在 PATH 上，其它 MCP 客户端要直接调 \`${binaryName(platform)}\` 需把它加进 PATH`

  // 已经落地且内容正确 → 直接复用（避免每次启动都拷 8 MiB），并完成迁移清理
  if (existsSync(target)) {
    try {
      if (statSync(target).size === entry.size && sha256Of(target) === entry.sha256) {
        const legacyRemoved = removeLegacy(legacy)
        return {
          onPath,
          legacyRemoved,
          source: 'vendored',
          command: target,
          bundledForPlatform: true,
          copied: false,
          detail: `随包 MCP 二进制已就位：${target}（${manifest.toolCount} 个工具）`
            + (legacyRemoved ? '；已清掉 0.5.0 的私有副本' : '') + pathHint,
        }
      }
    } catch { /* 读不到就当作需要重拷 */ }
  }

  try {
    mkdirSync(dirname(target), { recursive: true })
    // 上一轮落地失败可能留下 `.tmp-<pid>`（Windows 上目标被占用时必然如此）：
    // 每次落地前先扫一遍，避免越积越多。
    sweepTmpFiles(target)
    // 目标已存在但不是随包版本（用户自己 `go install` 的、上游 npm 版、插件的旧版本…）：
    // **不静默覆盖别人的二进制**，先让到 `<name>.bak` 再落（只保留最近一份）。
    let backedUp = false
    if (existsSync(target)) {
      try {
        rmSync(`${target}.bak`, { force: true })
        renameSync(target, `${target}.bak`)
        backedUp = true
      } catch { /* 让不开（Windows 占用）：随包版本优先，直接覆盖 */ }
    }
    const tmp = `${target}.tmp-${process.pid}`
    try {
      copyFileSync(vendored, tmp)
      chmodSync(tmp, 0o755)
      renameSync(tmp, target)
    } catch (error) {
      // 自己这次留下的临时文件自己收拾；Windows 上被占用时删不掉，留给下次扫。
      try { rmSync(tmp, { force: true }) } catch { /* 占用中 */ }
      throw error
    }
    const legacyRemoved = removeLegacy(legacy)
    return {
      onPath,
      legacyRemoved,
      source: 'vendored',
      command: target,
      bundledForPlatform: true,
      copied: true,
      detail: `已落地随包 MCP 二进制：${target}（${manifest.toolCount} 个工具）`
        + (backedUp ? `；原文件不是随包版本，已备份为 ${target}.bak` : '')
        + (legacyRemoved ? '；已清掉 0.5.0 的私有副本' : '') + pathHint,
    }
  } catch (error) {
    // Windows 上旧会话可能正占着这个 .exe；升级二进制需重启，与"改代码需重启"同一条规则。
    const stillThere = existsSync(target)
    // 过渡回落：新位置没写成、但 0.5.0 那份还在 → 先用旧的，别让 preset 找不到命令。
    const fallbackLegacy = !stillThere && existsSync(legacy)
    return {
      onPath,
      legacyRemoved: false,
      source: stillThere || fallbackLegacy ? 'vendored' : 'missing',
      command: fallbackLegacy ? legacy : target,
      bundledForPlatform: true,
      copied: false,
      detail: `随包 MCP 二进制落地失败（${(error as Error).message}）`
        + (fallbackLegacy
          ? `；暂用 0.5.0 的旧副本 ${legacy}（重启 dsh 会重试迁移）`
          : stillThere ? `；沿用已存在的 ${target}（若刚升级过二进制，重启 dsh 即可换新）` : ''),
    }
  }
}

/**
 * 找出「能力矩阵声明了、但随包二进制不提供」的工具。
 *
 * 这是**换错二进制的唯一可靠信号**：preset 的 `--enabled-toolsets` 是过滤器
 * 不是校验器，名字对不上只会静默少几个工具，界面上一点提示都没有。
 * @returns 缺失的工具名；清单不可用时返回 null。
 */
export function toolGapOf(manifest: McpManifest | null, enabledToolsets?: readonly string[]): string[] | null {
  if (manifest === null || !Array.isArray(manifest.tools) || enabledToolsets === undefined) return null
  const provided = new Set(manifest.tools)
  return enabledToolsets.filter((t) => !provided.has(t))
}

/**
 * 只读探测，**不落地**：给 `/ping` 与 `gitee_chat_health` 用。
 *
 * GET 不该有副作用，所以这里一个字节都不写；落地只在装配期（`ensureMaterialized`）
 * 与安装期（`setup.mjs apply`）发生。
 *
 * `matchesManifest: false` 是**二进制被换过**的信号（拿了上游 npm 版、
 * 拷了一半、版本不一致）。这正是"少 10 个工具却不报错"那个坑的探针。
 */
export interface McpInspection {
  /** 随包清单的摘要；清单缺失（手工拷包）时为 null。 */
  manifest: { toolCount: number; forkCommit: string; goVersion: string } | null
  /** 当前平台在清单里的键，如 `linux-x64` / `win32-x64`。 */
  platform: string
  /** 随包清单是否覆盖当前平台。 */
  bundled: boolean
  /** 已落地的位置（preset 指向它）—— 0.5.1 起是用户级 bin。 */
  target: string
  /** 该文件是否存在。 */
  installed: boolean
  /** 已落地的文件是否与清单的 sha256 一致。 */
  matchesManifest: boolean
  /** 是否由 `MCP_GITEE_ENT_BIN` 指定了外部二进制。 */
  overridden: boolean
  /** 安装目录是否在 PATH 上。 */
  onPath: boolean
  /** 0.5.0 的私有残留（迁移是否完成看它）。 */
  legacy: { path: string; present: boolean }
}

/** @see McpInspection */
export function inspectMcpBinary(): McpInspection {
  const manifest = readManifest()
  const key = platformKey()
  const entry = manifest?.platforms?.[key]
  const target = materializedPath()
  const installed = existsSync(target)
  const legacy = legacyMaterializedPath()
  return {
    manifest: manifest === null ? null : {
      toolCount: manifest.toolCount,
      forkCommit: manifest.forkCommit,
      goVersion: manifest.goVersion,
    },
    platform: key,
    bundled: entry !== undefined,
    target,
    installed,
    matchesManifest: entry !== undefined && installed && sha256Of(target) === entry.sha256,
    overridden: overrideCommand() !== null,
    onPath: isOnPath(dirname(target)),
    legacy: { path: legacy, present: existsSync(legacy) },
  }
}
