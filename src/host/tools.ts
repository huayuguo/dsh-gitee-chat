/**
 * 触发型工具：模型只负责「说要什么」，取数由脚本完成，渲染由卡片完成。
 *
 * 设计要点（对应需求方的口径）：
 *   - 工具**返回值只有摘要**（payload.summary）。全量数据不进上下文，
 *     所以上下文占用与数据量解耦——一千个工作项和十个工作项，
 *     模型看到的一样长。
 *   - 工具**不是**取数通道的唯一样式：卡片会拿同样的参数去
 *     /api/gitee-chat/payload 取完整数据。两处共用同一个执行器的进程内缓存。
 *
 * @module dsh-gitee-chat/host/tools
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { GqError, GqRunner } from './gq.ts'
import type { McpInspection } from './mcpBinary.ts'
import type { RoleResolver } from './role.ts'
import { listEnterprises, switchEnterprise } from './enterprise.ts'
import type { BoardScope } from '../types.ts'

/**
 * 统一文本输出。`required: true` / `additionalProperties: false` 必须是
 * 字面量类型（const），否则 widened 成 boolean 后推断不出值类型。
 */
const TEXT_OUTPUT = {
  schema: {
    type: 'object' as const,
    additionalProperties: false as const,
    properties: {
      text: { type: 'string' as const, required: true as const },
    },
  },
  render: (_args: unknown, value: { text: string }): ContentBlock[] => [
    { type: 'text' as const, text: value.text },
  ],
}

/** 工具依赖。 */
export interface GiteeChatToolDeps {
  readonly runner: GqRunner
  /** 身份/人格解析器（`gitee_role` 工具与提示词注入共用一份缓存）。 */
  readonly role: RoleResolver
  /**
   * 随包 MCP 后端状态（可选：兼容只传 `runner` 的旧调用点）。
   *
   * `gitee_chat_health` 用它回答「为什么 AI 建不了项目 / 改不了 Gitee 上的东西」——
   * 那是 MCP 通道的问题，取数自检（gq 脚本那条路）看不出来。
   */
  readonly mcp?: () => McpInspection
  /**
   * 会话里的 AI 是否可读快照（`cache.agentReadable`，默认 true）。
   *
   * 只影响 `gitee_board_snapshot` 这一个工具；界面读 `/payload` 不受它管。
   */
  readonly agentReadable?: boolean | (() => boolean)
}

/**
 * 把一次取数的时效渲染成**给人和模型看的一行**。
 *
 * 为什么每个工具输出都要带：用户明确要求「时效性说明要让 AI 和人都知道，
 * 做到提醒义务」（m02223）。只写在 SKILL.md 里不够——模型可能没读。
 * @param result - 带 `fetchedAt/ageMs/stale/ttlMs/source` 的取数结果。
 * @returns 单行 Markdown（含中文说明 + 机器可读数字）。
 */
export function freshnessLine(result: {
  fetchedAt: number
  ageMs: number
  stale: boolean
  ttlMs: number
  source: 'remote' | 'memory' | 'disk'
}): string {
  const ageSeconds = Math.round(result.ageMs / 1000)
  const ttlSeconds = Math.round(result.ttlMs / 1000)
  const layer = result.source === 'remote' ? '现拉' : result.source === 'memory' ? '内存缓存' : '落盘快照'
  if (result.ttlMs <= 0) {
    return `> 数据时效：现拉（缓存已关闭）。fetchedAt=${new Date(result.fetchedAt).toISOString()} ageSeconds=${ageSeconds} stale=false ttlSeconds=0 source=${result.source}`
  }
  const verdict = result.stale
    ? `**已超过新鲜期（${ttlSeconds} s）——可能不是最新，必要时用刷新或「gitee_board」重新拉**`
    : `新鲜期内（${ttlSeconds} s）`
  return `> 数据时效：${layer}，抓取于 ${ageSeconds} 秒前，${verdict}。`
    + ` fetchedAt=${new Date(result.fetchedAt).toISOString()} ageSeconds=${ageSeconds} stale=${result.stale} ttlSeconds=${ttlSeconds} source=${result.source}`
}

