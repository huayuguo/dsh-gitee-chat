/**
 * Gitee 访问令牌解析：**单一真源**。
 *
 * 顺序与 `scripts/gitee/gq.mjs` 的 `resolveToken()` 逐字一致：
 *   1. 环境变量 `GITEE_ENT_MCP_ACCESS_TOKEN` → `GITEE_ACCESS_TOKEN` → `GITEE_TOKEN`（trim 后非空）
 *   2. token 文件 `$DSH_HOME/.gitee-chat/token` → `$DSH_HOME/gitee-chat-token` → `~/.gitee-token`
 *
 * **为什么要吃文件**：桌面版 DSH 从开始菜单启动时**不继承 shell 的 `export`**，
 * 设置界面「Gitee 企业项目」写下的正是第一份文件。只读环境变量就会出现
 * 「界面里配好了、取数却说没令牌」——preset 里 mcp-gitee 行的 env 表达式与
 * 本模块共用同一份顺序，两边**不能再各写一套**。
 *
 * ⚠️ **永远返回字符串**：调用方（MCP 行的 env、wiki 克隆的子进程）都要求字符串；
 * 返回 `undefined` 会让整行 config 校验失败（`z.dict(String)`），
 * 进而让 preset 永久「加载失败」且不会自愈。
 *
 * @module dsh-gitee-chat/host/token
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 令牌环境变量名：数组顺序即优先级（与 gq.mjs 一致）。 */
export const TOKEN_ENVS = ['GITEE_ENT_MCP_ACCESS_TOKEN', 'GITEE_ACCESS_TOKEN', 'GITEE_TOKEN'] as const

/** DSH 主目录（与 gq 脚本同一条约定）。 */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 允许的 token 文件位置（按优先级）。只读，不写。 */
export function tokenFileCandidates(): string[] {
  return [
    join(dshHome(), '.gitee-chat', 'token'),
    join(dshHome(), 'gitee-chat-token'),
    join(homedir(), '.gitee-token'),
  ]
}

/**
 * 界面设置入口写入的那一份（`/token` POST 的落点），也就是列表里的第一位。
 * @returns token 文件绝对路径。
 */
export function tokenFilePath(): string {
  return join(dshHome(), '.gitee-chat', 'token')
}

/**
 * 解析访问 token：环境变量 → token 文件。**永不抛**，找不到返回空串。
 * @returns 去掉首尾空白的 token，或 `''`。
 */
export function resolveToken(): string {
  for (const name of TOKEN_ENVS) {
    const value = process.env[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  for (const file of tokenFileCandidates()) {
    if (!existsSync(file)) continue
    try {
      const value = readFileSync(file, 'utf8').trim()
      if (value !== '') return value
    } catch {
      // 读不动（权限/被占用）就当这一份不存在，继续下一个候选。
    }
  }
  return ''
}
