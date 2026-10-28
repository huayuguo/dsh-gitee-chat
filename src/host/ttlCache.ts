/**
 * 极小的 TTL 内存缓存 + 并发单飞（同一 key 同时只有一个在飞）。
 *
 * 为什么要它：**打开 Gitee 项目面板会连着打好几个取数路由**，而每次取数都是一次
 * `node gq.mjs` 子进程 + 一次 HTTPS 往返（实测企业 API 单请求 RTT ≈0.19s，其中 TLS
 * 握手 0.13s；子进程启动 ≈0.08s）。重复点开同一个项目时不该重付这些钱，同时并发
 * 打开两个面板也不该各拉一遍。
 *
 * 口径：
 *  - 只缓存**读**路由的已解析 JSON，键是「路径 + 查询串」（去掉 refresh）；
 *  - TTL 内直接命中，TTL 外视为未命中；
 *  - `refresh=1` 由调用方显式绕过（不在这里判断，调用方决定是否走缓存）；
 *  - 进程内有效，不落盘（与 gq 的「不落数据库」口径一致）。
 *
 * @module dsh-gitee-chat/host/ttlCache
 */

/** 缓存配置。 */
export interface TtlCacheOptions {
  /** 条目存活时间（毫秒），默认 30s。 */
  ttlMs?: number
  /** 最多保留多少条（超出淘汰最旧的），默认 200。 */
  maxEntries?: number
}

/** 带单飞的 TTL 缓存。 */
export interface TtlCache {
  /** 取未过期的值；未命中返回 undefined。 */
  get<T>(key: string): T | undefined
  /** 写入一条。 */
  set(key: string, value: unknown): void
  /** 命中即返回；否则调 fn（同 key 并发只执行一次）。 */
  wrap<T>(key: string, fn: () => Promise<T>): Promise<T>
  /** 当前条目数（测试/诊断用）。 */
  size(): number
  /** 清空。 */
  clear(): void
}

interface Entry {
  at: number
  value: unknown
}

/** 创建一个 TTL 缓存。 */
export function createTtlCache(options: TtlCacheOptions = {}): TtlCache {
  const ttlMs = options.ttlMs ?? 30_000
  const maxEntries = options.maxEntries ?? 200
  const store = new Map<string, Entry>()
  const inflight = new Map<string, Promise<unknown>>()

  const get = <T>(key: string): T | undefined => {
    const hit = store.get(key)
    if (hit === undefined) return undefined
    if (Date.now() - hit.at > ttlMs) {
      store.delete(key)
      return undefined
    }
    return hit.value as T
  }

  const set = (key: string, value: unknown): void => {
    store.set(key, { at: Date.now(), value })
    // Map 保持插入顺序：超限时删最旧的一条
    while (store.size > maxEntries) {
      const oldest = store.keys().next()
      if (oldest.done === true) break
      store.delete(oldest.value)
    }
  }

  const wrap = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const hit = get<T>(key)
    if (hit !== undefined) return Promise.resolve(hit)
    const pending = inflight.get(key)
    if (pending !== undefined) return pending as Promise<T>
    const task = fn()
      .then((value) => {
        set(key, value)
        return value
      })
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, task)
    return task
  }

  return {
    get,
    set,
    wrap,
    size: () => store.size,
    clear: () => {
      store.clear()
      inflight.clear()
    },
  }
}