/** 把执行器错误转成给模型看的可行动说明（而不是裸 stack）。 */
function describeFailure(error: unknown): string {
  const failure = error as Partial<GqError>
  if (failure?.code === 'no-token') {
    return [
      '## 无法取数：未配置 Gitee 企业版 token',
      '',
      '请让用户任选一种方式配置后重试：',
      '- 设置环境变量 `GITEE_ENT_MCP_ACCESS_TOKEN`（重启 dsh 生效）',
      '- 或写入文件 `$DSH_HOME/.gitee-chat/token`（内容为纯 token）',
      '',
      `脚本原始信息：${failure.message ?? '未知'}`,
    ].join('\n')
  }
  if (failure?.code === 'timeout') {
    return `## 取数超时\n\n${failure.message ?? ''}\n\n可缩小范围（如指定单个项目）后重试。`
  }
  return `## 取数失败\n\n${failure.message ?? String(error)}`
}

/**
 * 注册 gitee-chat 的触发型工具。
 * @param deps - 取数执行器。
 * @returns 可注册进 `ctx.tools` 的工具定义数组。
 */
export function giteeChatTools(deps: GiteeChatToolDeps): ToolDefinition[] {
  const { runner, role, mcp, agentReadable } = deps
  /** 现取：设置页里 `cache.agentReadable` 改了要立刻生效（volatile）。 */
  const canReadSnapshot = (): boolean =>
    typeof agentReadable === 'function' ? agentReadable() !== false : agentReadable !== false

  return [
    defineTool({
      name: 'gitee_role',
      description:
        '解析当前 Gitee token 对应的身份与由此推导出的人格（企业管理者 / 项目执行 / 工作项执行 / 观察者）。'
        + '当用户问「我是什么角色」「我能做什么」「为什么不能建项目」「我在哪些项目里是负责人」时使用。'
        + '人格由身份关系推导：企业级管理角色 → 企业管理者；是某个项目的负责人 → 项目执行；'
        + '只负责工作项 → 工作项执行；都没有 → 观察者。该解析结果会作为角色上下文自动注入后续每一轮。',
      parameters: {
        refresh: {
          type: 'boolean',
          description: 'true=忽略缓存重新解析（企业角色或项目负责人刚变更过时用）。',
        },
        program: {
          type: 'integer',
          description:
            '聚焦到某个项目做逐项目判定：若该项目的负责人是你 → 该项目开启项目管理与分析；'
            + '否则该项目只开执行功能。不传则给出基础人格判定。',
        },
      },
      output: TEXT_OUTPUT,
      execute: async (args) => {
        try {
          const focus = typeof args.program === 'number' ? args.program : undefined
          const resolved = await role.resolve(args.refresh === true, focus)
          return { text: resolved.summary }
        } catch (error) {
          return { text: describeFailure(error) }
        }
      },
    }),

    defineTool({
      name: 'gitee_enterprises',
      description:
        '列出当前 Gitee token 可见的企业，并可选切换当前使用的企业。'
        + '当用户问「我在哪些企业」「怎么切换企业」「数据是哪个公司的」「拿错公司数据了」时使用。'
        + '注意：token 属于多个企业时**必须显式指定**，插件不会自动挑一个（避免显示错公司的数据）。'
        + '切换后看板缓存与身份人格都会自动失效，无需重启。'
        + '若用户是想自己选企业，告诉他去「设置 → Gitee 企业项目」里直接选。',
      parameters: {
        use: {
          type: 'integer',
          description: '要切换到的企业 id。传入即写入本地配置并立即生效（无需重启，看板缓存与人格同时失效）。',
        },
      },
      output: TEXT_OUTPUT,
      execute: async (args) => {
        try {
          if (typeof args.use === 'number') {
            const res = await switchEnterprise({ runner, role }, args.use)
            const name = res.selected === null ? '' : `**${res.selected.name}**（${res.selected.id}）`
            const lines = [`已把当前企业切换为：${name === '' ? res.effective : name}。`,
              `后续取数都用这个企业（写入 ${res.configPath}，无需重启）；`
              + `已失效：${res.invalidated.join('、')} —— 下一次取数就是新企业的数据。`]
            if (res.pinned > 0 && res.pinned !== (res.selected?.id ?? 0)) {
              lines.push(`⚠️ 插件配置里钉住了企业 ${res.pinned}，实际生效的是它，本次选择不会生效。`
                + '要改用设置页选择，必须先把补丁里的 enterpriseId 去掉（重跑 setup 且不指定企业即可）。')
            }
            return { text: lines.join('\n') }
          }
          const data = await listEnterprises(runner)
          const lines = ['## 当前 token 可见的企业', '']
          for (const e of data.enterprises) {
            lines.push(`- \`${e.id}\` **${e.name}**${data.effective === e.id ? ' ← 当前使用' : ''}`)
          }
          lines.push('')
          if (data.pinned > 0) {
            lines.push(`当前使用：${data.effective}（由**插件配置**钉住 —— 在设置页里选企业不会生效；`
              + '要让设置页能选，请重跑 setup 且不指定企业 id）。')
          } else if (data.effective === 0) {
            lines.push('⚠️ 当前未指定企业。若只属于一个企业会自动使用；多个企业时取数会报错要求指定。')
          } else {
            lines.push(`当前使用：${data.effective}（来源：${data.source}）`)
          }
          lines.push('')
          lines.push('切换：调用本工具并传 `use: <id>`；或者让用户自己在「设置 → Gitee 企业项目」里选。')
          return { text: lines.join('\n') }
        } catch (error) {
          return { text: describeFailure(error) }
        }
      },
    }),

    defineTool({
      name: 'gitee_board',
      description:
        '拉取 Gitee 企业版项目看板数据，并在会话中渲染成看板卡片（含项目进度、工作项分布、风险清单）。'
        + '当用户说「看看项目情况」「企业项目全景」「哪些任务逾期了」「我的任务」「项目进度」「风险」'
        + '「生成周报」「项目健康度」时使用本工具。'
        + '取数由后台脚本完成：你只会拿到紧凑摘要，完整图表数据由卡片直接渲染，不占用上下文。'
        + '需要展开细节时再调用更细粒度的工具。',
      parameters: {
        scope: {
          type: 'string',
          description: '范围：portfolio=企业全部项目（默认）；mywork=与我相关的工作项。',
        },
        program: {
          type: 'integer',
          description: '聚焦单个项目（program）的 id；不传表示全部项目。',
        },
        refresh: {
          type: 'boolean',
          description: 'true=忽略缓存强制重新拉取（用户说「刷新」「重新拉」时传）。',
        },
      },
      output: TEXT_OUTPUT,
      execute: async (args) => {
        const scope = (args.scope === 'mywork' ? 'mywork' : 'portfolio') as BoardScope
        try {
          const result = await runner.run({
            scope,
            program: typeof args.program === 'number' ? args.program : undefined,
            refresh: args.refresh === true,
          })
          const payload = result.payload
          const notes: string[] = []
          if (result.degraded || payload.source === 'fixture') {
            notes.push('⚠️ 当前展示的是**样例数据**（未配置 token 或显式开启降级），不是真实企业数据。')
          }
          // 时效性提醒（用户口径 m02223）：**无论命中缓存与否都写一行**，
          // 让模型和用户在同一个数字上对话，而不是让模型假设「刚拉的就是最新」。
          notes.push(freshnessLine(result))
          return { text: notes.length > 0 ? `${notes.join('\n')}\n\n${payload.summary}` : payload.summary }
        } catch (error) {
          return { text: describeFailure(error) }
        }
      },
    }),

    defineTool({
      name: 'gitee_board_snapshot',
      description:
        '**不联网**读取上一次的 Gitee 看板快照（宿主缓存/落盘），并明确告诉你这份数据有多旧。'
        + '当用户问「刚才那个数据」「缓存里有吗」「离线看一眼现状」「上次拉到的是什么」时使用。'
        + '返回内容带 `freshness`：`ageSeconds`（多少秒前）与 `stale`（是否已超过新鲜期）；'
        + '`stale: true` 时**必须**在回答里说明数据可能不是最新，并建议用户点刷新或改用 `gitee_board`。',
      parameters: {
        scope: {
          type: 'string',
          description: '范围：portfolio=企业全部项目（默认）；mywork=与我相关的工作项。',
        },
        program: {
          type: 'integer',
          description: '聚焦单个项目（program）的 id。',
        },
        format: {
          type: 'string',
          description: 'compact=只要计数与时效（默认）；full=额外带项目与我的工作项明细。',
        },
      },
      output: TEXT_OUTPUT,
      execute: (args) => {
        if (!canReadSnapshot()) {
          return Promise.resolve({
            text: '快照对会话不可读：设置 → 插件 → dsh-gitee-chat 里 `cache.agentReadable` 是关的。'
              + '请让用户打开它，或改用 `gitee_board` 现拉（会联网）。',
          })
        }
        const scope = (args.scope === 'mywork' ? 'mywork' : 'portfolio') as BoardScope
        const snapshot = runner.snapshot({
          scope,
          program: typeof args.program === 'number' ? args.program : undefined,
        })
        if (snapshot === undefined) {
          return Promise.resolve({
            text: '本机还没有可用的看板快照（宿主重启过、且 `cache.persist` 关着，或者从没拉过）。'
              + '请用 `gitee_board` 现拉一次。',
          })
        }
        const payload = snapshot.payload
        const freshness = {
          fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
          ageSeconds: Math.round(snapshot.ageMs / 1000),
          stale: snapshot.stale,
          ttlSeconds: Math.round(snapshot.ttlMs / 1000),
          source: snapshot.source,
        }
        const full = args.format === 'full'
        const compact = {
          enterprise: payload.enterprise,
          generatedAt: payload.generatedAt,
          counts: {
            programs: payload.programs.length,
            issues: payload.issues?.length ?? null,
            myIssues: payload.myIssues?.length ?? null,
          },
          freshness,
          ...(full
            ? {
                programs: payload.programs.map((p) => ({ id: p.id, name: p.name, open: p.open, overdue: p.overdue })),
                myIssues: payload.myIssues ?? [],
              }
            : {}),
        }
        return Promise.resolve({ text: `${freshnessLine(snapshot)}\n\n\`\`\`json\n${JSON.stringify(compact)}\n\`\`\`` })
      },
    }),

    defineTool({
      name: 'gitee_chat_health',
      description:
        '自检 Gitee 取数环境：token 是否配置、企业是否可解析、企业版 API 是否连通。'
        + '当用户问「为什么取不到数据」「token 配好了吗」「连不上 Gitee」时使用。',
      parameters: {},
      output: TEXT_OUTPUT,
      execute: async () => {
        const health = await runner.health()
        const lines = ['## Gitee 取数环境自检', '']
        lines.push(`- 脚本路径：\`${runner.scriptPath}\``)
        lines.push(`- 脚本存在：${runner.scriptExists() ? '是' : '**否**'}`)
        lines.push(`- 结果：${health.ok ? '✅ 正常' : '❌ 异常（' + (health.stage ?? 'unknown') + '）'}`)
        if (health.tokenSource) lines.push(`- token 来源：\`${health.tokenSource}\``)
        if (health.enterprise) lines.push(`- 企业：${health.enterprise.name || '(未命名)'}（id=${health.enterprise.id}）`)
        if (health.apiBase) lines.push(`- API base：\`${health.apiBase}\``)
        if (health.programsSeen !== undefined) lines.push(`- 可见项目数（抽样）：${health.programsSeen}`)
        if (health.message) lines.push(`- 信息：${health.message}`)
        if (health.candidates) lines.push(`- 可用 token 文件位置：${health.candidates.map((c) => `\`${c}\``).join('、')}`)

        // MCP 后端与取数是**两条通道**：取数走 gq 脚本，AI 调用 Gitee 工具走 MCP
        // 子进程。前者正常不代表后者能用，所以这里必须单独报一段 —— 否则
        // "取数一切正常，但 AI 建不了项目"会找不到原因。
        if (mcp !== undefined) {
          const info = mcp()
          lines.push('', '## MCP 后端（AI 调用 Gitee 工具的那条通道）')
          if (info.manifest === null) {
            lines.push('- 随包清单：**缺失**（这个包不完整，或被人手工拷过）')
          } else {
            lines.push(`- 随包二进制：${info.manifest.toolCount} 个工具`
              + `（fork ${info.manifest.forkCommit.slice(0, 8)} · ${info.manifest.goVersion}）`)
          }
          lines.push(`- 本机平台：\`${info.platform}\` · 随包是否覆盖：${info.bundled ? '是' : '**否**'}`)
          lines.push(`- 落地位置：\`${info.target}\``)
          if (info.overridden) {
            lines.push('- 来源：**由 `MCP_GITEE_ENT_BIN` 指定**（未用随包二进制）')
          } else if (info.matchesManifest) {
            lines.push('- 文件已就位，且与随包清单 sha256 一致')
          } else if (info.installed) {
            lines.push('- 文件已就位，但**与随包清单不一致**（多半不是随包的那份）')
          } else {
            lines.push('- 文件尚未落地：重启 `dsh web` 会由插件自动补上')
          }
          if (info.bundled && !info.overridden && !info.matchesManifest) {
            lines.push('- ⚠️ 二进制与随包清单不一致。若它来自上游 npm 包，则**没有 `create_program`**'
              + '（建项目）与 9 个文档工具 —— 表现是这些能力**悄悄消失**而不是报错。')
          }
        }
        return { text: lines.join('\n') }
      },
    }),
  ]
}
