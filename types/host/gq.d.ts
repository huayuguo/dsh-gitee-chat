/**
 * gq 取数执行器：把「模型触发」翻译成「脚本拉取」，并保住结果供卡片取用。
 *
 * 分工（这是本包的核心口径）：
 *   - **模型侧**：只拿到 payload.summary（紧凑 Markdown，几十 token）。
 *   - **卡片侧**：经 /api/gitee-chat/payload 拿完整结构化 payload，不经过模型。
 *   - **不落数据库**：数据以会话拉取为准。唯一落盘是可选的同参数秒级缓存
 *     （由脚本自己在 /tmp 里管），宿主这层只保存**进程内**结果。
 *
 * @module dsh-gitee-chat/host/gq
 */
import type { BoardPayload, BoardScope, HealthResponse } from '../types.ts';
/** 包根目录（bundle 位于 <root>/lib/index.js）。 */
export declare function packageRoot(): string;
/** 默认脚本路径：<root>/scripts/gitee/gq.mjs。 */
export declare function defaultScriptPath(): string;
/** 一次取数请求。 */
export interface RunRequest {
    scope: BoardScope;
    /** 聚焦单个项目。 */
    program?: number;
    /** 忽略宿主进程内缓存，强制重新执行脚本。 */
    refresh?: boolean;
}
/** 一次取数结果。 */
export interface RunResult {
    payload: BoardPayload;
    /** 本次是否直接命中宿主缓存。 */
    cached: boolean;
    /** 是否降级为样例数据。 */
    degraded: boolean;
}
/** 执行器配置。 */
export interface RunnerOptions {
    /** 脚本绝对路径；缺省用包内默认位置。 */
    scriptPath?: string;
    /** 单次脚本执行超时（毫秒）。 */
    timeoutMs?: number;
    /** 传给脚本的 API base（可选覆盖）。 */
    apiBase?: string;
    /** 无 token 时是否自动降级为样例数据。 */
    allowFixtureFallback?: boolean;
    /**
     * 固定使用的企业 id（0/未设 = 交给脚本解析：唯一企业自动用，
     * 多企业时脚本会报错并要求显式指定，绝不静默挑一个）。
     */
    enterpriseId?: number;
    /**
     * 额外注入子进程的环境变量（覆盖继承来的同名值）。
     *
     * 用途：把宿主配置里的 UA 与阈值翻译成脚本认识的 `GITEE_*` 变量，
     * 让「配置在哪设」与「阈值单一真源在脚本里」两件事不冲突。
     */
    env?: NodeJS.ProcessEnv;
}
/** 取数失败：带一个可判定的 code，供路由映射 HTTP 语义。 */
export declare class GqError extends Error {
    readonly code: 'no-token' | 'script-failed' | 'timeout';
    constructor(code: 'no-token' | 'script-failed' | 'timeout', message: string);
}
/** 生成缓存键（与脚本内部的键保持一致，便于两层缓存对齐）。 */
export declare function cacheKeyOf(request: RunRequest): string;
/**
 * 创建取数执行器：进程内缓存 + 脚本执行 + 可选样例数据降级。
 * @param options - 脚本路径、超时、降级开关。
 */
export declare function createGqRunner(options?: RunnerOptions): {
    /** 脚本是否就位（用于启动期诊断）。 */
    scriptPath: string;
    /**
     * 插件配置钉住的企业（0 = 不钉，交给脚本按 flag/env/文件/自动 解析）。
     *
     * 暴露出来是为了让设置页能如实说明「你在这里选也无效，配置里钉死了」——
     * 而不是让使用者对着一个选了不生效的下拉框自己猜。见 host/enterprise.ts。
     */
    enterpriseId: number;
    scriptExists(): boolean;
    /** 缓存里的当前值（不触发拉取）。 */
    peek(key: string): BoardPayload | undefined;
    /** 清空进程内缓存。 */
    clear(): void;
    /**
     * 取数：命中缓存直接返回；否则执行脚本。
     * @param request - 范围与可选项目。
     */
    run(request: RunRequest): Promise<RunResult>;
    /**
     * 取缓存；未命中则现拉一次（卡片在宿主重启后仍能自愈）。
     * @param request - 范围与可选项目。
     */
    payloadFor(request: RunRequest): Promise<RunResult>;
    /** 环境自检（透传 gq health）。 */
    health(): Promise<HealthResponse>;
    /**
     * 跑任意 gq 子命令并解析其单行 JSON 产出。
     *
     * 存在的意义：人格解析（`gq role`）与看板取数（`gq portfolio`）走的是同一条
     * 脚本通道与同一套 token 解析，不另开 API 客户端。
     * @param args - 子命令与参数（不含 --json，由本方法统一追加）。
     * @param useFixture - 是否改用样例数据（无 token 时的渲染/自检路径）。
     */
    execJson<T>(args: string[], useFixture?: boolean): Promise<T>;
    /**
     * 与 `execJson` 相同，但把 `stdin` 交给脚本。
     *
     * 写通道专用：评论正文可能几千字，塞进 argv 会撞命令行长度上限，
     * 也会把内容暴露在进程列表里。
     * @param args - 子命令与参数。
     * @param stdin - 要写入子进程标准输入的内容。
     * @param useFixture - 是否走样例数据。
     */
    execJsonWithInput<T>(args: string[], stdin: string | undefined, useFixture?: boolean): Promise<T>;
    /** 是否允许在无 token 时降级为样例数据。 */
    fixtureFallback: boolean;
};
/** 执行器类型。 */
export type GqRunner = ReturnType<typeof createGqRunner>;
