/**
 * 「设置 → Gitee 企业项目」里的**缓存 / 后台刷新**开关：落在本地配置文件里。
 *
 * 为什么不用 cordis 的插件配置（`Config` 里那两组 volatile 字段）：
 * 那套表单只出现在「设置 → 插件 → 插件管理 → 本插件」的格子里，而使用者的
 * 心智是「Gitee 的事都在 Gitee 那一页配」（token、企业、缓存放一起）。
 * 所以这里做一层**本地覆盖**：`$DSH_HOME/.gitee-chat/config.json` 里写了就压过
 * 补丁里的静态配置（`cache` / `autoRefresh` 两个键），没写就沿用补丁值。
 *
 * 与 `enterpriseId` 的本地覆盖是同一个文件、同一个哲学：机器级状态留在机器上，
 * 不进 git、不进 profile、换机器就重配一份。
 *
 * 读是**每次现读**（带 mtime 记忆，文件没变就不重复解析）：改完点保存，
 * 下一次取数就按新 TTL 走，不用重启 dsh。
 *
 * @module dsh-gitee-chat/host/localSettings
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 缓存三件套（与设置页表单一一对应）。 */
export interface CacheSettings {
  /** 会话里的 AI 能否读看板快照。 */
  agentReadable: boolean
  /** 快照是否落盘。 */
  persist: boolean
  /** 新鲜期秒数；0 = 不做缓存。 */
  ttlSeconds: number
}

/** 后台刷新。 */
export interface AutoRefreshSettings {
  /** 是否启用。 */
  enabled: boolean
  /** 间隔秒（最小 10）。 */
  intervalSeconds: number
  /** 闲置多少分钟后暂停（分钟）。 */
  idleMinutes: number
}

/**
 * AI 起草 PR 时按仓库记住的投递目标。
 *
 * 为什么按仓库记：同一个 Gitee 项目里的仓库可能分属不同工作区，而工作区之间的
 * 权限边界是硬的（有的工作区只有「本区可改」权限）。所以「这个仓库的 PR 该投到
 * 哪个工作区/会话」配一次、之后自动带出，不用每次手选、也不会选错。
 */
export interface DraftTarget {
  /** 目标会话 id。 */
  sessionId: string
  /** 会话标题（会话列表里消失时仍能显示人话）。 */
  sessionTitle: string
  /** 会话所属工作区名。 */
  workspaceTitle: string
  /**
   * 投递给子智能体（勾选框状态）。
   *
   * `true` = 在目标会话下起子智能体跑（不插用户消息）；
   * `false` = 直接以用户消息投到目标会话（想看见过程、想接着聊时用）。
   * 与工作区/会话一起按仓库记住：同一个人对同一个仓库的偏好通常不会变。
   */
  deliverSubagent: boolean
  /** 最后一次选择时间（ISO）。 */
  at: string
}

/** 本地覆盖（只存用户显式改过的字段）。 */
export interface LocalSettings {
  cache?: Partial<CacheSettings>
  autoRefresh?: Partial<AutoRefreshSettings>
  /** repoKey（`path_with_namespace` 或仓库 id）→ 投递目标。 */
  draftTargets?: Record<string, DraftTarget>
}

/** 一次读到的、已规整的开关值 + 它们的来源。 */
export interface ResolvedSettings {
  cache: CacheSettings
  autoRefresh: AutoRefreshSettings
}

/** 保存时的入参（缺省字段表示不改）。 */
export interface SettingsPatch {
  cache?: Partial<CacheSettings>
  autoRefresh?: Partial<AutoRefreshSettings>
}

/** 把新鲜期规整到「0 或 ≥10」，其它非法值回落默认。 */
export function normalizeTtlSeconds(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  if (raw <= 0) return 0
  return Math.max(10, Math.min(3600, Math.floor(raw)))
}

/** 把间隔规整到 10–3600 秒。 */
export function normalizeIntervalSeconds(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  return Math.max(10, Math.min(3600, Math.floor(raw)))
}

/** 把闲置分钟规整到 1–1440。 */
export function normalizeIdleMinutes(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  return Math.max(1, Math.min(1440, Math.floor(raw)))
}

/** 布尔字段：只认真布尔与 'true'/'false' 字符串，其它回落。 */
function boolOf(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw
  if (raw === 'true') return true
  if (raw === 'false') return false
  return fallback
}

/**
 * 创建本地设置读写器。
 *
 * @param configRoot - 配置目录（默认 `$DSH_HOME/.gitee-chat`）。
 */
