/**
 * 身份与人格解析器。
 *
 * 为什么需要缓存而不是现查：`systemPrompt.context` 的 `text` provider 是
 * **同步**的（契约：`text: string | ((context: AssembleContext) => string)`），
 * 而 `AssembleContext` 只有 `{ scope, signal }`——**没有 session**。所以人格
 * 只能在装配之外解析好、缓存起来，装配时同步取用。
 *
 * 这也正好符合规则本身：**人格由 token 的身份关系决定，与会话无关**。
 *   - 基础人格：进程级一次解析（谁持有 token → 企业角色 / 负责哪些项目）
 *   - 当前项目里的角色：会话级的「聚焦项目」决定
 *
 * @module dsh-gitee-chat/host/role
 */

import type { GqRunner } from './gq.ts'
import type { PersonaKey, PersonaMode, PersonaTier, RolePayload } from '../types.ts'

/** 解析器选项。 */
export interface RoleResolverOptions {
  readonly runner: GqRunner
  /** 缓存有效期（毫秒）。0 = 只解析一次，除非显式刷新。 */
  readonly ttlMs?: number
  /** 那一个开关：auto=由身份推导（默认），manager/project/exec=人工强制。 */
  readonly mode?: PersonaMode
}

/** 解析器状态快照（用于自检/调试，不含脚本原始输出）。 */
export interface RoleSnapshot {
  resolved: boolean
  mode: PersonaMode
  tier: PersonaTier | null
  canManageProject: boolean | null
  persona: string | null
  generatedAt: string | null
  ownedProgramCount: number
  ownedIssueCount: number
  lastError: string | null
}

/**
 * 创建身份解析器。
 * @param options - 执行器与缓存 TTL。
 */
export function createRoleResolver(options: RoleResolverOptions) {
  const { runner } = options
  const ttlMs = options.ttlMs ?? 10 * 60_000
  const mode = options.mode ?? 'auto'

  let cache: RolePayload | null = null
  let inflight: Promise<RolePayload> | null = null
  let lastError: string | null = null
  /** 被显式作废（换了企业）—— 与「过期」区分开：作废必须立刻重解析，不看 TTL。 */
  let stale = false

  /** 缓存是否仍然新鲜。 */
  function fresh(): boolean {
    if (cache === null) return false
    if (stale) return false
    if (ttlMs <= 0) return true
    const at = Date.parse(cache.generatedAt.replace(' ', 'T'))
    return Number.isFinite(at) && Date.now() - at < ttlMs
  }

  /** 真正执行 `gq role`；模式与聚焦项目透传给脚本，脚本据此决定档位。 */
  async function exec(focusProgram?: number): Promise<RolePayload> {
    const args = ['role', '--mode', mode]
    if (focusProgram !== undefined) args.push('--program', String(focusProgram))
    const payload = await runner.execJson<RolePayload>(args, runner.fixtureFallback)
    // 只有「不带聚焦项目」的基础判定才更新缓存——注入上下文用的是基础人格，
    // 逐项目判定是临时的查询结果，不应覆盖它。
    if (focusProgram === undefined) {
      cache = payload
      stale = false
    }
    lastError = null
    return payload
  }

  return {
    /** 当前缓存（未解析时为 null）。同步，装配期安全。 */
    current(): RolePayload | null {
      return cache
    },

    /**
     * 装配期同步取用的上下文块。
     * 未解析时返回空串——契约规定「空文本不贡献任何内容」，因此不会污染提示词。
     */
    text(): string {
      return cache?.contextText ?? ''
    },

    /** 当前人格键（未解析时为 null）。 */
    persona(): PersonaKey | null {
      return cache?.persona ?? null
    },

    /** 当前能力档（未解析时为 null）。 */
    tier(): PersonaTier | null {
      return cache?.tier ?? null
    },

    /** **那个开关**：项目管理与分析是否开启（未解析时为 null）。 */
    canManageProject(): boolean | null {
      return cache?.canManageProject ?? null
    },

    /** 本次使用的模式。 */
    mode(): PersonaMode {
      return mode
    },

    /** 状态快照。 */
    snapshot(): RoleSnapshot {
      return {
        resolved: cache !== null,
        mode,
        tier: cache?.tier ?? null,
        canManageProject: cache?.canManageProject ?? null,
        persona: cache?.persona ?? null,
        generatedAt: cache?.generatedAt ?? null,
        ownedProgramCount: cache?.ownedPrograms.length ?? 0,
        ownedIssueCount: cache?.ownedIssueCount ?? 0,
        lastError,
      }
    },

    /**
     * 解析（命中新鲜缓存则直接返回；并发调用共享同一个在途 Promise，避免打爆脚本）。
     * @param force - 忽略缓存强制重解析。
     */
    async resolve(force = false, focusProgram?: number): Promise<RolePayload> {
      // 逐项目判定不走缓存/在途合并：它是一次独立查询，结果不参与注入。
      if (focusProgram !== undefined) return exec(focusProgram)
      if (!force && fresh()) return cache as RolePayload
      if (inflight !== null) return inflight
      inflight = exec().finally(() => {
        inflight = null
      })
      try {
        return await inflight
      } catch (error) {
        // 失败不清空旧缓存：旧人格总好过没有人格（且会随下轮重试自愈）。
        lastError = error instanceof Error ? error.message : String(error)
        throw error
      }
    },

    /** 静默预热（挂载时调用；失败只记录，不抛出）。 */
    prime(): void {
      void this.resolve().catch(() => {})
    },

    /**
     * 作废缓存并立刻重解析（切换企业后调用，见 host/enterprise.ts）。
     *
     * 刻意**不清空旧值**：`text()` 是装配期同步取用的，清空会出现一次「没有人格」
     * 的空窗；这里只是让缓存不再新鲜，新人格一到就替换掉。失败时旧人格继续顶着
     * ——与 resolve() 的失败策略一致：旧的好过没有。
     */
    reset(): void {
      stale = true
      lastError = null
      this.prime()
    },
  }
}

/** 解析器类型。 */
export type RoleResolver = ReturnType<typeof createRoleResolver>
