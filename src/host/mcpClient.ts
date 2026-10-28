/**
 * dsh-gitee-chat · **MCP stdio 客户端**（host 半自用，只做 JSON-RPC 那几帧）。
 *
 * 为什么不用 `@deepseek-ai/dsh-mcp-client`：它把 MCP 工具注册进**调用方的作用域**，
 * 而公开 gateway 要的是**进程级一个入口**；而且我们要的是
 * 「先目录（list）→ 再参数表（schema）→ 再执行（call）」的两级暴露，
 * 这与「把 51 个工具 schema 每轮塞进上下文」正好相反（DESIGN.md §37）。
 *
 * 协议：MCP `2024-11-05`，stdio，一行一个 JSON-RPC 2.0 帧。
 * 只实现 gateway 需要的三帧：`initialize` / `tools/list` / `tools/call`。
 *
 * 生命周期：**懒启动、可重启**。子进程退出（或拉起失败）后，下一次调用会
 * 重新拉起 —— MCP server 是无状态查询进程，重启没有状态损失；反过来，
 * 把「启动失败」变成永久错误会让一次抖动废掉整个会话。
 *
 * @module dsh-gitee-chat/host/mcpClient
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/** `tools/list` 里的一项（只保留 gateway 用得到的字段）。 */
export interface McpToolInfo {
  readonly name: string
  readonly description: string
  readonly inputSchema: unknown
}

/** `tools/call` 的结果。`isError` 为真表示 MCP server 报的业务错误。 */
export interface McpCallResult {
  readonly text: string
  readonly isError: boolean
}

/** 构造参数。`command` 为空串时所有请求都会以 `missing-binary` 失败。 */
export interface McpClientOptions {
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  /** 单帧超时（毫秒）。默认 60s，与 preset 里 `toolCallTimeoutMs` 的出厂值一致。 */
  readonly timeoutMs?: number
  /** 握手 `clientInfo.version`（由调用点传 `VERSION`，避免版本号出现第二处真源）。 */
  readonly clientVersion?: string
  readonly logger?: { warn(message: string): void }
}

/** 带 `code` 的错误：gateway 靠它把失败翻成可行动文案。 */
export interface McpClientError extends Error {
  readonly code: 'missing-binary' | 'timeout' | 'mcp-exited' | 'mcp-error' | 'protocol'
}

export interface McpClient {
  /** 工具目录。 */
  list(): Promise<McpToolInfo[]>
  /** 执行一个工具。MCP 报的 JSON-RPC error 会抛出（`code: 'mcp-error'`）。 */
  call(name: string, args: Record<string, unknown>): Promise<McpCallResult>
  /** 杀掉子进程并拒绝所有在途请求（幂等）。 */
  dispose(): void
}

/** 协议版本：与 `~/.local/bin/mcp-gitee-ent`（0.5.0 时在 `$DSH_HOME/.gitee-chat/bin/`）实测握手通过的版本。 */
const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT_MS = 60_000
/** stdio 尾部诊断信息最多留这么多字符（进日志用，不进上下文）。 */
const STDERR_TAIL_CHARS = 2_000

/**
 * 造一个 MCP 客户端。**不会**在构造时启动进程 —— 第一次 `list`/`call` 才拉起。
 * @param options - 命令行、环境变量与超时。
 * @returns 客户端；用完调 `dispose()`。
 */
