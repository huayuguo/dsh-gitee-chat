/**
 * dsh-gitee-chat · **公开 gateway**（host 半唯一的 agent 可见出口）。
 *
 * 背景（DESIGN.md §37）：原先 Gitee 企业 MCP 的工具（当时 51 个，0.5.4 起 55 个）只挂在两个 Gitee
 * preset 里 —— 其他 agent（分析、PTC、一次性问答）根本看不到，而 MCP 本身
 * 是**工具类后端**、不是 Gitee 人格的私有物。用户 2026-10-10 要求改成公共能力。
 *
 * 但「全量公开」不等于「55 个 schema 每轮进上下文」：实测（0.5.3 的 51 个工具）
 * name+description+inputSchema ≈ 52.4 KB ≈ 16.4K tokens/请求；55 个约 56 KB ≈ 17.6K。所以这里做成
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
 * 也就是说原生机能不能给出「目录 → 按需加载」这条路（详见 DESIGN.md §37）。
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
import type { McpCallResult, McpClient, McpToolInfo } from './mcpClient.ts'

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

  // ── 入参归一化 ─────────────────────────────────────────────────────────────
  //
  // 2026-10-27 的事故：模型把工作项建到了**另一家企业**（它按 npm 仓库的 Gitee 路径反推了
  // 一个企业 id，显式传了 `enterprise_id`），且只带了 `project_id`（仓库）、没带
  // `program_id`（项目）→ 工作项飘在企业里、不进任何项目看板。
  //
  // 两条都不该指望模型自觉：企业是**部署级事实**（`enterpriseId.ts` 的解析结果唯一），
  // 项目能从仓库反查。所以在 gateway 这一层（标准模式下工具是我们自己的）统一纠偏：
  //   1. schema 声明了 `enterprise_id` 的工具：缺失/为 0/与配置不一致 → 一律改成配置企业；
  //   2. `create_enterprise_issue`：没带 `program_id` 时按仓库反查，查不到就**拒建**
  //      （宁可报错，也不产出"没有项目的工作项"）。
  //
  // Gitee 预设走的是 MCP 原生工具（不经这里），那条线由 preset 的 `GITEE_ENT_ID` 兜底，
  // 显式传错的企业 id 仍然会覆盖 —— 这是已知缺口，记在 DESIGN.md §37。
  const LIST_TTL_MS = 60_000
  let listedAt = 0
  let listedTools: readonly McpToolInfo[] = []
  /** 工具目录（带 60s 缓存：每次 call 都要按 schema 判断要不要补 enterprise_id）。 */
  const toolsNow = async (): Promise<readonly McpToolInfo[]> => {
    if (listedAt !== 0 && Date.now() - listedAt < LIST_TTL_MS) return listedTools
    try {
      listedTools = await deps.client.list()
      listedAt = Date.now()
    } catch {
      listedAt = 0
    }
    return listedTools
  }

  const PROGRAM_TTL_MS = 600_000
  const programOfRepo = new Map<number, { at: number; value: number }>()
  /**
   * 仓库 → 所属项目（program）的反查。
   *
   * MCP 没有「项目的仓库列表」工具，但既有工作项都带 `program_id`，所以拿该仓库的
   * 一条工作项反查即可（同一仓库的所有工作项必然属于同一项目）。
   * @param enterpriseId - 企业 id（已归一化）
   * @param repoId - 仓库 id（`project_id`）
   * @returns 项目 id；查不到返回 undefined
   */
  async function resolveProgram(enterpriseId: number, repoId: number): Promise<number | undefined> {
    const hit = programOfRepo.get(repoId)
    if (hit !== undefined && Date.now() - hit.at < PROGRAM_TTL_MS) return hit.value
    try {
      const result = await deps.client.call('list_enterprise_issues', {
        enterprise_id: enterpriseId,
        project_id: String(repoId),
        per_page: 10,
      })
      if (result.isError) return undefined
      const parsed = JSON.parse(result.text) as { data?: Array<{ program_id?: unknown }> }
      const rows = Array.isArray(parsed.data) ? parsed.data : []
      const found = rows
        .map((row) => Number(row?.program_id))
        .find((id) => Number.isFinite(id) && id > 0)
      if (found === undefined) return undefined
      programOfRepo.set(repoId, { at: Date.now(), value: found })
      return found
    } catch {
      return undefined
    }
  }

  /**
   * 归一化一次调用的入参。
   *
   * 企业 id 的规则分读写：**写操作**一律归到本部署配置的企业（配置是唯一真源，
   * 模型填错/填 0 都不该把数据写到别家）；**只读操作**只在缺失或 ≤0 时补默认值，
   * 显式指定的其他企业原样放行（同一账号可属多家企业）。
   * @param name - MCP 工具名
   * @param args - 模型给的参数（不改原对象）
   * @returns 纠正后的参数 + 给模型看的说明；拒绝时给 `refused` 文案
   */
  async function normalizeCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ args: Record<string, unknown>; notes: string[] } | { refused: string }> {
    let next = args
    const notes: string[] = []
    const enterprise = deps.enterpriseSelector?.()
    const tool = (await toolsNow()).find((entry) => entry.name === name)
    const properties = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties
    if (enterprise !== undefined && enterprise.id > 0 && properties !== undefined
      && Object.prototype.hasOwnProperty.call(properties, 'enterprise_id')) {
      const raw = next.enterprise_id
      const given = Number(raw)
      const absent = raw === undefined || raw === null || raw === ''
        || !Number.isFinite(given) || given <= 0
      // 写操作**强制**归到本部署配置的企业（2026-10-27 就是把工作项建到了别的企业）；
      // 只读操作只在"没给 / 给 0"时补配置企业，显式给了别的企业要尊重 —— 一个账号
      // 可能同时属于多家企业，查别家的仓库/工作项是正当用法，一并改掉会查不到东西。
      const mustUseConfigured = runtimeWrites().has(name)
      if (absent || (mustUseConfigured && given !== enterprise.id)) {
        next = { ...next, enterprise_id: enterprise.id }
        notes.push(absent
          ? `已自动补上 enterprise_id=${enterprise.id}（本部署配置的企业${enterprise.describe === '' ? '' : `；来源：${enterprise.describe}`}）`
          : `已把 enterprise_id 从 ${String(raw)} 纠正为配置企业 ${enterprise.id}（避免建到别的企业）`)
      }
    }
    if (name === 'create_enterprise_issue') {
      const program = Number(next.program_id)
      const repo = Number(next.project_id)
      const enterpriseId = Number(next.enterprise_id)
      if (!(Number.isFinite(program) && program > 0)) {
        const resolved = Number.isFinite(repo) && repo > 0 && Number.isFinite(enterpriseId) && enterpriseId > 0
          ? await resolveProgram(enterpriseId, repo)
          : undefined
        if (resolved === undefined) {
          return {
            refused: [
              '## 未关联项目，已拒绝创建',
              '',
              `\`${name}\` 必须带 \`program_id\`（关联项目）；只带 \`project_id\`（仓库）建出来的工作项`,
              '会飘在企业里、不进任何项目看板（2026-10-27 实测踩过）。',
              '',
              repo > 0
                ? `没能从仓库 ${repo} 的既有工作项反查出所属项目：请先确认这个仓库属于哪个项目（工作台 → 仓库），再显式传 program_id。`
                : '请先确认这个仓库属于哪个项目（工作台 → 仓库），再显式传 program_id 与 project_id。',
            ].join('\n'),
          }
        }
        next = { ...next, program_id: resolved }
        notes.push(`已按仓库 ${repo} 自动关联项目 program_id=${resolved}`)
      }
    }
    return { args: next, notes }
  }

  /** 写工具目录（第一级暴露）。 */
  async function catalog(): Promise<string> {
    // 这里**不用** toolsNow()：目录是"第一眼"，后端不可用时必须把错误抛给 describeFailure
    // （`toolsNow` 为了归一化会把失败吞成空表，那样就成了"0 个工具"的假目录）。
    const tools = await deps.client.list()
    listedTools = tools
    listedAt = Date.now()
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
    const normalized = await normalizeCall(name, args)
    if ('refused' in normalized) return normalized.refused
    const preamble = normalized.notes.length === 0
      ? ''
      : `${normalized.notes.map((note) => `> ${note}`).join('\n')}\n\n`
    let result: McpCallResult
    try {
      result = await deps.client.call(name, normalized.args)
    } catch (error) {
      return `${preamble}${describeFailure(error)}`
    }
    const clipped = truncate(result.text, maxResultBytes)
    const suffix = clipped.truncated ? '\n…（结果过长已截断；可缩小范围或改用带分页的读工具）' : ''
    return result.isError
      ? `## 工具 \`${name}\` 报错\n\n${preamble}${clipped.text}${suffix}`
      : `${preamble}${clipped.text}${suffix}`
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