export function createLocalSettings(configRoot: string) {
  const configPath = join(configRoot, 'config.json')
  /** 上次解析结果 + 当时的 mtime/size（文件没动就直接复用）。 */
  let memo: { key: string; value: LocalSettings } | undefined

  /** 读原始文件（坏文件当空对象，绝不抛）。 */
  function readFile(): LocalSettings {
    try {
      if (!existsSync(configPath)) return {}
      const stat = statSync(configPath)
      const key = `${stat.mtimeMs}:${stat.size}`
      if (memo !== undefined && memo.key === key) return memo.value
      const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
      const raw = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
      const out: LocalSettings = {}
      if (typeof raw.cache === 'object' && raw.cache !== null) out.cache = raw.cache as Partial<CacheSettings>
      if (typeof raw.autoRefresh === 'object' && raw.autoRefresh !== null) {
        out.autoRefresh = raw.autoRefresh as Partial<AutoRefreshSettings>
      }
      memo = { key, value: out }
      return out
    } catch {
      return {}
    }
  }

  /**
   * 合并出**最终生效值**：本地覆盖优先，否则用调用方给的静态配置。
   *
   * @param base - 静态配置（cordis 补丁里的 `cache` / `autoRefresh`）。
   * @returns 规整后的生效值。
   */
  function resolve(base: ResolvedSettings): ResolvedSettings {
    const local = readFile()
    return {
      cache: {
        agentReadable: boolOf(local.cache?.agentReadable, base.cache.agentReadable),
        persist: boolOf(local.cache?.persist, base.cache.persist),
        ttlSeconds: normalizeTtlSeconds(local.cache?.ttlSeconds, base.cache.ttlSeconds),
      },
      autoRefresh: {
        enabled: boolOf(local.autoRefresh?.enabled, base.autoRefresh.enabled),
        intervalSeconds: normalizeIntervalSeconds(local.autoRefresh?.intervalSeconds, base.autoRefresh.intervalSeconds),
        idleMinutes: normalizeIdleMinutes(local.autoRefresh?.idleMinutes, base.autoRefresh.idleMinutes),
      },
    }
  }

  /**
   * 写入覆盖（保留 config.json 里其它字段：企业、模板绑定都在里面）。
   *
   * @param patch - 要改的字段；`undefined` 表示不动该字段。
   * @param base - 静态配置，用于给没写的字段补齐。
   * @returns 写完之后生效的值。
   */
  function write(patch: SettingsPatch, base: ResolvedSettings): ResolvedSettings {
    const current = readFile()
    const next: LocalSettings = { cache: { ...(current.cache ?? {}) }, autoRefresh: { ...(current.autoRefresh ?? {}) } }
    if (patch.cache !== undefined) {
      if (patch.cache.agentReadable !== undefined) next.cache!.agentReadable = boolOf(patch.cache.agentReadable, base.cache.agentReadable)
      if (patch.cache.persist !== undefined) next.cache!.persist = boolOf(patch.cache.persist, base.cache.persist)
      if (patch.cache.ttlSeconds !== undefined) {
        next.cache!.ttlSeconds = normalizeTtlSeconds(patch.cache.ttlSeconds, base.cache.ttlSeconds)
      }
    }
    if (patch.autoRefresh !== undefined) {
      if (patch.autoRefresh.enabled !== undefined) {
        next.autoRefresh!.enabled = boolOf(patch.autoRefresh.enabled, base.autoRefresh.enabled)
      }
      if (patch.autoRefresh.intervalSeconds !== undefined) {
        next.autoRefresh!.intervalSeconds = normalizeIntervalSeconds(patch.autoRefresh.intervalSeconds, base.autoRefresh.intervalSeconds)
      }
      if (patch.autoRefresh.idleMinutes !== undefined) {
        next.autoRefresh!.idleMinutes = normalizeIdleMinutes(patch.autoRefresh.idleMinutes, base.autoRefresh.idleMinutes)
      }
    }
    // 读原始全文再改：config.json 里还有 enterpriseId / templateBindings 等别人的字段
    const raw = readRawJson()
    raw.cache = next.cache
    raw.autoRefresh = next.autoRefresh
    writeRawJson(raw)
    return resolve(base)
  }

  /** 读整份 JSON（保留别人的字段用；坏文件当空对象）。 */
  function readRawJson(): Record<string, unknown> {
    try {
      if (!existsSync(configPath)) return {}
      const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  /** 原子写整份 JSON（先写临时文件再 rename，免得读到半个文件）。 */
  function writeRawJson(raw: Record<string, unknown>): void {
    mkdirSync(configRoot, { recursive: true })
    const tmp = `${configPath}.tmp-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, configPath)
    memo = undefined
  }

  /**
   * 取某仓库记住的投递目标。
   *
   * @param repoKey - `path_with_namespace` 或仓库 id（字符串）。
   * @returns 没记过就是 `undefined`（调用方回落到当前会话）。
   */
  function getDraftTarget(repoKey: string): DraftTarget | undefined {
    const raw = readRawJson()
    const map = typeof raw.draftTargets === 'object' && raw.draftTargets !== null
      ? (raw.draftTargets as Record<string, unknown>)
      : {}
    const item = map[repoKey]
    if (typeof item !== 'object' || item === null) return undefined
    const record = item as Record<string, unknown>
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : ''
    if (sessionId === '') return undefined
    return {
      sessionId,
      sessionTitle: typeof record.sessionTitle === 'string' ? record.sessionTitle : '',
      workspaceTitle: typeof record.workspaceTitle === 'string' ? record.workspaceTitle : '',
      // 老记录没有这个字段：默认走子智能体（0.5.4 起的默认口径）
      deliverSubagent: record.deliverSubagent === false ? false : true,
      at: typeof record.at === 'string' ? record.at : '',
    }
  }

  /**
   * 记住（或清除）某仓库的投递目标。
   *
   * @param repoKey - `path_with_namespace` 或仓库 id。
   * @param target - `null` 表示清除这条记忆。
   * @returns 写完之后该仓库的目标（清除后为 `undefined`）。
   */
  function setDraftTarget(repoKey: string, target: DraftTarget | null): DraftTarget | undefined {
    const raw = readRawJson()
    const map = typeof raw.draftTargets === 'object' && raw.draftTargets !== null
      ? { ...(raw.draftTargets as Record<string, unknown>) }
      : {}
    if (target === null || target.sessionId === '') delete map[repoKey]
    else map[repoKey] = target
    raw.draftTargets = map
    writeRawJson(raw)
    return target === null ? undefined : getDraftTarget(repoKey)
  }

  return { path: configPath, read: readFile, resolve, write, getDraftTarget, setDraftTarget }
}

/** 本地设置读写器。 */
export type LocalSettingsStore = ReturnType<typeof createLocalSettings>
