/**
 * dsh-gitee-chat · **host 半（profile bundle）**。
 *
 * 职责：
 *   1. 取数执行器（脚本执行 + 进程内缓存）
 *   2. 身份/人格解析器（进程级缓存；`systemPrompt.context` 是同步的，必须在装配外解析）
 *   3. 卡片数据通道 `/api/gitee-chat/*`
 *   4. 把 1&2 经 `ctx.provide('giteeChat', …)` 交给 agent 平面
 *   5. **公开 gateway**：一个进程级工具 `gitee_ent`（两级：list → schema → call），
 *      让**所有** preset 的 agent 都能用 Gitee 企业 MCP（用户 2026-10-10 口径）。
 *
 * ⚠️ 除第 5 条那**一个**工具外，本文件里不得注册任何 agent 可见的东西
 * （人格上下文、门禁、其他工具都不行）。host 半挂在 profile 里，注册即对
 * **所有 preset** 生效——早先版本把工具与人格注入写在这里，导致 PTC 等无关
 * preset 的新会话也被注入 Gitee 人格、也能看到 Gitee 工具。那些东西属于
 * agent 平面，见 `./agent`；第 5 条是**故意的例外**，理由与代价见 DESIGN.md §37。
 *
 * @module dsh-gitee-chat
 */

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from 'schemastery'
import { createGqRunner, defaultScriptPath, packageRoot } from './host/gq.ts'
import { createSnapshotStore } from './host/snapshotStore.ts'
import { createLocalSettings, type ResolvedSettings } from './host/localSettings.ts'
import { dshHome, ensureMaterialized, inspectMcpBinary, readManifest } from './host/mcpBinary.ts'
import { createRoleResolver } from './host/role.ts'
import { createEnterpriseIdResolver } from './host/enterpriseId.ts'
import { ROUTE_PREFIX, createRouteHandler } from './host/routes.ts'
import { createIssueWriter } from './host/write.ts'
import { createMcpDocs, type ToolsService } from './host/mcpDocs.ts'
import { createDocService, defaultDocsRoot } from './host/docService.ts'
import { TEXT_PREVIEW_EXT, extOf, readTextFile } from './host/docCache.ts'
import { createWikiCache, toWorkspacePath } from './host/wikiCache.ts'
import { resolveToken } from './host/token.ts'
import { trustedHostsOf } from './host/trustedHosts.ts'
import { createRepoService } from './host/repoService.ts'
import { createPrService } from './host/prService.ts'
import { createPrSubagentRunner } from './host/prSubagent.ts'
import { createPrTemplates } from './host/prTemplates.ts'
import { createMcpClient } from './host/mcpClient.ts'
import { giteeEntGatewayTool } from './host/gateway.ts'
import { DEFAULT_MCP_TOOL_PREFIX, PUBLIC_GATEWAY_TOOL_NAME } from './mcpNaming.ts'
import type { GiteeChatFace } from './host/face.ts'

/** 插件身份。 */
export const name = 'dsh-gitee-chat'

/** host 半只需要 HTTP 路由载体；可信 authority 列表用可选获取（`webStartup`，见 host/trustedHosts.ts）。 */
export const inject = ['webServer']

/** 包版本（被 /ping 回显）。
 *
 * **从 package.json 读**，不写死：写死会出现「代码说 0.2.0、包说 0.1.0」的漂移，
 * 而这正是排障时最需要可信的一个数字。读不到时回落到 `0.0.0`——冒烟测试会断言
 * 这个回落**不生效**（即真读到了版本），所以它只会以「测试红了」的形式暴露问题。
 */
export const VERSION: string = readPackageVersion()

