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
 * 落点是**跨平台用户级 bin**（POSIX `$XDG_BIN_HOME` → `~/.local/bin`；
 * Windows `%USERPROFILE%\.local\bin`，见 `userBinDir()`）：MCP 后端是**公开**工具，
 * 就该待在标准位置、任何 MCP 客户端都能从 PATH 调到它。
 * 早先那份原型补丁写成 `profiles/<写死的名字>/node_modules/…`，换个 profile 名就废
 * ——这是本模块存在的第二个理由。
 *
 * @module dsh-gitee-chat/host/mcpBinary
 */
/** 二进制在包内的位置。 */
export declare function vendorDir(): string;
/** manifest 的路径。 */
export declare function manifestPath(): string;
/** manifest 的结构（由 scripts/build-mcp.mjs 生成）。 */
export interface McpManifest {
    name: string;
    fork: string;
    forkCommit: string;
    forkDirty: boolean;
    goVersion: string;
    buildFlags: string;
    generatedAt: string;
    toolCount: number;
    tools: string[];
    forkOnlyTools: string[];
    platforms: Record<string, {
        file: string;
        os: string;
        arch: string;
        size: number;
        sha256: string;
    }>;
}
/** 读 manifest；缺失或损坏返回 null（调用方据此降级，绝不抛）。 */
export declare function readManifest(): McpManifest | null;
/**
 * 当前平台在 manifest 里的键。
 *
 * 与 `scripts/build-mcp.mjs` 的 `describePlatform` 必须一致：
 * windows → `win32`、amd64 → `x64`。
 * @param platform - 默认取 `process.platform`（测试可注入）。
 * @param arch - 默认取 `process.arch`。
 */
export declare function platformKey(platform?: string, arch?: string): string;
/** DSH_HOME（与 setup.mjs / gq.mjs 同一条回落顺序）。 */
export declare function dshHome(): string;
/**
 * 二进制文件名（Windows 带 `.exe`）。
 * @param platform - 默认取 `process.platform`（测试可注入）。
 */
export declare function binaryName(platform?: string): string;
/**
 * 安装目录 —— **跨平台用户级 bin**。
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
export declare function userBinDir(platform?: string, env?: NodeJS.ProcessEnv, home?: string): string;
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
export declare function materializedPath(platform?: string, env?: NodeJS.ProcessEnv, home?: string): string;
/**
 * 目录是否在 PATH 上（Windows 不区分大小写；两侧都去掉尾部斜杠）。
 *
 * 用来决定要不要提示用户"把它加进 PATH"——`~/.local/bin` 在 Linux 上
 * 通常已在，Windows 的 `%USERPROFILE%\.local\bin` 通常不在。
 */
export declare function isOnPath(dir: string, env?: NodeJS.ProcessEnv, platform?: string): boolean;
/** 文件 sha256（小写十六进制）。 */
export declare function sha256Of(path: string): string | null;
/** 一次落地/定位的结果。 */
export interface McpBinaryReport {
    /** `vendored` = 用的是随包二进制；`path` = 回落到 PATH 上自带的；`missing` = 都没有。 */
    source: 'vendored' | 'path' | 'missing';
    /** 实际要执行的命令（preset 也指向这里）。 */
    command: string;
    /** 随包清单里是否有当前平台。 */
    bundledForPlatform: boolean;
    /** 本次是否重新拷贝了（false = 已是最新，直接复用）。 */
    copied: boolean;
    /** 安装目录是否在 PATH 上（不在就给用户加 PATH 的提示）。 */
    onPath: boolean;
    /** 人类可读的一句话，直接进 `/health` 与 `verify`。 */
    detail: string;
}
/**
 * 确保随包二进制落到 `materializedPath()`（**用户级 bin**），并返回它的状态。
 *
 * 幂等、可重复调用（装配时调一次即可自愈；每次会话不重复拷）。
 * **不抛异常**：装不上时降级并说明原因，绝不让插件树起不来。
 *
 * @param options.platform - 注入平台（测试用）。
 * @param options.env - 注入环境（测试用）。
 * @param options.home - 注入用户主目录（测试用）。
 */
export declare function ensureMaterialized(options?: {
    platform?: string;
    env?: NodeJS.ProcessEnv;
    home?: string;
}): McpBinaryReport;
/**
 * 找出「能力矩阵声明了、但随包二进制不提供」的工具。
 *
 * 这是**换错二进制的唯一可靠信号**：preset 的 `--enabled-toolsets` 是过滤器
 * 不是校验器，名字对不上只会静默少几个工具，界面上一点提示都没有。
 * @returns 缺失的工具名；清单不可用时返回 null。
 */
export declare function toolGapOf(manifest: McpManifest | null, enabledToolsets?: readonly string[]): string[] | null;
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
    manifest: {
        toolCount: number;
        forkCommit: string;
        goVersion: string;
    } | null;
    /** 当前平台在清单里的键，如 `linux-x64` / `win32-x64`。 */
    platform: string;
    /** 随包清单是否覆盖当前平台。 */
    bundled: boolean;
    /** 已落地的位置（preset 指向它）—— 是用户级 bin。 */
    target: string;
    /** 该文件是否存在。 */
    installed: boolean;
    /** 已落地的文件是否与清单的 sha256 一致。 */
    matchesManifest: boolean;
    /** 是否由 `MCP_GITEE_ENT_BIN` 指定了外部二进制。 */
    overridden: boolean;
    /** 安装目录是否在 PATH 上。 */
    onPath: boolean;
}
/** @see McpInspection */
export declare function inspectMcpBinary(): McpInspection;
