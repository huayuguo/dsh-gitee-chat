/**
 * dsh-gitee-chat · **公开 gateway**（host 半唯一的 agent 可见出口）。
 *
 * 背景：原先 Gitee 企业 MCP 的 48 个工具只挂在两个 Gitee
 * preset 里 —— 其他 agent（分析、PTC、一次性问答）根本看不到，而 MCP 本身
 * 是**工具类后端**、不是 Gitee 人格的私有物。用户 2026-10-10 要求改成公共能力。
 *
 * 但「全量公开」不等于「48 个 schema 每轮进上下文」：实测 48 个工具的
 * name+description+inputSchema ≈ 46.6 KB ≈ 14.6K tokens/请求。所以这里做成
 * **两级暴露**，只把第一级常驻：
 *
 *   1. **目录**（`op: "list"`，约 1.1K tokens，且只在真用到时才进上下文）：
 *      工具名 + 一句话说明 + 是否写操作（✎）。
 *   2. **按需取参数表**（`op: "schema"`）+ **执行**（`op: "call"`）：
 *      一个 `gitee_ent` 工具的 schema ≈ 100–150 tokens，常驻成本恒定。
 *
 * 为什么不用 DSH 原生的 `deferLoading`：`ToolSchema.deferLoading` 只表达
 * 「延迟发送定义」，而**声明延迟并不激活**（`packages/llm/llm/README.zh.md:162`），
 * 且 `dsh-mcp-client` 不接受该选项（`lib/index.js:153` 直接 `register(definition)`）。
 * 也就是说原生机能不能给出「目录 → 按需加载」这条路。
 *
 * 门禁分工（与 §10/§11 一致）：**档位裁剪留给 Gitee preset**（agent 半用
 * `ctx.tools.restrict` 把这个 gateway 从 Gitee 会话里隐藏，仍用原生 48 工具）；
 * gateway 自己只守一条**部署级承诺**：`allowWrites: false`（只读部署）时硬拦写工具。
 *
 * @module dsh-gitee-chat/host/gateway
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { WRITE_TOOLS } from '../generated/tierWrites.ts'
import { PUBLIC_GATEWAY_TOOL_NAME } from '../mcpNaming.ts'
import type { McpCallResult, McpClient } from './mcpClient.ts'

/** 统一文本输出（与 `host/tools.ts` 同一形状）。 */
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

/** gateway 依赖。除 `client` 外都有默认值，便于冒烟测试只注入必要项。 */
export interface GiteeEntGatewayDeps {
  /** 已连到随包 MCP 后端的客户端（host 半负责 `dispose`）。 */
  readonly client: McpClient
  /** 线上工具名，默认 `PUBLIC_GATEWAY_TOOL_NAME`（`gitee_ent`）。 */
  readonly toolName?: string
  /** `hostConfig.allowWrites`：false = 只读部署，写工具硬拦。 */
  readonly allowWrites: boolean
  /** 运行期写名单（`role.current()?.writes`）；未解析出来时返回空数组即可。 */
  readonly runtimeWrites?: () => readonly string[]
  /**
   * 生效企业 id 的**现取**选择器：`() => ({ id, describe })`，`id <= 0` 表示没解析出来。
   *
   * 为什么是函数而不是一个数字：企业可以在「设置 → Gitee 企业项目」里随时切换，
   * 目录抬头要跟着变，不能钉死在注册那一刻（见 `host/enterpriseId.ts` 的「每次现取」纪律）。
   */
  readonly enterpriseSelector?: () => { readonly id: number; readonly describe: string }
  /** 目录里每条描述截断到多少字符（默认 100）。 */
  readonly catalogChars?: number
  /** 单次结果最多回多少字节（默认 120000，超出截断并提示）。 */
  readonly maxResultBytes?: number
}

/** 取描述的第一行（MCP 工具的 description 常是多行 markdown）。 */
function firstLine(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part !== '')
  return (line ?? '').replace(/^#+\s*/, '').replace(/\s+/g, ' ')
}

/** 按字节截断（保守地按字符数近似；中文 3 字节，取 1/3 上限再回退到字符截断）。 */
function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) low = mid
    else high = mid - 1
  }
  return { text: text.slice(0, low), truncated: true }
}