/** 读本包 package.json 的 version 字段。 */
function readPackageVersion(): string {
  try {
    const text = readFileSync(join(packageRoot(), 'package.json'), 'utf8')
    const parsed = JSON.parse(text) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.trim() !== '' ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * agent 半的**组合行名**。
 *
 * 判定「这个会话是不是 Gitee 模式」不看 preset 叫什么名字，而是看这个 preset
 * 的组合里**有没有挂我们的 agent 行**——这是事实，不是命名约定。
 * 同事把自己的 preset 叫 `我的项目助手` 也能正常工作。
 */
export const AGENT_ROW_NAME = 'dsh-gitee-chat/agent'

/**
 * MCP 文档工具名的默认前缀。
 *
 * 唯一的真源在 `./mcpNaming`：agent 半的能力档门禁要用**同一条**前缀规则
 * （区分本插件的 Gitee 工具与同一个 preset 里别家 MCP server 的工具），
 * 而两个入口分别打包、不共享运行时模块。这里只再导出，保持既有公开路径。
 */
export { DEFAULT_MCP_TOOL_PREFIX }

/**
 * 我们用到的那几个 `agentPresets` 服务方法（**只声明用到的**，避免跟着上游全量签名走）。
 *
 * ⚠️ 版本坑（2026-09-28 实测，DESIGN.md §30）：0.1.6 及以前读一个 preset 的组合文本是
 * `read(id) → string`；**0.1.7 起这个方法没了**，改成：
 *   - `readDocument(id) → { content }` —— 声明文本（entry-list YAML）
 *   - `compositionInventory() → AgentPresetComposition[]` —— 结构化插件行（带求值后的 enabled）
 * 旧代码调 `service.read(...)` 得到 `undefined`、被 catch 吃掉 → `gitee: null` →
 * 界面永远显示「本会话未使用 Gitee 模式」，**哪怕当前 preset 就是 gitee-manager**。
 * 这种"方法变名"不会报错，只会静默判错 —— 所以两条路都要探到。
 */
interface AgentPresetsService {
  /** 0.1.7+：结构化插件行清单（一个 preset 一项）。 */
  compositionInventory?: () => Promise<ReadonlyArray<{
    id?: string
    /** preset 的行读不出来时的原因（装了 / 被拒 / 组合坏了）。 */
    broken?: string
    rows?: ReadonlyArray<{ moduleName?: string; enabled?: boolean | string }>
  }> | undefined>
  /** 0.1.7+：单个 preset 的声明（`content` 是 entry-list YAML）。 */
  readDocument?: (id: string) => Promise<{ content?: string } | undefined>
}

/** host 平面配置（部署级：连哪个企业、脚本在哪、怎么取数）。 */
export interface Config {
  /** Gitee 企业版 API base。 */
  apiBase?: string
  /** 传给 gq 脚本的同参数短时缓存秒数（0=关闭）。仅写 /tmp，不是数据库。 */
  cacheTtlSeconds?: number
  /** 单次脚本执行超时（毫秒）。 */
  scriptTimeoutMs?: number
  /** 无 token 时是否降级为样例数据渲染（仅用于验证 UI；生产建议 false）。 */
  allowFixtureFallback?: boolean
  /** 覆盖 gq 脚本路径（默认包内 scripts/gitee/gq.mjs）。 */
  scriptPath?: string
  /**
   * 固定使用的企业 id。0/不填 = 让脚本解析：只有一个企业时自动使用；
   * 多个企业时**报错要求显式指定**（静默挑一个会拿错公司的数据）。
   * 不想重启就切换：改 `$DSH_HOME/.gitee-chat/config.json` 或 `gq enterprises --use <id>`。
   */
  enterpriseId?: number
  /** 身份/人格解析结果的缓存时长（秒，默认 600）。 */
  roleTtlSeconds?: number
  /** 人格模式：auto（默认，按身份推导）/ manager / project / exec（人工强制）。 */
  mode?: 'auto' | 'manager' | 'project' | 'exec'
  /** 企业版端点要求的应用标识 UA（默认内置；换 MCP 版本/平台时覆盖）。 */
  userAgent?: string
  /** 是否开启写通道（改状态 / 评论 / 改派）。只读部署设 false。 */
  allowWrites?: boolean
  /**
   * 显式声明哪些 preset id 属于 Gitee 模式。
   * 留空（默认）= 按**事实**判定：preset 的组合里挂了 `agentRowName` 那一行。
   */
  presetIds?: string[]
  /** 组合里代表本插件的行名（默认 `dsh-gitee-chat/agent`）。 */
  agentRowName?: string
  /**
   * 知识库文档（见 `DOCS.md`）。
   *
   * 这里**没有任何端点配置** —— 文档能力的唯一实现是 MCP，
   * 插件只配置"缓存在哪、工具叫什么名字"。
   */
  docs?: {
    /** 本地缓存根（默认 `$DSH_HOME/gitee/docs`）。 */
    root?: string
    /**
     * MCP 工具名前缀（默认 `mcp__gitee_ent__`）。
     * 必须与 preset 里 `mcp-gitee` 行的 `serverName` 一致（当前是 `gitee_ent`）。
     */
    mcpToolPrefix?: string
    /** 读本地前是否先跑一次一致性核对（默认 true）。 */
    autoCheckOnRead?: boolean
    /** 单页正文落盘上限（字符，默认 200000）。 */
    maxPageBytes?: number
  }
  /** 部署级阈值覆盖（等价于对应的 GITEE_CHAT_* 环境变量，但不必重启）。 */
  thresholds?: {
    stallDays?: number
    overloadOpen?: number
    overloadOverdue?: number
    requiredLabels?: number
    weeklyCapacity?: number
    trendWeeks?: number
    milestoneRiskDays?: number
  }
  /**
   * 看板快照缓存（用户口径 m02223）。
   *
   * 三层：进程内 → 落盘 → 现拉。命中即省一次「4 页工作项 + 成员 + PR」往返；
   * **所有命中都会带上 `fetchedAt / ageSeconds / stale`**，让界面和 AI 都知道
   * 自己看到的是不是旧数据（提醒义务，见 `SKILL.md` 的「数据时效」）。
   */
  cache?: {
    /** 会话里的 AI 是否可读快照（默认 true；关掉 = 只给界面用）。 */
    agentReadable?: boolean
    /** 是否落盘（默认 true；关掉 = 只有进程内缓存，重启即冷启）。 */
    persist?: boolean
    /** 新鲜期秒数（默认 60，最小 10；小于 10 按 10 算，0 视为关闭缓存）。 */
    ttlSeconds?: number
  }
  /**
   * 后台定期刷新（默认**关**）。
   *
   * 开着时每 `intervalSeconds` 秒把看板快照拉一遍，让人打开面板就是热的；
   * 代价是持续的 Gitee 限流额度，所以默认关、默认 60 s、最小 10 s，
   * 且 `idleMinutes` 内没人用过面板就**不刷**（没人看时别翻页）。
   */
  autoRefresh?: {
    enabled?: boolean
    /** 刷新间隔秒数（默认 60，最小 10）。 */
    intervalSeconds?: number
    /** 多久没人用面板就暂停刷新（默认 30 分钟）。 */
    idleMinutes?: number
  }
}

/** Loader 用的校验模式（字段都可选，缺省由 resolveConfig 兜底）。 */
export const Config: z<Config> = z.object({
  apiBase: z.string(),
  cacheTtlSeconds: z.number(),
  scriptTimeoutMs: z.number(),
  allowFixtureFallback: z.boolean(),
  scriptPath: z.string(),
  enterpriseId: z.number(),
  roleTtlSeconds: z.number(),
  mode: z.string(),
  userAgent: z.string(),
  allowWrites: z.boolean(),
  presetIds: z.array(z.string()),
  agentRowName: z.string(),
  docs: z.object({
    root: z.string(),
    mcpToolPrefix: z.string(),
    autoCheckOnRead: z.boolean(),
    maxPageBytes: z.number(),
  }),
  thresholds: z.object({
    stallDays: z.number(),
    overloadOpen: z.number(),
    overloadOverdue: z.number(),
    requiredLabels: z.number(),
    weeklyCapacity: z.number(),
    trendWeeks: z.number(),
    milestoneRiskDays: z.number(),
  }),
  // ── 设置页表单（设置 → 插件 → Gitee 项目）────────────────────────────────
  //
  // 只有标了 `.volatile()` 的字段会被 `@deepseek-ai/dsh-settings` 投影成表单：
  // 它按 entry 的 Config schema 走 `volatileForm()`，没有 volatile 的字段一律不渲染
  // （0.5.4 之前这两组字段都没标，所以设置页是空的 —— 用户 2026-10-27 报的就是这个）。
  //
  // volatile 的含义还包括「改完不重挂插件」：所以下面 apply() 里对这些值的读取
  // **必须每次现取**（`live()` 辅助函数 + `setInterval(1000)` 的节拍检查），
  // 不能在装配期拍成快照，否则表单改了也不生效。
  cache: z.object({
    agentReadable: z.boolean()
      .default(true)
      .description('会话里的 AI 可以读看板快照（关掉 = 只能现拉，更慢但绝不读到旧数据）')
      .extra('volatile', true),
    persist: z.boolean()
      .default(true)
      .description('把快照落盘，重启后首屏不用再冷启一次')
      .extra('volatile', true),
    ttlSeconds: z.number()
      .default(60)
      .min(0)
      .max(3600)
      .description('新鲜期（秒）：60 内直接命中；改 0 关闭缓存；最小 10 秒')
      .extra('volatile', true),
  }),
  autoRefresh: z.object({
    enabled: z.boolean()
      .default(false)
      .description('后台定期刷新看板（只在最近有人看面板时才真去拉）')
      .extra('volatile', true),
    intervalSeconds: z.number()
      .default(60)
      .min(10)
      .max(3600)
      .description('刷新间隔（秒，最小 10）：越小越新鲜，但要吃 Gitee 限流额度')
      .extra('volatile', true),
    idleMinutes: z.number()
      .default(30)
      .min(1)
      .max(1440)
      .description('闲置多少分钟后暂停后台刷新（分钟）')
      .extra('volatile', true),
  }),
})

/**
 * 把字符串配置归一成「有值 / 未设」。
 *
 * **为什么不能直接用 `??`**：profile 补丁里同一 id 的 `config` 是**整体替换**，
 * 所以安装脚本必须写出完整配置；而「留空表示用默认值」这种键，写出来就是
 * `scriptPath: ''`。空串不是 nullish，`??` 会把它当成真值放过去，于是
 * `scriptPath` 变成 `''`，宿主执行 `node '' <子命令>` —— Node 把空脚本名
 * 当作「从 stdin 读」，stdin 又是空的，于是**退出码 0、零输出**，
 * 最终只在界面上留下一句莫名其妙的「gq 输出不是 JSON：」。
 *
 * 所以：空串与纯空白一律按「未设置」处理，`''` 与「这个键没写」语义相同。
 * @param value - 原始配置值。
 * @returns 去空白后的值，或 undefined。
 */
function nonBlank(value?: string): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 展开路径开头的 `~`（= 用户主目录，**不是** DSH_HOME）。
 *
 * 为什么要有这一步：配置是**人写的**，而 `~/.dsh/...` 是所有人写路径的肌肉记忆。
 * Node 不会展开 `~` —— 不处理的话会在工作目录下建一个名叫 `~` 的文件夹，
 * 症状是"文档读出来了但缓存找不到"，极难定位。
 * @param value - 原始路径。
 */
function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * 读一个「可能是 volatile ref」的配置值。
 *
 * 为什么需要它：设置页的字段标了 `.volatile()` 之后，cordis 传给插件的不再是
 * 普通值，而是带 `.get()` 的响应式引用（见 `@deepseek-ai/schemastery` 的
 * `Schema.prototype.volatile`）。同一份代码还要能被 `resolveConfig()` 之类
 * 直接调用 —— 那时拿到的就是普通值。两者用这一个函数统一。
 * @param value - 配置里的原始值（普通值或 ref）。
 * @param fallback - 缺失/取不到时的默认值。
 */
function liveRead<T>(value: unknown, fallback: T): T {
  if (value === undefined || value === null) return fallback
  const ref = value as { get?: () => unknown }
  if (typeof ref.get === 'function') {
    try {
      const next = ref.get()
      return next === undefined || next === null ? fallback : (next as T)
    } catch {
      return fallback
    }
  }
  return value as T
}

/** 补齐默认值（直接调用绕过 Loader 时同样成立）。 */
export function resolveConfig(config?: Config) {
  // 新鲜期：默认 60 s、最小 10 s；显式 0 表示关闭缓存（每次现拉）。
  const rawTtl = config?.cache?.ttlSeconds ?? 60
  const ttlSeconds = rawTtl === 0 ? 0 : Math.max(10, Math.floor(rawTtl))
  const refreshInterval = Math.max(10, Math.floor(config?.autoRefresh?.intervalSeconds ?? 60))
  const idleMinutes = Math.max(1, Math.floor(config?.autoRefresh?.idleMinutes ?? 30))
  return {
    apiBase: nonBlank(config?.apiBase) ?? 'https://api.gitee.com/enterprises',
    // 0.5.5+：老键继续认（显式给了就以它为准），否则用 cache.ttlSeconds。
    cacheTtlSeconds: config?.cacheTtlSeconds ?? ttlSeconds,
    scriptTimeoutMs: config?.scriptTimeoutMs ?? 60_000,
    allowFixtureFallback: config?.allowFixtureFallback ?? false,
    scriptPath: nonBlank(config?.scriptPath) ?? defaultScriptPath(),
    enterpriseId: config?.enterpriseId ?? 0,
    roleTtlSeconds: config?.roleTtlSeconds ?? 600,
    mode: nonBlank(config?.mode) ?? 'auto',
    // userAgent 的默认值就是空串，故这里不做区分，只做去空白。
    userAgent: nonBlank(config?.userAgent) ?? '',
    allowWrites: config?.allowWrites ?? true,
    presetIds: (config?.presetIds ?? []).filter((s) => typeof s === 'string' && s.trim() !== ''),
    agentRowName: nonBlank(config?.agentRowName) ?? AGENT_ROW_NAME,
    docs: {
      root: nonBlank(config?.docs?.root) === undefined
        ? defaultDocsRoot(dshHome())
        : expandHome(nonBlank(config?.docs?.root) as string),
      mcpToolPrefix: nonBlank(config?.docs?.mcpToolPrefix) ?? DEFAULT_MCP_TOOL_PREFIX,
      autoCheckOnRead: config?.docs?.autoCheckOnRead ?? true,
      maxPageBytes: config?.docs?.maxPageBytes ?? 200_000,
    },
    thresholds: config?.thresholds ?? {},
    cache: {
      agentReadable: config?.cache?.agentReadable ?? true,
      persist: config?.cache?.persist ?? true,
      ttlSeconds,
    },
    autoRefresh: {
      enabled: config?.autoRefresh?.enabled ?? false,
      intervalSeconds: refreshInterval,
      idleMinutes,
    },
  }
}

/** 解析后的配置。 */
export type ResolvedConfig = ReturnType<typeof resolveConfig>

// `TEXT_PREVIEW_EXT` / `extOf` / `readTextFile` 定义在 `host/docCache.ts` ——
// 宿主侧的附件读取与编排层都要用同一份（两份实现必然漂移）。

/**
 * 随包 MCP 是否声明了 `download_attach_file`（附件内容读取）。
 *
 * 为什么按**清单**判断而不是"试一下"：清单是构建期对着二进制逐个核过的
 * （`scripts/build-mcp.mjs --check`），所以它可信；而"试一下"要在装配期
 * 起一次 MCP 子进程，代价与副作用都不该出现在这里。
 *
 * 判 false 时界面会**明确显示"只能看结构与文件名"**，而不是给一个点了没反应的入口。
 */
function attachmentReaderAvailable(): boolean {
  try {
    const manifest = readManifest()
    return manifest !== undefined && Array.isArray(manifest.tools) && manifest.tools.includes('download_attach_file')
  } catch {
    return false
  }
}

/**
 * 阈值 → 环境变量的名字。
 * 宿主把配置里的阈值翻译成脚本认识的环境变量，**单一真源仍在脚本**。
 */
const THRESHOLD_ENV: Record<string, string> = {
  stallDays: 'GITEE_CHAT_STALL_DAYS',
  overloadOpen: 'GITEE_CHAT_OVERLOAD_OPEN',
  overloadOverdue: 'GITEE_CHAT_OVERLOAD_OVERDUE',
  requiredLabels: 'GITEE_CHAT_REQUIRED_LABELS',
  weeklyCapacity: 'GITEE_CHAT_WEEKLY_CAPACITY',
  trendWeeks: 'GITEE_CHAT_TREND_WEEKS',
  milestoneRiskDays: 'GITEE_CHAT_MILESTONE_RISK_DAYS',
}

/**
 * 把配置里的阈值与 UA 翻译成子进程环境变量。
 * 只加自己认识的键，不改动、不清理继承来的环境。
 */
export function childEnvOverrides(resolved: ResolvedConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  if (resolved.userAgent !== '') env.GITEE_ENT_USER_AGENT = resolved.userAgent
  for (const [key, envName] of Object.entries(THRESHOLD_ENV)) {
    const value = (resolved.thresholds as Record<string, unknown>)[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) env[envName] = String(value)
  }
  return env
}

/**
 * 判断一段 preset 组合文本里是否挂了指定的行。
 *
 * 用文本匹配而不是 YAML 解析：组合文件是较小的受控输入，且加一个 YAML
 * 依赖只为读一个 `name:` 不划算。匹配限定在 `name:` 这一行的整行，
 * 避免命中注释或别处的同名子串。
 */
export function compositionMountsRow(text: string, rowName: string): boolean {
  const escaped = rowName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 组合里的行写成 `- name: 'x'`；`- ` 前缀必须有，否则一行都匹配不上
  // （冒烟测试第一次跑就抓到了这个：只写 `[ \t]*name:` 会全部漏判）。
  return new RegExp(`^[ \\t]*(?:-[ \\t]+)?name:[ \\t]*['"]?${escaped}['"]?[ \\t]*$`, 'm').test(text)
}

/**
 * host 半插件主体：装配执行器与解析器、挂路由、发布服务。
 * @param ctx - cordis 上下文（需要 webServer）。
 * @param config - Loader 传入的原始配置。
 */
export function apply(ctx: any, config?: Config): void {
  const resolved = resolveConfig(config)

  /**
   * 「当前生效的企业 id」——**全插件只有这一个解析器**。
   *
   * 顺序（flag → env → 本地配置 → 唯一企业自动）与 `scripts/gitee/gq.mjs` 逐条对齐，
   * 见 `host/enterpriseId.ts`。要点：**凡是要发给 MCP 的 enterprise_id 都从这里现取**，
   * 不能再把补丁里的"钉住值"直接透传 —— 那个值默认是 0，而 MCP 收到 0 会直接 401
   * （2026-10-12 的仓库/知识库面板全挂就是这条）。
   */
  const enterprise = createEnterpriseIdResolver({ pinned: resolved.enterpriseId })

  /**
   * 缓存三件套的**实时**取值（设置页 volatile 字段）。
   *
   * 每次现取而不是装配期快照：用户在「设置 → 插件 → Gitee 项目」改完就生效，
   * 不需要重启桌面（用户 2026-10-27 口径：可配置 + 秒级 + 要有提醒）。
   */
  /** 补丁里的静态配置（本地没覆盖时用它）。 */
  const staticSettings = (): ResolvedSettings => {
    const legacy = config?.cacheTtlSeconds
    const rawTtl = typeof legacy === 'number' ? legacy : liveRead<number>(config?.cache?.ttlSeconds, 60)
    const ttlSeconds = !Number.isFinite(rawTtl) || rawTtl <= 0 ? 0 : Math.max(10, Math.floor(rawTtl))
    return {
      cache: {
        agentReadable: liveRead<boolean>(config?.cache?.agentReadable, true) !== false,
        persist: liveRead<boolean>(config?.cache?.persist, true) !== false,
        ttlSeconds,
      },
      autoRefresh: {
        enabled: liveRead<boolean>(config?.autoRefresh?.enabled, false) === true,
        intervalSeconds: Math.max(10, Math.floor(liveRead<number>(config?.autoRefresh?.intervalSeconds, 60))),
        idleMinutes: Math.max(1, Math.floor(liveRead<number>(config?.autoRefresh?.idleMinutes, 30))),
      },
    }
  }

  /**
   * 缓存开关的生效值：**本地覆盖（设置页那几个开关）优先**，否则用补丁里的静态配置。
   *
   * 每次现取：设置页点保存 → 写 `$DSH_HOME/.gitee-chat/config.json` → 下一次取数就按新值，
   * 不用重启桌面（用户 2026-10-27 口径）。
   */
  const localSettings = createLocalSettings(join(dshHome(), '.gitee-chat'))
  const liveSettings = (): ResolvedSettings => localSettings.resolve(staticSettings())
  const liveCache = () => liveSettings().cache
  const liveAutoRefresh = () => liveSettings().autoRefresh

  const runner = createGqRunner({
    scriptPath: resolved.scriptPath,
    timeoutMs: resolved.scriptTimeoutMs,
    apiBase: resolved.apiBase,
    allowFixtureFallback: resolved.allowFixtureFallback,
    enterpriseId: resolved.enterpriseId,
    env: childEnvOverrides(resolved),
    // 新鲜期现取（`cache.ttlSeconds`：默认 60 s、最小 10 s，0 = 关闭缓存）
    memoTtlMs: () => liveCache().ttlSeconds * 1000,
    // 落盘快照：重启后首屏不必再冷启一次（`cache.persist` 关掉就只有进程内缓存）
    persist: createSnapshotStore(join(dshHome(), '.gitee-chat', 'cache', 'board'), ctx.logger),
    persistEnabled: () => liveCache().persist,
  })

  // 后台定期刷新（默认关）。
  //
  // 用 1 秒的节拍器 + 「到点才拉」而不是 setInterval(intervalSeconds)：间隔是设置页
  // 里的 volatile 字段，用户随时改；setInterval 的周期一旦建立就固定了。
  // 闸门仍然保留：没人看面板（闲置超过 idleMinutes）就一次也不拉，
  // 否则每 60 秒打 4 页 Gitee 纯烧限流额度。
  {
    let lastRunAt = 0
    const ticker = setInterval(() => {
      const { enabled, intervalSeconds, idleMinutes } = liveAutoRefresh()
      if (!enabled) return
      const now = Date.now()
      if (now - lastRunAt < intervalSeconds * 1000) return
      if (runner.idleMs() > idleMinutes * 60_000) return
      lastRunAt = now
      void runner.run({ scope: 'portfolio', refresh: true }).catch((error: unknown) => {
        ctx.logger?.warn?.(`[${name}] 自动刷新失败：${String(error)}`)
      })
    }, 1000)
    ticker.unref?.()
    ctx.effect(() => () => clearInterval(ticker))
  }

  if (!runner.scriptExists()) {
    ctx.logger?.warn?.(`[${name}] gq 脚本不存在：${runner.scriptPath}（取数会失败，可检查安装是否完整）`)
  }

  // 随包 MCP 二进制落地：让同事不需要 Go 环境。
  //
  // 放在装配期做（而不是只在安装期做）是为了**自愈**：手工拷过来的包、
  // 被清过用户级 bin（Linux `~/.local/bin`、Windows `%USERPROFILE%\.local\bin`）的机器、
  // 换了新版本的二进制，下一次启动就自动补上；0.5.0 的私有副本
  // （`$DSH_HOME/.gitee-chat/bin/`）也在这一步被迁移清掉。
  // 幂等，且内容一致时直接复用不重复拷。
  //
  // 注意这里**不比对工具清单**：清单是构建期校验过的（scripts/build-mcp.mjs
  // 会对着 preset 的 --enabled-toolsets 逐个核），所以只要 sha256 对得上清单，
  // "少工具"就不可能发生。真正要防的是**二进制被换过**，那由
  // `inspectMcpBinary().matchesManifest` 报出来。
  const mcp = ensureMaterialized()
  if (mcp.source === 'vendored' && mcp.copied) ctx.logger?.info?.(`[${name}] ${mcp.detail}`)
  else if (mcp.source !== 'vendored') ctx.logger?.warn?.(`[${name}] ${mcp.detail}`)

  // 身份/人格解析器：进程级缓存 + 挂载即预热，供 agent 平面的同步 provider 取用
  const role = createRoleResolver({
    runner,
    ttlMs: resolved.roleTtlSeconds * 1000,
    mode: resolved.mode,
  })
  role.prime()

  // ── 公开 gateway（本文件唯一的 agent 可见出口）───────────────────────────
  //
  // 背景：Gitee 企业 MCP 是工具类后端，不该只属于 Gitee 人格（用户 2026-10-10 口径）。
  // 但全量 51 个工具 ≈ 52.4 KB ≈ 16.4K tokens/请求，而 DSH 的 `deferLoading` 只能
  // 「延迟发送定义」、不能「按需加载」，所以这里只常驻**一个**两级入口：
  //   op=list（目录 ~1.1K tokens，用到才进上下文）→ op=schema → op=call。
  // Gitee preset 里由 agent 半 `ctx.tools.restrict` 把它隐藏，改回原生工具。
  // 完整取舍见 DESIGN.md §37。
  const gatewayEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...childEnvOverrides(resolved) }
    const token = resolveToken()
    if (token !== '') env.GITEE_ENT_MCP_ACCESS_TOKEN = token
    // 生效企业（不只是"钉住值"）：模型经 gateway 调 MCP 时若没自己带 enterprise_id，
    // 二进制就回落到这个环境变量。多企业且没指定时 `now().id` 是 0 —— 那就不设，
    // 让模型自己去 `list_enterprises` 选，**绝不替它猜一家**。
    const effectiveEnterpriseId = enterprise.now().id
    if (effectiveEnterpriseId > 0) env.GITEE_ENT_ID = String(effectiveEnterpriseId)
    return env
  }
  ctx.inject(['tools'], (child: any) => {
    child.effect(() => {
      const client = createMcpClient({
        command: mcp.command ?? '',
        env: gatewayEnv(),
        timeoutMs: resolved.scriptTimeoutMs,
        clientVersion: VERSION,
        logger: ctx.logger,
      })
      const tool = giteeEntGatewayTool({
        client,
        allowWrites: resolved.allowWrites,
        runtimeWrites: () => role.current()?.writes ?? [],
        // 现取（不是注册那一刻的快照）：企业可以在设置里随时切换，目录抬头要跟着变。
        // 解析不出来时 `id` 是 0 —— 那时抬头写"先 list_enterprises"，绝不写成 `enterprise_id: 0`。
        enterpriseSelector: () => ({ id: enterprise.now().id, describe: enterprise.describe() }),
      })
      const unregister = child.tools.register(tool)
      ctx.logger?.info?.(
        `[${name}] 公开 gateway 已注册：${PUBLIC_GATEWAY_TOOL_NAME}（两级 list → schema → call；`
        + `${resolved.allowWrites ? '可写' : '只读，写工具硬拦'}）`,
      )
      return () => {
        unregister?.()
        client.dispose()
      }
    })
  })

  // 会话 → preset 跟踪：整屏视图只在 Gitee 模式的会话里渲染。
  // 客户端插件在 profile 层，它注册的 conversation.view 对所有 preset 可见，
  // 所以"这个会话是不是 Gitee 模式"必须由 host 侧回答。
  const sessionPresets = new Map<string, string>()
  ctx.effect(() => ctx.on('agent-preset/selected', (sessionId: string, agentPreset: string) => {
    sessionPresets.set(sessionId, agentPreset)
  }))
  ctx.effect(() => ctx.on('session/disposed', (_this: unknown, session: { id: string }) => {
    sessionPresets.delete(session.id)
  }))

  /**
   * 解析一个会话的 preset：先查事件表，再回落到 live agent 的组合信息。
   * 两条路都走，避免"事件没覆盖到初始选择"这类盲区。
   */
  const presetOf = (sessionId: string): string | null => {
    const known = sessionPresets.get(sessionId)
    if (known !== undefined) return known
    try {
      const agents = ctx.get('agents') as { get: (id: string) => { ctx: unknown } | undefined } | undefined
      const presets = ctx.get('agentPresets') as { composedPreset: (c: unknown) => string | undefined } | undefined
      const agent = agents?.get(sessionId)
      if (agent !== undefined && presets !== undefined) {
        return presets.composedPreset(agent.ctx) ?? null
      }
    } catch {
      /* 回查失败按未知处理 */
    }
    return null
  }

  // ── 「这个 preset 是不是 Gitee 模式」────────────────────────────────────
  //
  // 早先按命名前缀判定（`preset.startsWith('gitee-')`）。那是**硬编码的命名约定**：
  // 同事把 preset 命名成「我的项目助手」就失效了。现在按**事实**判定——
  // 问 `agentPresets` 服务：这个 preset 的插件行里有没有本插件的 agent 行
  // （结构化清单优先，声明文本退路；见 `presetMountsAgentRow` 与 DESIGN.md §30）。
  //
  // 判定结果带短 TTL 缓存：组合是可编辑的，改完不该等到重启才生效，
  // 但也不该每渲染一次标签页就读一次盘。
  const PRESET_CACHE_TTL_MS = 30_000
  const presetIsGitee = new Map<string, { value: boolean; at: number }>()

  /** 读一个 preset 的组合文本（拿不到返回 null）。 */
  async function readComposition(preset: string): Promise<string | null> {
    try {
      const service = ctx.get('agentPresets') as AgentPresetsService | undefined
      if (service === undefined) return null
      // 0.1.7 起：`readDocument(id)` → `{ content }`（entry-list YAML，!!js 表达式原样）。
      if (typeof service.readDocument === 'function') {
        const doc = await service.readDocument(preset)
        const content = doc?.content
        return typeof content === 'string' ? content : null
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * 「这个 preset 挂没挂本插件的 agent 行」——判定 Gitee 模式的**唯一事实**。
   *
   * 两条路，都问同一个服务：
   *  1. `compositionInventory()`（0.1.7+，**首选**）：结构化插件行，带 Loader 求值过的
   *     `enabled`（`!!js disabled` 未求值时是 `'conditional'`）——比文本匹配结实得多。
   *  2. `readDocument(id).content` + 文本匹配：清单里查不到这个 preset 时的退路。
   *
   * @returns true/false；两条路都读不出来时返回 null（= 未知，视图给提示而不是猜）。
   */
  async function presetMountsAgentRow(preset: string): Promise<boolean | null> {
    const service = ctx.get('agentPresets') as AgentPresetsService | undefined
    if (service === undefined) return null

    if (typeof service.compositionInventory === 'function') {
      try {
        const inventory = await service.compositionInventory()
        const entry = Array.isArray(inventory) ? inventory.find((c) => c?.id === preset) : undefined
        if (entry !== undefined) {
          // `broken` = 这个 preset 的行读不出来（组合装了 / 插件被拒）。未知，不猜。
          if (typeof entry.broken === 'string') return null
          const rows = Array.isArray(entry.rows) ? entry.rows : []
          return rows.some((row) => row?.moduleName === resolved.agentRowName && row?.enabled !== false)
        }
      } catch {
        /* 落到文本判据 */
      }
    }

    const text = await readComposition(preset)
    if (text === null) return null
    return compositionMountsRow(text, resolved.agentRowName)
  }

  /**
   * 判定一个 preset id 是不是 Gitee 模式。
   * @param preset - preset id
   */
  async function isGiteePreset(preset: string | null | undefined): Promise<boolean | undefined> {
    if (typeof preset !== 'string' || preset === '') return undefined
    // 1) 显式配置最优先：部署说了算，不需要读盘
    if (resolved.presetIds.length > 0) return resolved.presetIds.includes(preset)

    // 2) 事实判定，带短 TTL 缓存
    const hit = presetIsGitee.get(preset)
    if (hit !== undefined && Date.now() - hit.at < PRESET_CACHE_TTL_MS) return hit.value

    const value = await presetMountsAgentRow(preset)
    if (value === null) {
      // 组合读不到（服务缺失 / 方法变名 / preset 的行读不出来）→ 判定为未知，
      // 视图给提示而不是报错。不猜、不静默按 true 处理，避免在无关会话里渲染 Gitee 数据。
      return undefined
    }
    presetIsGitee.set(preset, { value, at: Date.now() })
    return value
  }

  // ── 知识库文档（host 平面：只编排，不实现端点）──────────────────────────
  //
  // 纪律见 DOCS.md §7：**MCP 是文档能力的唯一实现**。这个委派层只做一件事——
  // 按 sessionId 解析出 agent 作用域，然后调 `mcp__gitee_ent__*`。
  //
  // 为什么要 agent 作用域：MCP 行挂在 preset 里，工具**不在全局视角**可见；
  // 不带 agent 调 `tools.execute` 会得到 UNKNOWN_TOOL。这与「客户端拿不到会话的
  // preset」是同一类事实（DESIGN.md §12），同样由 host 按 sessionId 解析。
  const agentOf = (sessionId: string): unknown | undefined => {
    try {
      const agents = ctx.get('agents') as { get?: (id: string) => unknown } | undefined
      return agents?.get?.(sessionId)
    } catch {
      return undefined
    }
  }
  const toolsService = (): ToolsService | undefined => {
    try {
      return ctx.get('tools') as ToolsService | undefined
    } catch {
      return undefined
    }
  }

  /**
   * 按会话取工作目录（权威 cwd 在会话 header 上，与侧边栏同源）。
   *
   * 用**可选获取**而不是 `inject`：拿不到就返回空串，功能降级成
   * "只给缓存绝对路径"（侧边栏会因围栏拒绝），而不是让整个插件卡在 waiting。
   * @param sessionId - 会话 id。
   */
  const cwdOf = (sessionId: string): string => {
    try {
      const sessions = ctx.get('sessions') as { get?: (id: string) => { header?: { cwd?: string } } | undefined } | undefined
      const cwd = sessions?.get?.(sessionId)?.header?.cwd
      return typeof cwd === 'string' ? cwd : ''
    } catch {
      return ''
    }
  }

  /**
   * WIKI 缓存（git 形态）。**这是唯一不走 MCP 的取数口** ——
   * Gitee 没有任何 HTTP 接口能列仓库 WIKI（实测企业 API 全 404、开放 API 405），
   * 详见 `host/wikiCache.ts` 与 `DOCS.md` §14.1。
   */
  const wikiCache = createWikiCache({
    cacheRoot: resolved.docs.root,
    // 现取而不是缓存进闭包：令牌轮换后闭包会一直用旧的。
    // 解析顺序（环境变量 → 设置界面写的 token 文件）见 ./host/token.ts ——
    // 只读环境变量会让「界面里配好 token、wiki 却说没令牌」。
    token: () => resolveToken(),
    log: (message) => ctx.logger?.info?.(message),
  })
  /**
   * 直连 MCP 的环境：与公开 gateway 同一套规则（token 解析顺序、生效企业）。
   *
   * 为什么要这份：PR / 文档面板的数据**不该**依赖「当前会话挂了 Gitee preset」——
   * 用户 2026-10-26 明确「任何模式都可以，而不是必须 agent 预设选 gitee 项目会话模式」。
   */
  const hostMcpEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...childEnvOverrides(resolved) }
    const token = resolveToken()
    if (token !== '') env.GITEE_ENT_MCP_ACCESS_TOKEN = token
    const id = enterprise.now().id
    if (id > 0) env.GITEE_ENT_ID = String(id)
    return env
  }
  /**
   * 进程级 MCP 客户端（host 自己用）：懒启动、可重启，退出时释放。
   *
   * 它与 `ctx.inject(['tools'])` 里那个 gateway 客户端**各用一个子进程**：
   * 一个是给模型的两级入口（受 `allowWrites` 与档位约束），
   * 一个是给面板取数（只读数据 + 由路由自己判写），混用会让权限语义糊掉。
   */
  //
  // 冒烟/单测用一个假 ctx 跑 apply（没有真 MCP 进程可用）：那时直连通道会把每个文档请求
  // 都变成一次真子进程调用（还会去连网），测试既慢又不稳。因此留一个显式开关
  // `GITEE_CHAT_NO_DIRECT=1` 关掉它 —— 只给测试用，正常运行不设。
  const directEnabled = process.env.GITEE_CHAT_NO_DIRECT !== '1'
  const dataClient = directEnabled
    ? createMcpClient({
      command: mcp.command ?? '',
      env: hostMcpEnv(),
      timeoutMs: resolved.scriptTimeoutMs,
      clientVersion: VERSION,
      logger: ctx.logger,
    })
    : undefined
  if (dataClient !== undefined) ctx.on?.('dispose', () => dataClient.dispose())

  const mcpDocs = createMcpDocs({
    agentOf,
    tools: toolsService,
    toolPrefix: resolved.docs.mcpToolPrefix,
    enterprise,
    ...(dataClient === undefined ? {} : { direct: dataClient }),
    timeoutMs: resolved.scriptTimeoutMs,
  })
  /**
   * 附件内容读取：**委派 MCP 的 `download_attach_file`**（本 fork 独有）。
   *
   * 插件**不自己取** `/{eid}/attach_files/{file_id}` —— 那是 MCP 的事（DOCS.md §7）。
   * 插件只做三件本地事：算缓存目录、把 `workspace` 指到缓存根（沙箱上限）、
   * 把落盘的文件读回文本。
   *
   * 只有**随包清单里声明了这个工具**时才启用；没声明就返回 undefined，
   * 界面随即显示"只能看结构与文件名" —— 不假装能读。
   */
  const attachmentReader = attachmentReaderAvailable()
    ? async (input: {
      sessionId: string
      nodeId: number
      fileName: string
      fileId: number
      programId: number | null
      cacheDir: string
    }) => {
      const downloaded = await mcpDocs.downloadAttachFile(input.sessionId, {
        fileId: input.fileId,
        outputDirectory: input.cacheDir,
        // ⚠️ 必须显式传：缓存根在会话工作区之外，目录作用域由这个参数决定。
        workspace: resolved.docs.root,
        overwrite: true,
      })
      const ext = extOf(input.fileName)
      const text = TEXT_PREVIEW_EXT.has(ext) ? readTextFile(downloaded.savedPath, resolved.docs.maxPageBytes) : undefined
      return {
        savedPath: downloaded.savedPath,
        bytes: downloaded.bytes,
        contentType: downloaded.contentType,
        ext,
        content: text === undefined ? null : text.content,
        truncated: text?.truncated ?? false,
      }
    }
    : undefined

  const docService = createDocService({
    docs: mcpDocs,
    cacheRoot: resolved.docs.root,
    maxPageChars: resolved.docs.maxPageBytes,
    ...(attachmentReader === undefined ? {} : { readAttachmentContent: attachmentReader }),
    // 工作区软链接：侧边栏（dsh-better-sidebar）的文件围栏按**会话 cwd**判定，
    // 而缓存根在工作区之外 —— 没有这条软链接，交给侧边栏的路径会被 403 拒绝。
    cwdOf,
    workspaceLink: (cwd) => wikiCache.workspaceLink(cwd),
    toWorkspacePath: (link, absolute) => toWorkspacePath(link, resolved.docs.root, absolute),
  })

  const repoService = createRepoService({
    docs: mcpDocs,
    wiki: wikiCache,
    cwdOf,
  })

  // 合并请求（0.5.4）：模板走文件（随包内置 + 用户副本 + 仓库绑定），PR 数据走 MCP。
  const prService = createPrService({
    docs: mcpDocs,
    templates: createPrTemplates(),
    // 分支比对（AI 起草 PR 内容）默认走取数脚本：MCP 没有 compare 工具。
    runner,
    // 会话工作目录：起草时先看本地有没有这个仓库的克隆，有就走本地 git（毫秒级）。
    cwdOf,
  })
  /**
   * AI 审核的执行体：在所选主会话下起子智能体（用户 2026-10-26 口径）。
   *
   * 服务是懒取的：`ctx.get('subagents')` 在装配期可能还没注册完，
   * 且老宿主根本没有这两个服务（那时 start() 会报 no-subagents）。
   */
  const prSubagent = createPrSubagentRunner({
    subagents: () => ctx.get('subagents') as never,
    agents: () => ctx.get('agents') as never,
    logger: ctx.logger as never,
  })
  ctx.effect(() => () => prSubagent.dispose())
  ctx.logger?.info?.(
    `[${name}] 文档委派就绪 · 工具前缀 ${resolved.docs.mcpToolPrefix} · 缓存 ${resolved.docs.root}`
    + ` · 附件内容读取 ${attachmentReader === undefined ? '未启用（随包清单没有 download_attach_file）' : '已启用'}`,
  )

  // **唯一写入口**：所有改动作都从这里出去（见 host/write.ts 的纪律说明）。
  const writer = createIssueWriter({ runner, enabled: resolved.allowWrites, docs: mcpDocs })
  if (!resolved.allowWrites) {
    ctx.logger?.warn?.(`[${name}] 写通道已关闭（allowWrites=false）：界面上的改状态/评论/改派按钮会明确报错。`)
  }

  /**
   * 可选投递目标的会话清单（供 PR 面板「AI 审核投递到哪个会话」）。
   *
   * ⚠️ `ctx.sessions.list()` 的语义是「**活着的**会话」（SessionStore.list = all live
   * sessions），桌面端同时只活一个会话，所以只读它永远只能拿到 1 条 —— 用户问
   * 「是不是 DSH 不让读工作区和会话名」就是撞上这个坑。
   *
   * 真正的全量清单在 `$DSH_HOME/storages/session_projcache/sessions/<id>.json`
   * （桌面端会话列表用的同一份投影缓存：identity.cwd、rows.title.val、
   * rows.sessionListMetadata.val.{blank,lastPromptAt}；子智能体会话的
   * rows.subagent.val.identity 非空，要排除）。只读每个文件头部，不整读。
   *
   * 排序：最近使用过的排前面；从没用过的空会话（meta.blank）不进列表。
   */
  const listSessions = (): Array<{
    id: string
    title: string
    cwd: string
    preset: string | null
    workspaceId: string | null
    workspaceTitle: string
  }> => {
    try {
      interface Row {
        id: string
        title: string
        cwd: string
        lastAt: number
        live: boolean
      }
      const rows = new Map<string, Row>()

      // ① 历史会话：逐个读会话投影缓存（桌面端会话列表的同一份数据）
      try {
        const cacheDir = join(dshHome(), 'storages', 'session_projcache', 'sessions')
        const head = 512 * 1024 // 每份缓存最多读 512 KiB，标题总在里面
        const entries = readdirSync(cacheDir)
          .filter((name) => name.endsWith('.json'))
          .map((name) => {
            const file = join(cacheDir, name)
            let at = 0
            try {
              at = statSync(file).mtimeMs
            } catch {
              at = 0
            }
            return { file, name, at }
          })
          .sort((a, b) => b.at - a.at)
          .slice(0, 400)
        for (const entry of entries) {
          let text = ''
          try {
            const fd = openSync(entry.file, 'r')
            try {
              const buffer = Buffer.alloc(head)
              const read = readSync(fd, buffer, 0, head, 0)
              text = buffer.subarray(0, read).toString('utf8')
            } finally {
              closeSync(fd)
            }
          } catch {
            continue
          }
          // 子智能体（subagent）不是投递目标，排除
          if (/"subagent":\s*\{[\s\S]{0,200}?"val":\s*\{\s*"identity"/.test(text)) continue
          if (/"blank":\s*true/.test(text)) continue
          const id = entry.name.replace(/\.json$/, '')
          const cwd = /"cwd":\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? ''
          const titleRaw = /"title":\s*\{\s*"ver":\s*\d+,\s*"seq":\s*\d+,\s*"val":\s*("(?:[^"\\]|\\.)*"|null)/.exec(text)?.[1]
          let title = ''
          if (titleRaw !== undefined && titleRaw !== 'null') {
            try {
              title = JSON.parse(titleRaw) as string
            } catch {
              title = titleRaw.slice(1, -1)
            }
          }
          rows.set(id, {
            id,
            title,
            cwd: cwd.replace(/\\"/g, '"').replace(/\/\\/g, '\\'),
            lastAt: entry.at,
            live: false,
          })
        }
      } catch {
        // 读不到缓存目录（老版本 / 权限）就只靠活会话
      }

      // ② 活会话覆盖（内存里的标题/预设最新）
      try {
        const service = ctx.get('sessions') as { list?: () => unknown[] } | undefined
        for (const raw of service?.list?.() ?? []) {
          const session = raw as { id?: string; header?: { title?: string; cwd?: string } }
          const id = typeof session.id === 'string' ? session.id : ''
          if (id === '') continue
          const known = rows.get(id)
          rows.set(id, {
            id,
            title: typeof session.header?.title === 'string' && session.header.title !== ''
              ? session.header.title
              : (known?.title ?? ''),
            cwd: typeof session.header?.cwd === 'string' && session.header.cwd !== ''
              ? session.header.cwd
              : (known?.cwd ?? ''),
            lastAt: Math.max(known?.lastAt ?? 0, Date.now()),
            live: true,
          })
        }
      } catch {
        // 没有 sessions 服务：只给历史清单
      }

      // ③ cwd / 归属 → 工作区名
      const byPath = new Map<string, { id: string; title: string }>()
      const bySession = new Map<string, { id: string; title: string }>()
      try {
        const registry = ctx.get('workspaceRegistry') as
          | { list?: () => Array<{ id?: string; path?: string; title?: string; sessionIds?: readonly string[] }> }
          | undefined
        for (const workspace of registry?.list?.() ?? []) {
          const id = typeof workspace.id === 'string' ? workspace.id : ''
          const title = typeof workspace.title === 'string' ? workspace.title : ''
          const path = typeof workspace.path === 'string' ? workspace.path : ''
          if (path !== '') byPath.set(path, { id, title })
          for (const sessionId of workspace.sessionIds ?? []) {
            if (typeof sessionId === 'string' && sessionId !== '') bySession.set(sessionId, { id, title })
          }
        }
      } catch {
        // 没有 workspaceRegistry（老版本 DSH）：工作区字段留空，弹窗退化成单层会话列表
      }

      return [...rows.values()]
        .sort((a, b) => (a.live === b.live ? b.lastAt - a.lastAt : (a.live ? -1 : 1)))
        .slice(0, 300)
        .map((row) => {
          const owner = byPath.get(row.cwd) ?? bySession.get(row.id)
          return {
            id: row.id,
            title: row.title,
            cwd: row.cwd,
            preset: presetOf(row.id),
            workspaceId: owner?.id ?? null,
            workspaceTitle: owner?.title ?? (row.cwd === '' ? '' : (row.cwd.split('/').filter(Boolean).pop() ?? '')),
          }
        })
    } catch {
      return []
    }
  }


  // 卡片数据通道
  /**
   * 临时诊断：把宿主里 agent preset 服务的真实返回打出来。
   * 用户报「新会话的预设下拉里看不到 Gitee 项目管理」，靠它区分
   * ① 组合树里没有 preset-gitee（补丁没生效）② 有但列表没返回（服务缓存/时机）。
   */
  /**
   * 临时诊断：宿主上到底有哪些能力服务。
   * 「AI 审核投递到子智能体」要 `subagents`（seam）+ `agents`（父 agent 句柄），
   * 这两个是 host 平面服务，得先确认它们在这个进程里真的挂上了。
   */
  const debugServices = (): unknown => {
    const raw = ctx as unknown as { get: (name: string) => unknown }
    const names = [
      'subagents', 'agents', 'sessions', 'agentPresets', 'workspaceRegistry',
      'tools', 'conversation', 'attachments',
    ]
    const out: Record<string, unknown> = {}
    for (const name of names) {
      try {
        const value = raw.get(name)
        if (value === undefined) { out[name] = 'undefined'; continue }
        if (value === null) { out[name] = null; continue }
        const proto = typeof value === 'object' ? Object.getOwnPropertyNames(Object.getPrototypeOf(value as object)) : []
        out[name] = { type: typeof value, methods: proto.filter((k) => k !== 'constructor').slice(0, 40) }
      } catch (error) {
        out[name] = `ERR ${(error as Error).message}`
      }
    }
    try {
      const subagents = raw.get('subagents') as Record<string, unknown> | undefined
      if (subagents !== undefined) {
        const list = subagents.list as (() => unknown) | undefined
        const providers = typeof list === 'function' ? (() => { try { return list.call(subagents) } catch (error) { return `ERR ${(error as Error).message}` } })() : 'no list()'
        const spawn = (() => {
          try {
            const getProvider = subagents.getProvider as ((name: string) => unknown) | undefined
            const found = typeof getProvider === 'function' ? getProvider.call(subagents, 'spawn') : undefined
            return found === undefined ? 'undefined' : { keys: Object.keys(found as object) }
          } catch (error) { return `ERR ${(error as Error).message}` }
        })()
        out['subagents.list()'] = providers
        out['subagents.provider(spawn)'] = spawn
      }
      const agents = raw.get('agents') as Record<string, unknown> | undefined
      const listAgents = agents?.list as (() => unknown) | undefined
      if (typeof listAgents === 'function' && agents !== undefined) {
        const live = listAgents.call(agents) as Array<{ id?: string }>
        out['agents.list()'] = Array.isArray(live) ? live.map((a) => a.id ?? '?') : String(live)
      }
    } catch (error) {
      out['probe'] = `ERR ${(error as Error).message}`
    }
    return out
  }

  const debugPresets = async (): Promise<unknown> => {
    const raw = ctx as unknown as { get: (name: string) => unknown }
    const svc = raw.get('agentPresets') as Record<string, unknown> | undefined
    if (svc === undefined) return { error: 'agentPresets undefined' }
    const brief = (value: unknown): unknown => {
      if (value === undefined) return 'undefined'
      if (value === null) return null
      if (Array.isArray(value)) {
        return value.map((item) => (item !== null && typeof item === 'object' ? { id: (item as { id?: string }).id, name: (item as { name?: string }).name } : item))
      }
      if (typeof value === 'object') return { keys: Object.keys(value as Record<string, unknown>) }
      return value
    }
    const call = async (method: string, arg?: unknown): Promise<unknown> => {
      const fn = (svc as Record<string, unknown>)[method]
      if (typeof fn !== 'function') return `no ${method}()`
      try {
        return brief(await (fn as (...args: unknown[]) => unknown).call(svc, arg))
      } catch (err) {
        return `ERR ${String(err)}`
      }
    }
    const dump = (value: unknown): unknown => {
      if (value === undefined) return 'undefined'
      const seen = new WeakSet<object>()
      try {
        const text = JSON.stringify(value, (key, val: unknown) => {
          if (typeof val === 'function') return `[fn ${String((val as { name?: string }).name ?? '')}]`
          if (val !== null && typeof val === 'object') {
            if (seen.has(val as object)) return '[circular]'
            seen.add(val as object)
          }
          return val
        })
        if (text === undefined) return String(value)
        return text.length > 24000 ? `${text.slice(0, 24000)}…（截断）` : JSON.parse(text) as unknown
      } catch (err) {
        return `ERR ${String(err)}`
      }
    }
    const callRaw = async (method: string, arg?: unknown): Promise<unknown> => {
      const fn = (svc as Record<string, unknown>)[method]
      if (typeof fn !== 'function') return `no ${method}()`
      try {
        return dump(await (fn as (...args: unknown[]) => unknown).call(svc, arg))
      } catch (err) {
        return `ERR ${String(err)}`
      }
    }
    // 宿主 registry 的公开 API 与这里的老写法有两处对不上（缺陷 IKQYDD）：
    //   ① `defaultId` 是 getter（`this.defaultId`），不是方法 —— 当方法调永远拿到 `no defaultId()`；
    //   ② `diagnostic(record)` 要内部 record 对象，对外只有 `list()` 的展示行，**每行自带的 `broken`
    //      就是 diagnostic(record) 的结果**，单独调一次既拿不到 record 也没有意义。
    const defaultId = ((): string | null => {
      try {
        const value = (svc as { defaultId?: unknown }).defaultId
        return typeof value === 'string' && value !== '' ? value : null
      } catch {
        return null
      }
    })()
    return {
      // 用 dump 原样返回，别用 brief 抹掉每行的 `broken`
      list: await callRaw('list'),
      defaultId,
      inspectCompositions: await call('inspectCompositions'),
      compositionInventory: await call('compositionInventory'),
      composedGitee: await callRaw('composedPreset', 'gitee'),
      resolveGitee: await callRaw('resolve', 'gitee'),
      resolveStandard: await callRaw('resolve', 'standard'),
    }
  }

  const handler = createRouteHandler({
    runner,
    role,
    writer,
    // 只读部署开关：面板写路由（/write、/issue-create、/pr/create、/pr/action）也受它约束
    allowWrites: () => resolved.allowWrites,
    // 「设置 → Gitee 企业项目」里的缓存 / 后台刷新开关（本地覆盖，改完即生效）
    settings: {
      resolve: () => liveSettings(),
      write: (patch) => localSettings.write(patch, staticSettings()),
      path: localSettings.path,
      getDraftTarget: (repoKey) => localSettings.getDraftTarget(repoKey),
      setDraftTarget: (repoKey, target) => localSettings.setDraftTarget(repoKey, target),
    },
    presetOf,
    listSessions,
    debugPresets,
    debugServices,
    isGiteeSession: async (sessionId: string) => {
      const preset = presetOf(sessionId)
      if (preset === null) return undefined
      return await isGiteePreset(preset)
    },
    trustedHosts: () => trustedHostsOf(ctx),
    version: VERSION,
    mcp: () => inspectMcpBinary(),
    docs: docService,
    repos: repoService,
    pr: prService,
    subagentReview: async (input: { sessionId: string; prompt: string; label: string; delivery?: 'caller' | 'parent' }) => {
      // delivery='parent' 时，DSH 会往所选主会话追加一条结算消息（人看得见），
      // 结果同时回到这里给面板回填 —— 这就是「投递到主会话」那一档。
      const run = await prSubagent.start(input)
      return { runId: run.runId, childId: run.childId }
    },
    subagentRun: (runId: string) => prSubagent.get(runId),
    subagentCancel: (runId: string) => prSubagent.cancel(runId),
  })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }))

  // 把能力交给 agent 平面。**这是本文件唯一对外的东西**——
  // 工具、人格注入、门禁都在 `./agent` 里，只在挂了那一行的 preset 生效。
  const face: GiteeChatFace = {
    runner,
    role,
    mcp: () => inspectMcpBinary(),
    writer,
    hostConfig: {
      scriptPath: resolved.scriptPath,
      enterpriseId: resolved.enterpriseId,
      mode: resolved.mode,
      allowWrites: resolved.allowWrites,
      userAgent: resolved.userAgent,
      mcpToolPrefix: resolved.docs.mcpToolPrefix,
      // 用 getter：agent 平面每次调用现取，设置页改完（volatile）即使生效
      get cache() {
        return liveCache()
      },
    },
  }
  ctx.provide('giteeChat', face)

  ctx.logger?.info?.(
    `[${name}] host mounted · routes ${ROUTE_PREFIX}/* · 服务 giteeChat 已发布 · 脚本 ${runner.scriptPath}`
    + ` · 写通道 ${resolved.allowWrites ? '开' : '关'} · preset 判定 ${resolved.presetIds.length > 0 ? `显式列表(${resolved.presetIds.join(',')})` : `按组合行 ${resolved.agentRowName}`}`,
  )
}

export { createGqRunner, defaultScriptPath } from './host/gq.ts'
export {
  binaryName, dshHome, ensureMaterialized, inspectMcpBinary, isOnPath, legacyMaterializedPath,
  materializedPath, platformKey, readManifest, toolGapOf, userBinDir,
} from './host/mcpBinary.ts'
export { createIssueWriter, WriteError } from './host/write.ts'
export { createRoleResolver } from './host/role.ts'
export { createMcpClient } from './host/mcpClient.ts'
export { giteeEntGatewayTool } from './host/gateway.ts'
export { PUBLIC_GATEWAY_TOOL_NAME, rawMcpToolName } from './mcpNaming.ts'
export { WRITE_TOOLS, WRITE_TOOLS_BY_TIER } from './generated/tierWrites.ts'
export type { McpClient, McpCallResult, McpToolInfo, McpClientOptions } from './host/mcpClient.ts'
export type { GiteeEntGatewayDeps } from './host/gateway.ts'
export { listEnterprises, switchEnterprise, invalidateAfterEnterpriseSwitch } from './host/enterprise.ts'
export { createEnterpriseIdResolver, resolveEnterpriseIdNow, noEnterpriseHint, unauthorizedEnterpriseHint } from './host/enterpriseId.ts'
export {
  DocError, createMcpDocs, unwrapToolResult,
} from './host/mcpDocs.ts'
export { createDocService, defaultDocsRoot } from './host/docService.ts'
export { createRepoService, visibilityOf } from './host/repoService.ts'
export { createPrService, PrError } from './host/prService.ts'
export { createPrTemplates } from './host/prTemplates.ts'
export {
  createLocalSettings, normalizeTtlSeconds, normalizeIntervalSeconds, normalizeIdleMinutes,
} from './host/localSettings.ts'
export type { CacheSettings, AutoRefreshSettings, DraftTarget, LocalSettings, ResolvedSettings, SettingsPatch } from './host/localSettings.ts'
export {
  createWikiCache, toWorkspacePath, safeRepoSegment, WORKSPACE_LINK_DIR, WORKSPACE_LINK_NAME,
} from './host/wikiCache.ts'
export {
  classifyPageState, enterpriseLayer, pageRelPath, planPull, readIndex, rollupDocState, safeSlug, stripExtension, documentDir, MANIFEST_NAME,
  TEXT_PREVIEW_EXT, extOf, readTextFile,
  ATTACH_MANIFEST_NAME, classifyAttachState, readAttachManifest, writeAttachManifest, attachFileExists,
  cacheStats, humanBytes, nowStamp, stampOf, parseStamp,
} from './host/docCache.ts'
export type { McpDocs, ToolsService } from './host/mcpDocs.ts'
export type { DocService } from './host/docService.ts'
export type { RepoService } from './host/repoService.ts'
export type { PrService } from './host/prService.ts'
export type { PrTemplates } from './host/prTemplates.ts'
export type { WikiCache } from './host/wikiCache.ts'
export type { DocManifest, DocPageState } from './host/docCache.ts'
export type { IssueWriter, IssueWriterOptions } from './host/write.ts'
export type { GqRunner, RunRequest, RunResult } from './host/gq.ts'
export type { McpBinaryReport, McpInspection, McpManifest } from './host/mcpBinary.ts'
export type { RoleResolver, RoleSnapshot } from './host/role.ts'
export type { EnterpriseEntry, EnterpriseListPayload, SwitchResult } from './host/enterprise.ts'
export type { EnterpriseIdResolution, EnterpriseIdResolver, EnterpriseIdSource } from './host/enterpriseId.ts'
export type { GiteeChatFace } from './host/face.ts'
export type { PersonaKey, PersonaMode, PersonaTier, RolePayload } from './types.ts'
