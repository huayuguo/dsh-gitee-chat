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

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BoardPayload, BoardScope, HealthResponse } from '../types.ts'
import type { SnapshotRecord, SnapshotStore } from './snapshotStore.ts'

/** 包根目录（bundle 位于 <root>/lib/index.js）。 */
export function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/** 默认脚本路径：<root>/scripts/gitee/gq.mjs。 */
export function defaultScriptPath(): string {
  return join(packageRoot(), 'scripts', 'gitee', 'gq.mjs')
}

/** 一次取数请求。 */
export interface RunRequest {
  scope: BoardScope
  /** 聚焦单个项目。 */
  program?: number
  /** 忽略宿主进程内缓存，强制重新执行脚本。 */
  refresh?: boolean
}

/** 一次取数结果。 */
export interface RunResult {
  payload: BoardPayload
  /** 本次是否直接命中宿主缓存。 */
  cached: boolean
  /** 是否降级为样例数据。 */
  degraded: boolean
  /** 这份数据的**抓取时刻**（epoch ms）；命中缓存时是原抓取时刻，不是当下。 */
  fetchedAt: number
  /** 数据已存在多久（毫秒）。 */
  ageMs: number
  /** 是否已超过新鲜期（TTL）——调用方必须据此提醒「可能不是最新」。 */
  stale: boolean
  /** 当前生效的新鲜期（毫秒，0 = 不做缓存）。 */
  ttlMs: number
  /** 数据来自哪一层：`remote` 现拉、`memory` 进程内、`disk` 落盘快照。 */
  source: 'remote' | 'memory' | 'disk'
}

/** 执行器配置。 */
export interface RunnerOptions {
  /** 脚本绝对路径；缺省用包内默认位置。 */
  scriptPath?: string
  /** 单次脚本执行超时（毫秒）。 */
  timeoutMs?: number
  /**
   * 进程内结果的新鲜期（毫秒）。
   *
   * 不设上限的缓存会把「十分钟前拉到的看板」一直端出来，用户以为数据没更新；
   * 超时后虽然复用缓存的旧值会更快，但必须让刷新真正能拿到新数据，所以给个 TTL。
   */
  /**
   * 新鲜期（毫秒）。`0` = 不读缓存（每次现拉）。
   *
   * 可以是函数：设置页里 `cache.ttlSeconds` 是 volatile 字段，改了要立刻生效，
   * 所以宿主传进来的是「现取」的函数而不是装配期的常量。
   */
  memoTtlMs?: number | (() => number)
  /** 传给脚本的 API base（可选覆盖）。 */
  apiBase?: string
  /** 无 token 时是否自动降级为样例数据。 */
  allowFixtureFallback?: boolean
  /**
   * 固定使用的企业 id（0/未设 = 交给脚本解析：唯一企业自动用，
   * 多企业时脚本会报错并要求显式指定，绝不静默挑一个）。
   */
  enterpriseId?: number
  /**
   * 额外注入子进程的环境变量（覆盖继承来的同名值）。
   *
   * 用途：把宿主配置里的 UA 与阈值翻译成脚本认识的 `GITEE_*` 变量，
   * 让「配置在哪设」与「阈值单一真源在脚本里」两件事不冲突。
   */
  env?: NodeJS.ProcessEnv
  /**
   * 落盘快照仓库（可选）。
   *
   * 加上它以后：进程重启后第一次打开面板也能先端出上一次的快照（`source: 'disk'`），
   * 再由下一次刷新纠正——这正是「重启后首屏 1.5 s → 0」的那一半。
   */
  persist?: SnapshotStore
  /** 是否允许读写落盘快照（`cache.persist` 的实时开关；缺省 true）。 */
  persistEnabled?: () => boolean
}

/** 取数失败：带一个可判定的 code，供路由映射 HTTP 语义。 */
export class GqError extends Error {
  constructor(
    readonly code: 'no-token' | 'script-failed' | 'timeout',
    message: string,
  ) {
    super(message)
    this.name = 'GqError'
  }
}

/** 把脚本的 stderr/退出码归一成结构化错误。 */
function classify(error: unknown): GqError {
  const err = error as { killed?: boolean; signal?: string; stderr?: string; message?: string }
  if (err?.killed === true || err?.signal === 'SIGTERM') {
    return new GqError('timeout', 'gq 脚本执行超时')
  }
  // 注意：用 `||` 而非 `??`——execFile 在非零退出时可能给出**空字符串** stderr，
  // 空串不是 nullish，会让 `??` 短路掉真正的 error.message。
  const detail = String(err?.stderr || err?.message || '未知错误').trim().slice(0, 500)
  if (/token/i.test(detail) && /未(找到|配置)/.test(detail)) {
    return new GqError('no-token', detail)
  }
  return new GqError('script-failed', detail)
}

