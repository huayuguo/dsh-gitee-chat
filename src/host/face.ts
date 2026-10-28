/**
 * host 半发布给 agent 平面的服务面。
 *
 * 单独成文件是为了让 `./index`（host）与 `./agent`（preset）共享同一个类型，
 * 而不互相 import 运行时实现——两个入口会被 esbuild 分别打包，
 * 类型共享不产生运行时耦合。
 *
 * @module dsh-gitee-chat/host/face
 */

import type { GqRunner } from './gq.ts'
import type { McpInspection } from './mcpBinary.ts'
import type { RoleResolver } from './role.ts'
import type { IssueWriter } from './write.ts'

/** host 半发布的服务值。 */
export interface GiteeChatFace {
  /** 取数执行器（脚本执行 + 进程内缓存 + 样例降级）。 */
  readonly runner: GqRunner
  /** 身份/人格解析器（进程级缓存，装配期同步取用）。 */
  readonly role: RoleResolver
  /** **唯一写入口**（改状态 / 评论 / 改派）。UI 与路由都走它。 */
  readonly writer: IssueWriter
  /**
   * 随包 MCP 后端的只读状态。
   *
   * 存在的意义：同事问「为什么 AI 建不了项目 / 改不了 Gitee 上的东西」时，
   * 答案是 MCP 那侧的事（二进制没落地、被换成了没有 create_program 的上游版），
   * 而取数自检（`runner.health`）看不出这一点——它是 gq 脚本那条通道。
   */
  readonly mcp: () => McpInspection
  /** host 半解析后的配置（agent 半只读，便于自检/诊断）。 */
  readonly hostConfig: {
    readonly scriptPath: string
    readonly enterpriseId: number
    readonly mode: string
    /** 写通道是否开启（只读部署为 false）。 */
    readonly allowWrites: boolean
    /** 覆盖后的企业版 UA（空串 = 用脚本内置默认值）。 */
    readonly userAgent: string
    /**
     * 本插件 MCP 工具名的前缀（= `mcp__<preset serverName>__`）。
     *
     * 与 `docs.mcpToolPrefix` 同源：agent 半的能力档门禁靠它把「本插件的 Gitee
     * 工具」与「同一个 preset 里别的 MCP server 的工具」分开 —— 只看 `mcp__`
     * 会拿 Gitee 的档位表去审别家的工具（2026-09-17 实测误伤，见 `./agent`）。
     */
    readonly mcpToolPrefix: string
    /**
     * 看板快照缓存的口径（agent 半用它决定「快照工具能不能读、读到的东西旧不旧」）。
     *
     * 三者与设置页表单一一对应：`cache.agentReadable` / `cache.persist` / `cache.ttlSeconds`。
     */
    readonly cache: {
      /** 会话里的 AI 是否能读快照（false = 只给界面用）。 */
      readonly agentReadable: boolean
      /** 是否落盘（false = 只有进程内缓存）。 */
      readonly persist: boolean
      /** 新鲜期秒数（0 = 不做缓存）。 */
      readonly ttlSeconds: number
    }
  }
}