/** 把客户端/协议错误翻成给模型看的可行动文案。 */
function describeFailure(error: unknown): string {
  const failure = error as { code?: string; message?: string }
  const message = failure?.message ?? String(error)
  switch (failure?.code) {
    case 'missing-binary':
      return [
        '## 无法调用：随包 MCP 后端不可用',
        '',
        `原始信息：${message}`,
        '',
        '请让部署者运行 `node scripts/setup.mjs verify` 自检（会报告二进制落地状态与 sha256）。',
      ].join('\n')
    case 'timeout':
      return `## 调用超时\n\n${message}\n\n可缩小范围（指定仓库/项目、减少 page_size）后重试。`
    case 'mcp-exited':
      return `## MCP 后端已退出\n\n${message}\n\n下次调用会自动重启后端；若持续失败，请让部署者跑 \`node scripts/setup.mjs verify\`。`
    case 'mcp-error':
      return [
        `## Gitee 后端返回错误\n\n${message}`,
        '',
        /not\s*found|unknown tool|no such tool/i.test(message)
          ? '工具名可能不对：先用 `{"op":"list"}` 取目录。'
          : '参数可能不符合 `{"op":"schema","name":"…"}` 给出的形状；也可能是 Gitee 侧权限不足（403/404）。',
      ].join('\n')
    default:
      return `## 调用失败\n\n${message}`
  }
}

/**
 * 造 `gitee_ent` gateway 工具。
 * @param deps - MCP 客户端与部署开关。
 * @returns 可注册进 `ctx.tools` 的工具定义（**一个**）。
 */
