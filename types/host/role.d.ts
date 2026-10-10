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
import type { GqRunner } from './gq.ts';
import type { PersonaKey, PersonaMode, PersonaTier, RolePayload } from '../types.ts';
/** 解析器选项。 */
export interface RoleResolverOptions {
    readonly runner: GqRunner;
    /** 缓存有效期（毫秒）。0 = 只解析一次，除非显式刷新。 */
    readonly ttlMs?: number;
    /** 那一个开关：auto=由身份推导（默认），manager/project/exec=人工强制。 */
    readonly mode?: PersonaMode;
}
/** 解析器状态快照（用于自检/调试，不含脚本原始输出）。 */
export interface RoleSnapshot {
    resolved: boolean;
    mode: PersonaMode;
    tier: PersonaTier | null;
    canManageProject: boolean | null;
    persona: string | null;
    generatedAt: string | null;
    ownedProgramCount: number;
    ownedIssueCount: number;
    lastError: string | null;
}
/**
 * 创建身份解析器。
 * @param options - 执行器与缓存 TTL。
 */
export declare function createRoleResolver(options: RoleResolverOptions): {
    /** 当前缓存（未解析时为 null）。同步，装配期安全。 */
    current(): RolePayload | null;
    /**
     * 装配期同步取用的上下文块。
     * 未解析时返回空串——契约规定「空文本不贡献任何内容」，因此不会污染提示词。
     */
    text(): string;
    /** 当前人格键（未解析时为 null）。 */
    persona(): PersonaKey | null;
    /** 当前能力档（未解析时为 null）。 */
    tier(): PersonaTier | null;
    /** **那个开关**：项目管理与分析是否开启（未解析时为 null）。 */
    canManageProject(): boolean | null;
    /** 本次使用的模式。 */
    mode(): PersonaMode;
    /** 状态快照。 */
    snapshot(): RoleSnapshot;
    /**
     * 解析（命中新鲜缓存则直接返回；并发调用共享同一个在途 Promise，避免打爆脚本）。
     * @param force - 忽略缓存强制重解析。
     */
    resolve(force?: boolean, focusProgram?: number): Promise<RolePayload>;
    /** 静默预热（挂载时调用；失败只记录，不抛出）。 */
    prime(): void;
    /**
     * 作废缓存并立刻重解析（切换企业后调用，见 host/enterprise.ts）。
     *
     * 刻意**不清空旧值**：`text()` 是装配期同步取用的，清空会出现一次「没有人格」
     * 的空窗；这里只是让缓存不再新鲜，新人格一到就替换掉。失败时旧人格继续顶着
     * ——与 resolve() 的失败策略一致：旧的好过没有。
     */
    reset(): void;
};
/** 解析器类型。 */
export type RoleResolver = ReturnType<typeof createRoleResolver>;
