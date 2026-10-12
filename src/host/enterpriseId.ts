/**
 * 「当前生效的企业 id」—— **单一真源**，顺序与 `scripts/gitee/gq.mjs` 的
 * `resolveEnterprise()` 逐条对齐：
 *   1. 插件配置里的 `enterpriseId`（>0 = 钉住，其余来源都不生效）
 *   2. 环境变量 `GITEE_ENT_ID` → `GITEE_CHAT_ENTERPRISE_ID`
 *   3. 本地配置文件 `$DSH_HOME/.gitee-chat/config.json` 的 `enterpriseId`
 *      （「设置 → Gitee 企业项目」切企业写的就是它，改完即生效、无需重启）
 *   4. token 只看得见**一家**企业 → 自动用；多家 → **绝不自动挑**（会拿错公司数据）
 *
 * ## 为什么非要有这个模块（2026-10-12 的一次真实故障）
 *
 * MCP 通道的每个工具都**强制**要 `enterprise_id`，且没有任何回落：
 *   - 不给 → `[param_error] Invalid parameter: enterprise_id (parameter is required)`
 *   - 给 `0` → `[api_error] 401 … 企业未授权此应用进行访问`
 * 而 gq 通道允许"不指定"—— `enterpriseId: 0` 传下去，脚本自己按上面那四步解析。
 *
 * 宿主此前把**钉住值**（补丁里的 `enterpriseId`，默认 0）直接当 `enterprise_id`
 * 发给 MCP，于是「没钉企业、靠设置页或配置文件选」的部署里：
 *   **仓库面板与知识库面板整体 401**（这两条路都走 MCP），
 *   而看板、人格、工作项却完全正常（走 gq）。
 * 两半语义不对齐，症状就长成"一半好用一半报错"，极难定位。
 *
 * 结论：**凡是要发给 MCP 的 enterprise_id，都必须经过这里。**
 *
 * ## 为什么不缓存第 1–3 步、也不跳过第 4 步的探测
 *
 * 第 1–3 步读的是一个三行 JSON，缓存只会换来「设置页切了企业、面板还在读旧企业」——
 * 正是 `host/enterprise.ts` 顶部说的**静默错数据**，比报错危险得多。
 * 第 4 步虽然要发一次 MCP 调用，也**每次都问**：记下来就可能在 token 换过企业之后
 * 继续用旧的那一家。这里只把"最近一次探测到的 id"当作同步调用方的**回报值**
 * （见 `now()`），绝不用它来跳过探测。
 *
 * @module dsh-gitee-chat/host/enterpriseId
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 企业 id 的来源（诊断与报错文案用）。 */
export type EnterpriseIdSource = 'pinned' | 'env' | 'file' | 'auto' | 'none'

/** 一次解析的结果。 */
export interface EnterpriseIdResolution {
  /** 生效的企业 id；`0` = 还没确定。 */
  id: number
  /** 这个 id 是从哪儿来的。 */
  source: EnterpriseIdSource
  /** 自动探测时 token 看得见的全部企业（多家时用来提示"必须显式指定"）。 */
  candidates: number[]
}

/** 企业环境变量名：数组顺序即优先级（与 gq.mjs 的 `resolveEnterprise` 一致）。 */
export const ENTERPRISE_ENVS = ['GITEE_ENT_ID', 'GITEE_CHAT_ENTERPRISE_ID'] as const

/** DSH 主目录（与 `host/token.ts`、`gq.mjs` 同一条约定）。 */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * 本地配置文件路径 —— 与 `gq.mjs` 的 `configPath()` 同一条约定。
 * 只读，不写（写入只由脚本做，见 host/enterprise.ts 的单一真源说明）。
 * @returns 配置文件绝对路径。
 */
export function enterpriseConfigPath(): string {
  return join(dshHome(), '.gitee-chat', 'config.json')
}

/**
 * 读本地配置文件里的企业 id。读不到 / 坏了 / 不是正整数一律按 0（= 未指定）。
 * @returns 企业 id，或 `0`。
 */
export function readFileEnterpriseId(): number {
  try {
    const path = enterpriseConfigPath()
    if (!existsSync(path)) return 0
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const record = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
    const value = Number(record.enterpriseId)
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
  } catch {
    // 读不动（权限/被占用/半截 JSON）就当这一份没配，继续往下走。
    return 0
  }
}

/**
 * 读环境变量里的企业 id（按 `ENTERPRISE_ENVS` 顺序取第一个正整数）。
 * @returns 企业 id，或 `0`。
 */
export function envEnterpriseId(): number {
  for (const name of ENTERPRISE_ENVS) {
    const value = Number(process.env[name])
    if (Number.isFinite(value) && value > 0) return Math.trunc(value)
  }
  return 0
}

/**
 * 同步解析第 1–3 步（不联网、不起子进程、不问 MCP）。
 * @param pinned - 插件配置钉住的企业 id（0 = 不钉）。
 * @returns 解析结果；都落空时 `source: 'none'`、`id: 0`。
 */
export function resolveEnterpriseIdNow(pinned: number): EnterpriseIdResolution {
  const value = Number(pinned)
  if (Number.isFinite(value) && value > 0) {
    return { id: Math.trunc(value), source: 'pinned', candidates: [] }
  }
  const fromEnv = envEnterpriseId()
  if (fromEnv > 0) return { id: fromEnv, source: 'env', candidates: [] }
  const fromFile = readFileEnterpriseId()
  if (fromFile > 0) return { id: fromFile, source: 'file', candidates: [] }
  return { id: 0, source: 'none', candidates: [] }
}

