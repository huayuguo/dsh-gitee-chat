/**
 * dsh-gitee-chat · **agent（preset）平面**。
 *
 * 与 host 半（`./index`）的分工，是本插件最重要的一条架构纪律：
 *
 * | | host 半（profile bundle） | agent 半（本文件，preset 行） |
 * |---|---|---|
 * | 取数执行器 / 身份解析 | ✅ 拥有 | 消费 |
 * | HTTP 路由（卡片数据） | ✅ 拥有 | — |
 * | 公开 gateway `gitee_ent` | ✅ 注册（对所有 preset） | ✅ `restrict` 隐藏 |
 * | 触发型工具 | — | ✅ 注册 |
 * | 人格上下文注入 | — | ✅ 注册 |
 * | 能力档门禁 | — | ✅ 注册 |
 *
 * **为什么必须分开**：host 半挂在 profile 里，它的注册对所有 preset 生效。
 * 早先版本把工具与人格注入写在 host 半，结果 PTC 等无关 preset 的新会话
 * 也被注入了 Gitee 人格、也能看到 Gitee 工具——这是错误的平面归属。
 * 现在这些东西只在**挂了本行的 preset**（两个 Gitee 模式）里才有；
 * 唯一的例外是公开 gateway（MCP 是工具类后端，用户 2026-10-10 要求公共化），
 * 它由 host 半注册、再由本文件 `restrict` 从 Gitee 会话里隐藏（DESIGN.md §37）。
 *
 * @module dsh-gitee-chat/agent
 */

import z from 'schemastery'
import { DEFAULT_MCP_TOOL_PREFIX, PUBLIC_GATEWAY_TOOL_NAME, rawMcpToolName } from './mcpNaming.ts'
import { giteeChatTools } from './host/tools.ts'
import type { GiteeChatFace } from './host/face.ts'

/** 插件身份。 */
export const name = 'dsh-gitee-chat-agent'

/**
 * 硬依赖：
 *  - `giteeChat`：host 半发布的能力（执行器 + 身份解析器），由 profile 提供；
 *  - `tools`：注册触发型工具。
 * `systemPrompt` 用可选获取（缺失时只是不注入人格，不该拖垮整个 preset）。
 */
export const inject = ['giteeChat', 'tools']

/** agent 平面配置（只管"这个 preset 里的 agent 能用什么"）。 */
export interface Config {
  /** 是否把推导出的人格作为运行上下文注入每一轮（默认 true）。 */
  injectPersona?: boolean
  /** 是否启用能力档门禁：按人格拒绝越权 MCP 调用（默认 true）。 */
  enforceTier?: boolean
}

/** Loader 用的校验模式。 */
export const Config: z<Config> = z.object({
  injectPersona: z.boolean(),
  enforceTier: z.boolean(),
})

/** 补齐默认值。 */
export function resolveConfig(config?: Config) {
  return {
    injectPersona: config?.injectPersona ?? true,
    enforceTier: config?.enforceTier ?? true,
  }
}

/** 能力档的中文名（门禁拒绝理由里用）。 */
const TIER_LABELS: Record<string, string> = {
  manager: '管理者',
  project: '项目执行 · 负责人档',
  exec: '项目执行 · 执行档',
}

/**
 * 从 wire 工具名里取出本插件 MCP server 的原始工具名。
 *
 * 实现与规则说明在 `./mcpNaming`（host 半与 agent 半共用同一份，因为两个入口
 * 分别打包）。这里再导出，保持 `lib/agent.js` 的既有公开路径与冒烟测试入口。
 */
export { rawMcpToolName }

/**
 * agent 平面插件主体：把 host 半的能力接成「一个 preset 里 agent 能用的东西」。
 * @param ctx - 注入了 giteeChat / tools 的 agent 作用域上下文。
 * @param config - 本 preset 的配置。
 */
