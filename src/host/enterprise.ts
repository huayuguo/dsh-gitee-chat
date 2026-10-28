/**
 * 企业切换 —— 设置页（`POST /api/gitee-chat/enterprise`）与 `gitee_enterprises`
 * 工具共用的一条通道。
 *
 * 为什么要单独成模块：切企业**必须同时做三件事**，少一件就会出静默错数据：
 *   1. 写本地配置（`gq enterprises --use <id>` → `$DSH_HOME/.gitee-chat/config.json`）；
 *   2. 清进程内看板缓存 —— 缓存的键只有 `scope:program`，**不含企业**
 *      （见 host/gq.ts 的 `cacheKeyOf`），不清就会把上一家企业的看板继续端出来，
 *      而且卡片长得完全正常，比报错危险得多；
 *   3. 让身份人格失效重解析 —— 企业角色与「我负责的项目」都随企业变了
 *      （role 默认缓存 10 分钟，见 host/role.ts）。
 *
 * 第 2、3 条以前只由脚本层「写文件」完成，宿主并不知道自己缓存过什么，
 * 于是出现过「企业列表已经换了、卡片还是上一家」的错配。见 DESIGN.md §36。
 *
 * @module dsh-gitee-chat/host/enterprise
 */

import type { GqRunner } from './gq.ts'
import type { RoleResolver } from './role.ts'

/** 企业在脚本输出里的形状。 */
export interface EnterpriseEntry {
  id: number
  name: string
  path?: string
}

/** `GET /enterprises` 的形状：脚本直出的字段 + 宿主补的钉住信息。 */
export interface EnterpriseListPayload {
  enterprises: EnterpriseEntry[]
  /** 脚本解析出的当前企业（flag > env > 文件 > 自动）；0 = 未指定。 */
  current: number
  /** 当前值的来源说明（如「本地配置文件」）。 */
  source: string
  /** 配置文件里记的值。 */
  fileEnterpriseId: number
  configPath: string
  /** 插件配置（补丁里的 `enterpriseId`）钉住的企业；>0 时本地选择不生效。 */
  pinned: number
  /** 真正生效的企业：钉住优先，否则取 `current`。 */
  effective: number
}

/** 切换结果（回给界面/工具，用于如实说明「切了没有」「清了什么」）。 */
export interface SwitchResult {
  selected: { id: number; name: string } | null
  configPath: string
  pinned: number
  effective: number
  /** 本次被失效的宿主缓存（写给人看的名词）。 */
  invalidated: string[]
}

/** 切换所需的最小依赖。 */
export interface EnterpriseSwitchDeps {
  readonly runner: GqRunner
  readonly role: RoleResolver
}

/** 读取插件配置里钉住的企业 id（未配置为 0 = 不钉）。 */
function pinnedOf(runner: GqRunner): number {
  const value = Number((runner as { enterpriseId?: number }).enterpriseId ?? 0)
  return Number.isFinite(value) && value > 0 ? value : 0
}

/** 把脚本输出规整成稳定形状（脚本字段缺失时不至于让界面拿到 undefined）。 */
function normalizeList(raw: Partial<EnterpriseListPayload>, pinned: number): EnterpriseListPayload {
  const enterprises = Array.isArray(raw.enterprises) ? raw.enterprises : []
  const current = Number(raw.current ?? 0) || 0
  return {
    enterprises,
    current,
    source: typeof raw.source === 'string' ? raw.source : '未指定（自动）',
    fileEnterpriseId: Number(raw.fileEnterpriseId ?? 0) || 0,
    configPath: typeof raw.configPath === 'string' ? raw.configPath : '',
    pinned,
    effective: pinned > 0 ? pinned : current,
  }
}

/**
 * 列出 token 可见的企业（含「当前用的是哪家、为什么是这家」）。
 * @param runner - 取数执行器。
 */
export async function listEnterprises(runner: GqRunner): Promise<EnterpriseListPayload> {
  const raw = await runner.execJson<Partial<EnterpriseListPayload>>(['enterprises'], false)
  return normalizeList(raw, pinnedOf(runner))
}

/**
 * 让所有「随企业而变」的宿主缓存失效。
 *
 * 只做失效，不做写入：写入由脚本负责（单一真源），这里补的是宿主侧的三个坑。
 * @param deps - 执行器与身份解析器。
 * @returns 被失效项的中文名（用于回显，让人知道「切换后旧数据不会残留」）。
 */
export function invalidateAfterEnterpriseSwitch(deps: EnterpriseSwitchDeps): string[] {
  deps.runner.clear()
  deps.role.reset()
  return ['看板与工作项缓存', '身份人格']
}

/**
 * 切换当前企业：写配置 → 失效缓存 → 立即重解析身份。
 *
 * @param deps - 执行器与身份解析器。
 * @param id - 目标企业 id（必须是正整数）。
 */
export async function switchEnterprise(deps: EnterpriseSwitchDeps, id: number): Promise<SwitchResult> {
  const target = Math.trunc(Number(id))
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error('切换企业需要正整数 id')
  }
  const res = await deps.runner.execJson<{ selected?: { id: number; name: string } | null; configPath?: string }>(
    ['enterprises', '--use', String(target)], false,
  )
  const invalidated = invalidateAfterEnterpriseSwitch(deps)
  const pinned = pinnedOf(deps.runner)
  return {
    selected: res?.selected ?? null,
    configPath: typeof res?.configPath === 'string' ? res.configPath : '',
    pinned,
    effective: pinned > 0 ? pinned : target,
    invalidated,
  }
}