/** 生效企业 id 的解析器（宿主里凡是需要 enterprise_id 的地方都从这里取）。 */
export interface EnterpriseIdResolver {
  /** 插件配置钉住的企业 id（0 = 不钉）。 */
  readonly pinned: number
  /** 同步现取第 1–3 步；第 4 步探测过的 id 会作为 `auto` 回报。 */
  now(): EnterpriseIdResolution
  /** `now().id` 的简写（同步调用方用，例如缓存分层）。 */
  id(): number
  /**
   * 全序解析：第 1–3 步都落空时，用 `visible()` 问一次"token 看得见哪些企业"。
   * @param visible - 返回可见企业 id 列表的实现（通常是一次 `list_enterprises`）。
   */
  resolve(visible: () => Promise<number[]>): Promise<EnterpriseIdResolution>
  /** 给人看的一句话：当前用的是哪家、为什么。 */
  describe(): string
}

/**
 * 创建解析器。
 * @param deps - `pinned` 来自插件配置（`resolveConfig().enterpriseId`）。
 */
export function createEnterpriseIdResolver(deps: { pinned: number }): EnterpriseIdResolver {
  const pinnedValue = Number(deps.pinned)
  const pinned = Number.isFinite(pinnedValue) && pinnedValue > 0 ? Math.trunc(pinnedValue) : 0
  /** 最近一次自动探测到的 id（**只用来回报**，不用来跳过探测）。 */
  let lastAuto = 0

  return {
    pinned,

    now(): EnterpriseIdResolution {
      const local = resolveEnterpriseIdNow(pinned)
      if (local.id > 0) return local
      if (lastAuto > 0) return { id: lastAuto, source: 'auto', candidates: [lastAuto] }
      return local
    },

    id(): number {
      return this.now().id
    },

    async resolve(visible: () => Promise<number[]>): Promise<EnterpriseIdResolution> {
      const local = resolveEnterpriseIdNow(pinned)
      if (local.id > 0) return local

      let ids: number[] = []
      try {
        ids = await visible()
      } catch {
        // 问不到就当"没看见"：真正可行动的那句话由调用方按 noEnterpriseHint 报。
        ids = []
      }
      const usable = ids.filter((id) => Number.isFinite(id) && id > 0)

      // 与 gq 同一条纪律：**多家企业绝不自动挑一个** —— 静默取第一个会拿错公司的数据。
      if (usable.length === 1) {
        lastAuto = usable[0]
        return { id: lastAuto, source: 'auto', candidates: usable }
      }
      return { id: 0, source: 'none', candidates: usable }
    },

    describe(): string {
      const resolved = resolveEnterpriseIdNow(pinned)
      switch (resolved.source) {
        case 'pinned':
          return `插件配置钉住的企业 ${resolved.id}`
        case 'env':
          return `环境变量里指定的企业 ${resolved.id}`
        case 'file':
          return `本地配置文件（${enterpriseConfigPath()}）里的企业 ${resolved.id}`
        default:
          return lastAuto > 0 ? `自动识别的唯一企业 ${lastAuto}` : '未指定（唯一企业自动用，多家企业必须显式指定）'
      }
    },
  }
}

/** Gitee 在「企业 id 不属于这个 token」时返回的那句 401（逐字，用于识别与改写成可行动的报错）。 */
const UNAUTHORIZED_TEXT = '企业未授权此应用进行访问'

/**
 * 把「企业未授权此应用进行访问」这句 401 改写成**可行动**的报错。
 *
 * 实测（见文件顶部说明）：token 有效、企业 id 换成别家的 ⇒ 逐字就是这个 401。
 * 所以这句话的真身是「企业 id 不对」，**不是** token 失效；照字面去重配 token 是白费功夫。
 * 不是这句 401 时原样返回，不干扰别的错误。
 * @param text - MCP 抛出来的原始报错文本。
 * @param id - 本次实际发过去的企业 id。
 * @param description - 该 id 的来源（`EnterpriseIdResolver.describe()`）。
 * @returns 可能被追加了说明的报错文本。
 */
export function unauthorizedEnterpriseHint(text: string, id: number, description: string): string {
  if (!text.includes(UNAUTHORIZED_TEXT)) return text
  return `${text}（本次用的企业 id = ${id}，来源：${description}。`
    + '这句话的意思是"这个企业 id 不在当前 token 名下"，不是 token 失效 —— 不用重配 token；'
    + '在「设置 → Gitee 企业项目」里选对该企业即可。）'
}

/**
 * 解析不出企业时的**可行动**报错文案。
 *
 * 为什么不直接把 MCP 的原始报错抛出去：`401 企业未授权此应用进行访问` 读起来像
 * "token 没权限"，而真实原因往往是"根本没选企业"，使用者会往完全错误的方向查。
 * @param resolved - 解析结果（用 `candidates` 说明"你有几家企业要选"）。
 * @returns 一段中文说明。
 */
export function noEnterpriseHint(resolved: EnterpriseIdResolution): string {
  const head = resolved.candidates.length > 1
    ? `这个 token 看得见 ${resolved.candidates.length} 家企业（${resolved.candidates.join('、')}），必须显式指定一家（不会自动挑，避免拿错公司的数据）。`
    : '还没确定要操作哪一家企业。'
  return `${head}`
    + '最简：在「设置 → Gitee 企业项目」里选一家（写入本地配置，立即生效、无需重启）；'
    + '也可以运行 `gq enterprises --use <id>`，或在插件配置里写 `enterpriseId: <id>`。'
}
