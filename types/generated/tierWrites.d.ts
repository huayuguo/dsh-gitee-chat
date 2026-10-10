/**
 * 本文件由 scripts/gen-capabilities.mjs 从 scripts/gitee/gq.mjs 的 TIERS 生成，请勿手改。
 *
 * 用途：host 半的公开 gateway（`gitee_ent`）在只读部署下必须硬拦写工具，
 * 而那个判定不能依赖「身份已经解析出来」——`role.current()` 可能是 null。
 */
/** 三档写工具名的并集（= 只读部署必须硬拦的全部工具）。 */
export declare const WRITE_TOOLS: readonly string[];
/** 各档自己的写工具（exec ⊂ project ⊂ manager）。 */
export declare const WRITE_TOOLS_BY_TIER: Readonly<Record<'exec' | 'project' | 'manager', readonly string[]>>;