/** 生成缓存键（与脚本内部的键保持一致，便于两层缓存对齐）。 */
export function cacheKeyOf(request: RunRequest): string {
  return `${request.scope}:${request.program ?? 'all'}`
}

/**
 * 创建取数执行器：进程内缓存 + 脚本执行 + 可选样例数据降级。
 * @param options - 脚本路径、超时、降级开关。
 */
export function createGqRunner(options: RunnerOptions = {}) {
  const scriptPath = options.scriptPath ?? defaultScriptPath()
  const timeoutMs = options.timeoutMs ?? 60_000
  const allowFixtureFallback = options.allowFixtureFallback ?? false
  const enterpriseId = options.enterpriseId ?? 0

  /** 进程内结果（不是数据库：进程退出即消失）。现取，兼容常量与函数两种写法。 */
  const memoTtlMsOf = (): number => {
    const raw = options.memoTtlMs
    const value = typeof raw === 'function' ? raw() : raw ?? 60_000
    return Number.isFinite(value) ? Math.max(0, Number(value)) : 60_000
  }
  /** 进程内结果（带时间戳，过期即视为未命中）。 */
  const memo = new Map<string, { payload: BoardPayload; at: number }>()
  /** 落盘快照（可选；重启后仍能端出上次的数据）。 */
  const persist = options.persist
  /** 落盘是否启用（实时开关）。 */
  const persistOn = (): boolean => persist !== undefined && options.persistEnabled?.() !== false
  /**
   * 最近一次「有人在用面板」的时刻（epoch ms）。
   *
   * 自动刷新拿它当闸门：没人看的时候不要每 60 秒去翻 4 页 Gitee，
   * 那既浪费限流额度，也会让日志里全是无人消费的取数。
   */
  let lastActivityAt = 0

  /** 记一次活动（路由/工具每次被调用时打点）。 */
  function touch(): void {
    lastActivityAt = Date.now()
  }

  /** 把一条缓存记录翻译成带新鲜度元数据的取数结果。 */
  function asResult(record: SnapshotRecord, source: 'memory' | 'disk'): RunResult {
    const ageMs = Math.max(0, Date.now() - record.fetchedAt)
    return {
      payload: record.payload,
      cached: true,
      degraded: record.payload.source === 'fixture',
      fetchedAt: record.fetchedAt,
      ageMs,
      stale: memoTtlMsOf() <= 0 || ageMs > memoTtlMsOf(),
      ttlMs: memoTtlMsOf(),
      source,
    }
  }

  /**
   * 起飞前检查脚本本身是否可用。
   *
   * 存在的意义：脚本路径配置错/包不完整时，`execFile` 的表现可以极其误导——
   * 传入空路径时 Node 会**从 stdin 读脚本**，stdin 立刻 EOF，于是退出码 0、
   * 零输出，上层只能得到一句「输出不是 JSON」。宁可在起飞前把原因说清楚。
   * @returns 不可用时的错误；可用时返回 null。
   */
  function preflight(): GqError | null {
    if (scriptPath.trim() === '') {
      return new GqError(
        'script-failed',
        'gq 脚本路径为空：配置里的 scriptPath 是空串，而 `??` 式的默认值兜底不会接管空串。'
        + '请删除该键（省略 = 用包内 scripts/gitee/gq.mjs），或填入绝对路径。',
      )
    }
    if (!existsSync(scriptPath)) {
      return new GqError(
        'script-failed',
        `gq 脚本不存在：${scriptPath}（插件安装不完整，或配置里的 scriptPath 指错了地方）`,
      )
    }
    return null
  }

  /** 跑一次脚本，返回解析后的 payload 文本。 */
  function spawnGq(args: string[], fixture: boolean, stdin?: string): Promise<string> {
    const blocked = preflight()
    if (blocked !== null) return Promise.reject(blocked)

    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) }
      if (options.apiBase) env.GITEE_ENT_API_BASE = options.apiBase
      if (fixture) env.GITEE_CHAT_FIXTURE = '1'
      const argv = [scriptPath, ...args, '--json']
      if (fixture) argv.push('--fixture')
      // 显式指定的企业优先于脚本自己的解析顺序（flag > env > 配置文件 > 自动）
      if (enterpriseId > 0) argv.push('--enterprise', String(enterpriseId))
      const child = execFile(process.execPath, argv, {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env,
        cwd: dirname(scriptPath),
      }, (error, stdout, stderr) => {
        const out = String(stdout ?? '')
        // 脚本在 --json 模式下**即使失败也把 {ok:false,error} 信封写到 stdout**，
        // 所以只要 stdout 有内容就交给 parsePayload 判别，别丢了这个信封。
        if (error && out.trim() === '') {
          reject(Object.assign(error as object, { stderr }))
          return
        }
        resolve(out)
      })
      // 正文（如评论内容）走 stdin：不塞 argv，避免撞命令行长度上限，
      // 也避免把内容暴露在进程列表里。
      if (stdin !== undefined) {
        child.stdin?.end(stdin)
      } else {
        child.stdin?.end()
      }
    })
  }

  /**
   * 脚本跑通了但没吐出 JSON 时的报错文案。
   *
   * 空输出要单独说：它最常见的成因不是「脚本坏了」，而是**根本没执行到脚本**，
   * 报「输出不是 JSON：」会把人引向错误方向。
   */
  function notJsonMessage(args: string[], line: string): string {
    const prefix = `gq ${args[0] ?? ''} `.trimEnd()
    if (line === '') {
      return `${prefix} 没有任何输出（退出码 0）：脚本 ${scriptPath} 未被真正执行，`
        + '通常意味着 scriptPath 为空或被指向了别的文件；可用 '
        + `\`node ${scriptPath} health\` 自查。`
    }
    return `${prefix} 输出不是 JSON：${line.slice(0, 200)}`
  }

  /** 解析脚本 stdout 为 payload，并识别脚本自己报的业务失败。 */
  function parsePayload(raw: string): BoardPayload {
    const line = raw.trim().split('\n').filter(Boolean).pop() ?? ''
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new GqError('script-failed', notJsonMessage([''], line))
    }
    const record = parsed as { ok?: boolean; error?: string } & Partial<BoardPayload>
    if (record.ok !== true) {
      const message = record.error ?? '脚本报告失败'
      throw new GqError(/token/i.test(message) ? 'no-token' : 'script-failed', message)
    }
    return parsed as BoardPayload
  }

  return {
    /** 脚本是否就位（用于启动期诊断）。 */
    scriptPath,
    /**
     * 插件配置钉住的企业（0 = 不钉，交给脚本按 flag/env/文件/自动 解析）。
     *
     * 暴露出来是为了让设置页能如实说明「你在这里选也无效，配置里钉死了」——
     * 而不是让使用者对着一个选了不生效的下拉框自己猜。见 host/enterprise.ts。
     */
    enterpriseId,
    scriptExists(): boolean {
      return existsSync(scriptPath)
    },
    /** 缓存里的当前值（不触发拉取）。 */
    peek(key: string): BoardPayload | undefined {
      return memo.get(key)?.payload
    },
    /** 读一份快照（进程内 → 落盘），**不发任何网络请求**；没有则 undefined。 */
    snapshot(request: RunRequest): RunResult | undefined {
      const key = cacheKeyOf(request)
      const hit = memo.get(key)
      if (hit !== undefined) return asResult({ payload: hit.payload, fetchedAt: hit.at }, 'memory')
      const onDisk = persistOn() ? persist?.read(key) : undefined
      return onDisk === undefined ? undefined : asResult(onDisk, 'disk')
    },
    /** 记一次活动（自动刷新用它判断「还有没有人在看」）。 */
    touch,
    /** 最近一次活动距今多久（毫秒；从未活动返回 Infinity）。 */
    idleMs(): number {
      return lastActivityAt === 0 ? Number.POSITIVE_INFINITY : Date.now() - lastActivityAt
    },
    /** 当前生效的新鲜期（毫秒）。 */
    ttlMs: memoTtlMsOf(),
    /** 清空进程内缓存与落盘快照。 */
    clear(): void {
      memo.clear()
      persist?.clear()
    },
    /**
     * 取数：命中缓存直接返回；否则执行脚本。
     * @param request - 范围与可选项目。
     */
    async run(request: RunRequest): Promise<RunResult> {
      const key = cacheKeyOf(request)
      touch()
      if (!request.refresh) {
        const hit = memo.get(key)
        if (hit !== undefined && memoTtlMsOf() > 0 && Date.now() - hit.at < memoTtlMsOf()) {
          return asResult({ payload: hit.payload, fetchedAt: hit.at }, 'memory')
        }
        // 进程内没有（例如刚重启）→ 看落盘快照是否还在新鲜期内
        const onDisk = persist?.read(key)
        if (onDisk !== undefined && memoTtlMsOf() > 0 && Date.now() - onDisk.fetchedAt < memoTtlMsOf()) {
          memo.set(key, { payload: onDisk.payload, at: onDisk.fetchedAt })
          return asResult(onDisk, 'disk')
        }
      }

      const args = [request.scope]
      if (request.program !== undefined) args.push('--program', String(request.program))

      try {
        const payload = parsePayload(await spawnGq(args, false))
        const at = Date.now()
        memo.set(key, { payload, at })
        if (persistOn()) persist?.write(key, { payload, fetchedAt: at })
        return {
          payload,
          cached: false,
          degraded: false,
          fetchedAt: at,
          ageMs: 0,
          stale: false,
          ttlMs: memoTtlMsOf(),
          source: 'remote',
        }
      } catch (error) {
        const failure = error instanceof GqError ? error : classify(error)
        if (allowFixtureFallback && failure.code === 'no-token') {
          const payload = parsePayload(await spawnGq(args, true))
          const at = Date.now()
          memo.set(key, { payload, at })
          return {
            payload,
            cached: false,
            degraded: true,
            fetchedAt: at,
            ageMs: 0,
            stale: false,
            ttlMs: memoTtlMsOf(),
            source: 'remote',
          }
        }
        throw failure
      }
    },
    /**
     * 取缓存；未命中则现拉一次（卡片在宿主重启后仍能自愈）。
     * @param request - 范围与可选项目。
     */
    async payloadFor(request: RunRequest): Promise<RunResult> {
      return this.run(request)
    },
    /** 环境自检（透传 gq health）。 */
    async health(): Promise<HealthResponse> {
      try {
        const raw = await spawnGq(['health'], false)
        // health 输出是**缩进过的多行 JSON**，必须整段解析——
        // 不能用 parsePayload 的「取最后一行」，那只会拿到一个 `}`。
        return JSON.parse(raw.trim()) as HealthResponse
      } catch (error) {
        if (error instanceof SyntaxError) {
          return { ok: false, stage: 'script-failed', message: `无法解析 gq health 输出：${error.message}` }
        }
        const failure = error instanceof GqError ? error : classify(error)
        return { ok: false, stage: failure.code, message: failure.message }
      }
    },

    /**
     * 跑任意 gq 子命令并解析其单行 JSON 产出。
     *
     * 存在的意义：人格解析（`gq role`）与看板取数（`gq portfolio`）走的是同一条
     * 脚本通道与同一套 token 解析，不另开 API 客户端。
     * @param args - 子命令与参数（不含 --json，由本方法统一追加）。
     * @param useFixture - 是否改用样例数据（无 token 时的渲染/自检路径）。
     */
    async execJson<T>(args: string[], useFixture = false): Promise<T> {
      return await execParsed<T>(args, useFixture, undefined)
    },

    /**
     * 与 `execJson` 相同，但把 `stdin` 交给脚本。
     *
     * 写通道专用：评论正文可能几千字，塞进 argv 会撞命令行长度上限，
     * 也会把内容暴露在进程列表里。
     * @param args - 子命令与参数。
     * @param stdin - 要写入子进程标准输入的内容。
     * @param useFixture - 是否走样例数据。
     */
    async execJsonWithInput<T>(args: string[], stdin: string | undefined, useFixture = false): Promise<T> {
      return await execParsed<T>(args, useFixture, stdin)
    },

    /** 是否允许在无 token 时降级为样例数据。 */
    fixtureFallback: allowFixtureFallback,
  }

  /** 跑一次脚本并解析它的 JSON 信封（execJson / execJsonWithInput 共用）。 */
  async function execParsed<T>(args: string[], useFixture: boolean, stdin: string | undefined): Promise<T> {
    const raw = await spawnGq(args, useFixture, stdin)
    const line = raw.trim().split('\n').filter(Boolean).pop() ?? ''
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new GqError('script-failed', notJsonMessage(args, line))
    }
    const record = parsed as { ok?: boolean; error?: string }
    if (record?.ok !== true) {
      const message = record?.error ?? '脚本报告失败'
      throw new GqError(/token/i.test(message) ? 'no-token' : 'script-failed', message)
    }
    return parsed as T
  }
}

/** 执行器类型。 */
export type GqRunner = ReturnType<typeof createGqRunner>