export function apply(ctx: any, config?: Config): void {
  const resolved = resolveConfig(config)
  const face = ctx.giteeChat as GiteeChatFace
  const { runner, role } = face

  // 只读部署状态与本插件 MCP 的前缀：门禁（步骤 3）要用，先解出来。
  const readOnly = face.hostConfig.allowWrites === false
  const mcpPrefix = face.hostConfig.mcpToolPrefix ?? DEFAULT_MCP_TOOL_PREFIX

  // 1) 触发型工具（只对挂了本行的 preset 可见）
  for (const tool of giteeChatTools({
    runner,
    role,
    // 快照工具是否对会话可读（`cache.agentReadable`，默认 true）
    agentReadable: () => face.hostConfig.cache?.agentReadable !== false,
  })) {
    ctx.effect(() => ctx.tools.register(tool))
  }

  // 1b) 隐藏**公开 gateway**（host 半注册的 `gitee_ent`）。
  //
  //     Gitee preset 里本来就挂着原生 MCP 工具（`mcp__gitee_ent__*`，由
  //     `--enabled-toolsets` 静态裁剪、再由下面的门禁按身份档硬拦），gateway
  //     在这里是重复入口，而且它的名字（`gitee_ent`）不在 MCP 前缀里，
  //     能力档门禁按设计不管它 —— 留着等于开了一个绕过档位裁剪的后门
  //     （公开 gateway 不裁剪：55 个工具全都可达，越档由 tools.guard 硬拦；见 DESIGN.md §40）。
  //
  //     用 `restrict`（agent 作用域内过滤**全局**工具）结构性隐藏：模型连看都
  //     看不到，比"提示词里叮嘱别用"硬。DESIGN.md §37。
  //
  //     两个易错点（0.5.0 第一版踩了第 ① 条，第二版才修好，见 §37 ⑧）：
  //     ① 参数是 `{ allow?, deny? }` **对象**，不是名字数组 —— 传数组会被
  //        `restrict({})` 的 no-op 守卫当面拒掉（异常又被下面的 catch 吞成
  //        warn，表现就是"没隐藏"，静默失效）；
  //     ② 只能从 **agent 作用域**调用（这里是 preset 行，合格）；从全局 ctx
  //        调会抛 "would mask every agent"。
  //
  //     容错：`restrict` 对"未知的全局工具名"会抛错。host 半是旧版（没注册
  //     gateway）时不能因此拖垮整个 preset，所以降级为 warn；失败只会退化成
  //     "gateway 与原生工具并存"，不会拦死会话。
  //
  //     无条件隐藏（不看 enforceTier / readOnly）：本行存在就等于"这个 preset
  //     走原生 MCP 入口"，gateway 在这里永远是重复入口；而且它不裁剪档位，
  //     留着就是个绕过门禁的后门。
  ctx.effect(() => {
    try {
      return ctx.tools.restrict({ deny: [PUBLIC_GATEWAY_TOOL_NAME] })
    } catch (error) {
      ctx.logger?.warn?.(`[${name}] 未能隐藏公开 gateway「${PUBLIC_GATEWAY_TOOL_NAME}」：${String(error)}`)
      return () => {}
    }
  })

  // 2) 人格注入：由身份关系推导，注入进每一轮
  //
  //  ⚠️ 必须用 `ctx.inject(['systemPrompt'], …)`（可选依赖）而不是在 apply 里
  //  同步 `ctx.get('systemPrompt')`。原因：cordis 的 `get(name, strict=true)`
  //  只返回 **正在运行** 的服务；preset 行比 `dsh-system-prompt` 先起来时
  //  `get()` 拿到 undefined，早先的实现就此 `warn` 一次、**永不重试** ——
  //  表现正是「人格与三档能力矩阵似乎失效」（提示词里没有 `<gitee-role>`，
  //  模型不知道自己是管理者/执行档，只剩门禁在硬拦）。
  //  `inject` 是惰性的：服务晚到也照样回调，服务始终没有则安静跳过，
  //  不会把整个 preset 拖成装配失败。
  if (resolved.injectPersona) {
    ctx.inject(['systemPrompt'], (scope) => {
      const systemPrompt = scope.get('systemPrompt') as {
        context: (input: { name: string; order: number; text: string | ((c: unknown) => string) }) => () => void
      } | undefined
      if (systemPrompt === undefined) {
        scope.logger?.warn?.(`[${name}] systemPrompt 不可用，人格上下文未注入`)
        return
      }
      scope.effect(() => systemPrompt.context({
        name: 'gitee-role',
        order: 50,
        text: () => role.text(),
      }))
      scope.logger?.info?.(`[${name}] 人格上下文已注入（gitee-role，tier=${role.tier() ?? '解析中'}）`)
    })
  }

  // 3) 门禁：两件事都在这一个 guard 里，但**触发条件不同**。
  //
  //   ① 能力档：把「不可以做」从提示词约束升级为硬拒绝（enforceTier）。
  //   ② 只读部署：allowWrites=false 时连 MCP 通道一起拦。
  //
  // ②必须能独立生效：`allowWrites` 原本只管界面写按钮与 `/write` 路由，
  // 管不到 MCP —— 而 preset 的 `--enabled-toolsets` 是静态的、不随部署变。
  // 于是"只读部署"在 MCP 那侧是空的：AI 照样能建工作项、改状态。
  // 所以只要处于只读模式，即使没开 enforceTier 也要挂这个 guard。
  //
  // ⚠️ 只审**本插件的那个 MCP server**（`hostConfig.mcpToolPrefix`）。同一个 preset
  // 里还挂着别家 MCP（OpenViking 记忆等），它们的裸名不在这三张档位表里 ——
  // 拿它们去比表会把别家工具误判成越权（2026-09-17 实测：Gitee 模式的管理者人格下
  // 写不了 OpenViking 记忆）。前缀回落默认值是为了兼容「宿主半是旧版」的错位装配。
  if (resolved.enforceTier || readOnly) {
    ctx.effect(() => ctx.tools.guard((exec: { name: string }) => {
      const raw = rawMcpToolName(exec.name, mcpPrefix)
      if (raw === undefined) return undefined
      const current = role.current()
      // 人格未解析时不拦——取数故障不该导致所有 MCP 调用被拒
      if (current === null) return undefined

      if (readOnly && (current.writes ?? []).includes(raw)) {
        return `本部署是**只读模式**（配置里的 allowWrites=false），不允许通过 MCP 修改 Gitee 上的内容：${raw}。`
          + `（读类工具不受影响。确实需要写入时，让管理员把配置里的 allowWrites 改成 true。）`
      }

      if (!resolved.enforceTier) return undefined
      if (current.tools.includes(raw)) return undefined
      const tierLabel = TIER_LABELS[current.tier] ?? current.tier
      return `当前人格「${tierLabel}」不具备该操作的权限：${raw}。`
        + `（人格由 Gitee token 的身份关系推导。若确需此权限，请让用户确认其 Gitee 角色，`
        + `或调整该 preset 的 mode 配置）`
    }))
  }

  ctx.logger?.info?.(`[${name}] mounted · persona=${role.persona() ?? '(解析中)'} · 工具已注册`)
}

export type { GiteeChatFace } from './host/face.ts'
