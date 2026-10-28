/**
 * 看板快照的**落盘**缓存。
 *
 * 为什么要有这一层（用户口径 m02181 / m02223）：
 *   进程内 `Map` 一重启就清空，于是「重启后第一次打开项目」永远要现拉
 *   （307 条工作项 = 4 页，Gitee 单次 RTT 0.4–1.3 s，冷启 1.5 s 起步）。
 *   落盘以后重启也能先端出上一次的快照，再由后台/下一次刷新纠正。
 *
 * 边界（刻意保守）：
 *   - **只存看板 payload**（工作项 / 项目 / 成员 / 分析），不存 token、不存正文；
 *   - 目录 `0700`、文件 `0600`，写用「临时文件 + rename」原子替换；
 *   - 每条记录带 `fetchedAt`，读的一侧必须自己判断新鲜度——本模块**不**做 TTL，
 *     免得「存储层」和「业务层」各有一套过期口径。
 *
 * @module dsh-gitee-chat/host/snapshotStore
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BoardPayload } from '../types.ts'

/** 一条快照记录：数据本体 + 抓取时刻。 */
export interface SnapshotRecord {
  /** 抓到这份数据的时刻（epoch ms）。 */
  fetchedAt: number
  /** 看板 payload 本体（与 /payload 返回的一致）。 */
  payload: BoardPayload
}

/** 落盘快照仓库。 */
export interface SnapshotStore {
  /** 根目录（`$DSH_HOME/.gitee-chat/cache/board`）。 */
  readonly root: string
  /** 读一条快照；不存在/损坏返回 undefined（不抛）。 */
  read(key: string): SnapshotRecord | undefined
  /** 原子写入一条快照。 */
  write(key: string, record: SnapshotRecord): void
  /** 删除一条快照（忽略不存在）。 */
  remove(key: string): void
  /** 清空整个目录（用途：只读部署 / 换企业后清场）。 */
  clear(): void
}

/** 把缓存 key 收敛成安全的文件名（key 由 scope+program 拼出来，含 `:` 与数字）。 */
function fileNameOf(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9._-]+/g, '_')
  return `${safe === '' ? 'board' : safe}.json`
}

/**
 * 创建落盘快照仓库。
 * @param root - 缓存目录（不存在会自动建，权限 0700）。
 * @param logger - 可选日志；落盘失败只降级为告警，不影响取数。
 * @returns 快照仓库。
 */
export function createSnapshotStore(
  root: string,
  logger?: { warn?: (message: string) => void },
): SnapshotStore {
  function ensure(): void {
    mkdirSync(root, { recursive: true, mode: 0o700 })
  }

  return {
    root,

    read(key: string): SnapshotRecord | undefined {
      const file = join(root, fileNameOf(key))
      try {
        const text = readFileSync(file, 'utf8')
        const parsed = JSON.parse(text) as Partial<SnapshotRecord>
        if (typeof parsed?.fetchedAt !== 'number' || parsed.payload === undefined) return undefined
        return { fetchedAt: parsed.fetchedAt, payload: parsed.payload }
      } catch {
        return undefined
      }
    },

    write(key: string, record: SnapshotRecord): void {
      const file = join(root, fileNameOf(key))
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
      try {
        ensure()
        writeFileSync(tmp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 })
        chmodSync(tmp, 0o600)
        renameSync(tmp, file)
      } catch (error) {
        logger?.warn?.(`[dsh-gitee-chat] 看板快照落盘失败（${key}）：${String(error)}`)
        try {
          rmSync(tmp, { force: true })
        } catch {
          // 临时文件清不掉也不影响主流程
        }
      }
    },

    remove(key: string): void {
      try {
        rmSync(join(root, fileNameOf(key)), { force: true })
      } catch {
        // 忽略
      }
    },

    clear(): void {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // 忽略
      }
    },
  }
}