export function giteeEntGatewayTool(deps: GiteeEntGatewayDeps): ToolDefinition {
  const toolName = deps.toolName ?? PUBLIC_GATEWAY_TOOL_NAME
  const catalogChars = deps.catalogChars ?? 100
  const maxResultBytes = deps.maxResultBytes ?? 120_000
  const runtimeWrites = (): ReadonlySet<string> =>
    new Set<string>([...WRITE_TOOLS, ...(deps.runtimeWrites?.() ?? [])])

  /** 写工具目录（第一级暴露）。 */
  async function catalog(): Promise<string> {
    const tools = await deps.client.list()
    const writes = runtimeWrites()
    const head = [
      `# Gitee 企业工具目录（共 ${tools.length} 个${writes.size === 0 ? '' : '；✎ = 写操作'}）`,
      '',
    ]
    const enterprise = deps.enterpriseSelector?.()
    if (enterprise !== undefined && enterprise.id > 0) {
      // 来源要说清楚：钉住 / 环境变量 / 本地配置 / 自动识别，四种都可能（见 host/enterpriseId.ts）。
      // 这句话直接决定模型 `call` 时填哪个 enterprise_id —— 填 0 或填错都会拿到
      // 「企业未授权此应用进行访问」那个 401，所以宁可多写一句来源。
      const from = enterprise.describe === '' ? '' : `；来源：${enterprise.describe}`
      head.push(`当前生效的企业 id：\`${enterprise.id}\`（工具参数要 enterprise_id 时直接用它${from}）。`, '')
    } else {
      head.push('企业 id 不确定时，先 `{"op":"call","name":"list_enterprises"}`。', '')
    }
    if (!deps.allowWrites) {
      head.push('⚠️ 本部署是**只读**（`allowWrites: false`）：✎ 标记的写操作会被本工具硬拦。', '')
    }
    const lines = tools.map((tool) => {
      const mark = writes.has(tool.name) ? ' ✎' : ''
      const summary = firstLine(tool.description).slice(0, catalogChars)
      return `- ${tool.name}${mark}${summary === '' ? '' : ` — ${summary}`}`
    })
    return [
      ...head,
      ...lines,
      '',
      `用法：{"op":"schema","name":"<工具名>"} 取参数表 → {"op":"call","name":"<工具名>","args":{…}} 执行。`,
      '不要凭记忆猜参数名：先 schema、再 call。',
    ].join('\n')
  }

  /** 参数表（第二级暴露的「取形状」那半步）。 */
  async function schemaOf(name: string): Promise<string> {
    const tools = await deps.client.list()
    const tool = tools.find((entry) => entry.name === name)
    if (tool === undefined) {
      const near = tools
        .filter((entry) => entry.name.includes(name) || name.includes(entry.name))
        .slice(0, 5)
        .map((entry) => entry.name)
      return [
        `## 没有名为 \`${name}\` 的工具`,
        '',
        near.length > 0 ? `最接近的：${near.join('、')}` : '先用 `{"op":"list"}` 取完整目录。',
      ].join('\n')
    }
    const body = JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }, null, 2)
    const clipped = truncate(body, maxResultBytes)
    return clipped.truncated ? `${clipped.text}\n…（schema 过长已截断）` : clipped.text
  }

  /** 执行（第二级暴露的「真调用」那半步）。 */
  async function invoke(name: string, args: Record<string, unknown>): Promise<string> {
    if (!deps.allowWrites && runtimeWrites().has(name)) {
      return [
        `## 只读部署：写操作被拦截`,
        '',
        `当前安装设置了 \`allowWrites: false\`（只读），而 \`${name}\` 是写操作。`,
        '',
        '- 读工具不受影响，可以继续用。',
        '- 需要写，请让部署者把插件配置的 `allowWrites` 改成 `true`（或从「设置 → Gitee 企业项目」确认部署口径后重载配置）。',
      ].join('\n')
    }
    let result: McpCallResult
    try {
      result = await deps.client.call(name, args)
    } catch (error) {
      return describeFailure(error)
    }
    const clipped = truncate(result.text, maxResultBytes)
    const suffix = clipped.truncated ? '\n…（结果过长已截断；可缩小范围或改用带分页的读工具）' : ''
    return result.isError ? `## 工具 \`${name}\` 报错\n\n${clipped.text}${suffix}` : `${clipped.text}${suffix}`
  }

  return defineTool({
    name: toolName,
    description:
      'Gitee 企业平台（仓库、工作项、PR、迭代、文档、成员…）的统一入口，一个工具覆盖后端全部能力。'
      + '**两级用法，别跳步**：先 `{"op":"list"}` 拿工具目录（名字 + 一句话说明 + ✎ 是否写操作），'
      + '再 `{"op":"schema","name":"<工具名>"}` 拿该工具的完整参数表，最后 `{"op":"call","name":"<工具名>","args":{…}}` 执行。'
      + '结果是一段 JSON 文本。最终权限由 Gitee 云端角色决定（拿不到就是 403/404）；'
      + '只读部署下写操作会被硬拦。当用户提到 Gitee / 码云 / 企业仓库 / 工作项 / PR / 迭代 / 项目文档时用它。',
    parameters: {
      op: {
        type: 'string',
        enum: ['list', 'schema', 'call'],
        required: true as const,
        description: 'list=取工具目录；schema=取某个工具的完整参数表；call=执行某个工具。',
      },
      name: {
        type: 'string',
        description: '目标工具名（op=list 时可省略；op=schema/call 必填，取自 list 的输出）。',
      },
      args: {
        type: 'object',
        additionalProperties: true,
        description: 'op=call 时传给目标工具的参数对象（形状照 op=schema 的输出填，不确定就先 schema）。',
      },
    },
    output: TEXT_OUTPUT,
    execute: async (raw) => {
      const args = (raw ?? {}) as { op?: unknown; name?: unknown; args?: unknown }
      const op = typeof args.op === 'string' ? args.op : 'list'
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      const params = args.args !== null && typeof args.args === 'object' && !Array.isArray(args.args)
        ? args.args as Record<string, unknown>
        : {}
      try {
        if (op === 'list') return { text: await catalog() }
        if (op === 'schema') {
          if (name === '') return { text: 'op=schema 需要 name：先用 `{"op":"list"}` 取目录。' }
          return { text: await schemaOf(name) }
        }
        if (op === 'call') {
          if (name === '') return { text: 'op=call 需要 name：先用 `{"op":"list"}` 取目录。' }
          return { text: await invoke(name, params) }
        }
        return { text: `未知的 op「${op}」：只支持 list / schema / call。` }
      } catch (error) {
        return { text: describeFailure(error) }
      }
    },
  })
}