export function createMcpClient(options: McpClientOptions): McpClient {
  const timeoutMs = options.timeoutMs !== undefined && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS

  let child: ChildProcessWithoutNullStreams | undefined
  let ready: Promise<void> | undefined
  let disposed = false
  let nextId = 1
  let buffer = ''
  let stderrTail = ''
  const pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }>()

  /** 造一个带 code 的错误。 */
  function fail(code: McpClientError['code'], message: string): McpClientError {
    const error = new Error(message) as Error & { code: McpClientError['code'] }
    error.code = code
    return error as McpClientError
  }

  /** 拒绝所有在途请求（子进程退出/被销毁时）。 */
  function rejectAll(error: Error): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  /** 摘掉当前子进程（保留 `disposed` 语义：显式 dispose 后不再重启）。 */
  function teardown(error: Error): void {
    const dying = child
    child = undefined
    ready = undefined
    buffer = ''
    rejectAll(error)
    if (dying !== undefined && !dying.killed) {
      try { dying.kill() } catch { /* 已经死了 */ }
    }
  }

  /** 写一帧；stdin 已关/进程已死时抛出。 */
  function write(frame: unknown): void {
    const target = child
    if (target === undefined || target.stdin.destroyed) throw fail('mcp-exited', 'MCP 子进程不可用')
    target.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  /** 收帧：先解决 pending，再忽略 notification / 未知 id。 */
  function onLine(line: string): void {
    const text = line.trim()
    if (text === '') return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(text) as Record<string, unknown>
    } catch {
      options.logger?.warn(`gitee-chat: MCP 后端输出了非 JSON 行（已忽略）：${text.slice(0, 200)}`)
      return
    }
    const id = typeof message.id === 'number' ? message.id : undefined
    if (id === undefined) return
    const entry = pending.get(id)
    if (entry === undefined) return
    pending.delete(id)
    clearTimeout(entry.timer)
    const error = message.error as { message?: unknown } | undefined
    if (error !== undefined) {
      entry.reject(fail('mcp-error', typeof error.message === 'string' ? error.message : JSON.stringify(error)))
      return
    }
    entry.resolve(message.result)
  }

  /** 发一帧并等结果。 */
  function request(method: string, params: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(fail('timeout', `MCP ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error as Error)
      }
    })
  }

  /** 握手：`initialize` 请求 → `notifications/initialized` 通知。 */
  async function handshake(): Promise<void> {
    await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-gitee-chat', version: options.clientVersion ?? 'unknown' },
    })
    write({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  /** 拉起子进程（若已在跑就直接复用）。 */
  function start(): Promise<void> {
    if (disposed) return Promise.reject(fail('mcp-exited', 'MCP 客户端已销毁'))
    if (ready !== undefined) return ready
    if (options.command === '') {
      return Promise.reject(fail('missing-binary', '随包 MCP 后端不可用（命令为空）'))
    }

    let spawned: ChildProcessWithoutNullStreams
    try {
      spawned = spawn(options.command, [...(options.args ?? [])], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // Windows：宿主是 GUI 进程（Electron），console 子程序会被系统配一个
        // 控制台窗口 —— 每次拉起 MCP 后端都闪一下黑框。显式藏掉（其它平台忽略此参数）。
        windowsHide: true,
      })
    } catch (error) {
      return Promise.reject(fail('mcp-exited', `无法启动 MCP 后端：${String(error)}`))
    }
    child = spawned
    stderrTail = ''

    spawned.stdout.setEncoding('utf8')
    spawned.stdout.on('data', (chunk: string) => {
      buffer += chunk
      for (;;) {
        const at = buffer.indexOf('\n')
        if (at < 0) break
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        onLine(line)
      }
    })
    spawned.stderr.setEncoding('utf8')
    spawned.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
    })
    spawned.on('error', (error) => {
      options.logger?.warn(`gitee-chat: MCP 后端进程错误：${error.message}`)
      teardown(fail('mcp-exited', `MCP 后端进程错误：${error.message}`))
    })
    spawned.on('exit', (code, signal) => {
      const detail = stderrTail.trim() === '' ? '' : `；stderr 末尾：${stderrTail.trim().slice(-400)}`
      teardown(fail('mcp-exited', `MCP 后端退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）${detail}`))
    })

    ready = handshake().catch((error: unknown) => {
      teardown(error as Error)
      throw error
    })
    return ready
  }

  return {
    async list(): Promise<McpToolInfo[]> {
      await start()
      const result = await request('tools/list', {}) as { tools?: unknown }
      const raw = Array.isArray(result?.tools) ? result.tools : []
      return raw.map((entry) => {
        const tool = entry as { name?: unknown; description?: unknown; inputSchema?: unknown }
        return {
          name: typeof tool.name === 'string' ? tool.name : '',
          description: typeof tool.description === 'string' ? tool.description : '',
          inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        }
      }).filter((tool) => tool.name !== '')
    },

    async call(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
      await start()
      const result = await request('tools/call', { name, arguments: args }) as {
        content?: unknown
        isError?: unknown
        structuredContent?: unknown
      }
      const blocks = Array.isArray(result?.content) ? result.content : []
      const texts: string[] = []
      for (const block of blocks) {
        const item = block as { type?: unknown; text?: unknown }
        if (item.type === 'text' && typeof item.text === 'string') texts.push(item.text)
        else texts.push(JSON.stringify(block))
      }
      const text = texts.length > 0
        ? texts.join('\n')
        : JSON.stringify(result?.structuredContent ?? result ?? null)
      return { text, isError: result?.isError === true }
    },

    dispose(): void {
      disposed = true
      teardown(fail('mcp-exited', 'MCP 客户端已销毁'))
    },
  }
}
