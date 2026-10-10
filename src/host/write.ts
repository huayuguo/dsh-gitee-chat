/**
 * 写通道：**全包唯一的写入口**。
 *
 * 纪律（这是本模块存在的全部理由）：
 *   - 任何改动 Gitee 数据的动作，都必须经过 `createIssueWriter().write()`。
 *     路由、未来的按钮、将来任何新入口，一律调它——不允许出现第二套写逻辑。
 *   - UI 不直连 Gitee：浏览器 → `/api/gitee-chat/write` → 这里 → gq 脚本 → Gitee。
 *   - 每次写都返回**结构化结果**（而不是裸 HTTP），失败带可读原因。
 *
 * 与 AI 侧写操作的关系：模型有自己的 MCP 写工具（`update_enterprise_issue` 等），
 * 那是**另一个平面**、另一条通道，故意不复用——MCP 工具受能力档门禁约束，
 * 而这里只做 UI 的最小写集合（改状态 / 评论 / 改派），三档人格都有这个权限。
 *
 * **第四种 op：`doc-page-update`**（知识库文档页，整页替换）。
 * 它同样从这一个入口出去（UI 只有一条写路），但**实现是委派**：
 * 转交 MCP 的 `update_enterprise_document_page`，插件不拼文档端点。
 * MCP 是文档能力的唯一实现。
 *
 * @module dsh-gitee-chat/host/write
 */

import type { GqRunner } from './gq.ts'
import type { McpDocs } from './mcpDocs.ts'
import type { IssueWriteRequest, IssueWriteResult } from '../types.ts'

/** 写通道选项。 */
export interface IssueWriterOptions {
  readonly runner: GqRunner
  /** 关掉写通道（只读部署）。默认开。 */
  readonly enabled?: boolean
  /**
   * 文档委派客户端（可选）。
   *
   * 文档写**不在这个文件里拼端点** —— 它委派给 MCP 的
   * `update_enterprise_document_page`。
   * 这里只负责"UI 的写只有一个入口"这条纪律。
   */
  readonly docs?: McpDocs
}

/** 写失败：带 code，供路由映射 HTTP 语义。 */
export class WriteError extends Error {
  constructor(
    readonly code: 'disabled' | 'bad-request' | 'forbidden' | 'failed',
    message: string,
  ) {
    super(message)
    this.name = 'WriteError'
  }
}

/** 评论长度上限（与脚本侧一致；在宿主侧先挡一次，省一次进程启动）。 */
const COMMENT_MAX = 8000

/**
 * 校验并归一化一次**工作项**写请求（三种 op）。
 *
 * 文档写（`doc-page-update`）不走这里 —— 它委派 MCP，见 `writeDocPage`。
 */
function normalizeIssueWrite(request: IssueWriteRequest): { args: string[]; stdin?: string; describe: string } {  const ident = String(request?.ident ?? '').trim().toUpperCase()
  if (!/^[A-Z0-9]{4,12}$/.test(ident)) {
    throw new WriteError('bad-request', `工作项编号不合法：${JSON.stringify(request?.ident)}`)
  }

  switch (request?.op) {
    case 'set-state': {
      const stateId = Number(request.stateId)
      if (!Number.isInteger(stateId) || stateId <= 0) {
        throw new WriteError('bad-request', 'set-state 需要正整数 stateId')
      }
      return {
        args: ['set-state', '--ident', ident, '--state-id', String(stateId)],
        describe: `把 ${ident} 的状态改为 ${stateId}`,
      }
    }
    case 'comment': {
      const body = String(request.body ?? '').trim()
      if (body === '') throw new WriteError('bad-request', '评论内容不能为空')
      if (body.length > COMMENT_MAX) {
        throw new WriteError('bad-request', `评论过长（${body.length} 字，上限 ${COMMENT_MAX}）`)
      }
      // 正文走 stdin：评论可能有几千字，塞进 argv 会撞命令行长度上限，
      // 也会把内容暴露在进程列表里。
      return {
        args: ['comment', '--ident', ident, '--body-file', '-'],
        stdin: body,
        describe: `给 ${ident} 写评论（${body.length} 字）`,
      }
    }
    case 'assign': {
      const assigneeId = Number(request.assigneeId)
      if (!Number.isInteger(assigneeId) || assigneeId < 0) {
        throw new WriteError('bad-request', 'assign 需要非负整数 assigneeId（0 = 取消指派）')
      }
      return {
        args: ['assign', '--ident', ident, '--assignee-id', String(assigneeId)],
        describe: `把 ${ident} 改派给用户 ${assigneeId}`,
      }
    }
    default:
      throw new WriteError('bad-request', `未知写操作：${JSON.stringify(request?.op)}`)
  }
}

/**
 * 一次**文档页写**：整页替换，必须带 `expected_version` 与 `commit_message`。
 *
 * 三条纪律：
 *   1. `expectedVersion` 取**清单**里的值 —— 这才是 CAS 语义；
 *   2. 乐观锁由 **MCP 工具**实现（它会先重读页面），插件**不重复实现**、
 *      也**绝不绕过**；
 *   3. 冲突（版本已变）时**不自动合并**，把服务端的拒绝原话交给用户。
 *
 * @param docs - 文档委派客户端。
 * @param request - UI 发来的写请求（字段不可信）。
 * @returns 写入后的新版本信息。
 */
async function writeDocPage(docs: McpDocs | undefined, request: IssueWriteRequest): Promise<IssueWriteResult> {
  const sessionId = String(request.sessionId ?? '')
  const documentId = Number(request.documentId)
  const pageId = Number(request.pageId)
  if (!Number.isInteger(documentId) || documentId <= 0) {
    throw new WriteError('bad-request', 'doc-page-update 需要正整数 documentId')
  }
  if (!Number.isInteger(pageId) || pageId <= 0) {
    throw new WriteError('bad-request', 'doc-page-update 需要正整数 pageId')
  }
  const content = String(request.content ?? '')
  if (content.trim() === '') {
    // 空串在 MCP 那边的语义是"清空这一页"，太容易误触，UI 侧直接挡掉。
    throw new WriteError('bad-request', 'doc-page-update 的 content 不能为空（要清空请到 Gitee 页面操作）')
  }
  const expectedVersion = String(request.expectedVersion ?? '').trim()
  if (expectedVersion === '') {
    throw new WriteError('bad-request', 'doc-page-update 必须带 expectedVersion（从清单里取，不要用"我拉的时候"的值）')
  }
  const commitMessage = String(request.commitMessage ?? '').trim()
  if (commitMessage === '') {
    throw new WriteError('bad-request', 'doc-page-update 必须带 commitMessage（Gitee 的历史记录靠它留痕）')
  }
  // 参数校验全部通过之后才看通道在不在：**坏请求就该报成坏请求**，
  // 不该因为"这台机器没装文档通道"而把一个参数错误说成别的原因。
  if (docs === undefined) {
    throw new WriteError('failed', '本部署没有可用的文档通道（host 未装配 MCP 文档委派层）。')
  }

  const pageName = typeof request.pageName === 'string' ? request.pageName : undefined
  const updated = await docs.updatePage(sessionId, {
    documentId,
    pageId,
    content,
    expectedVersion,
    commitMessage,
    pageName,
  })
  return {
    ok: true,
    op: 'doc-page-update',
    ident: `doc:${documentId}#${pageId}`,
    documentId,
    pageId,
    version: updated.version,
    lastEditTime: updated.lastEditTime,
  }
}

/**
 * 创建写通道。
 * @param options - 执行器、开关与文档委派客户端。
 */
export function createIssueWriter(options: IssueWriterOptions) {
  const { runner, docs } = options
  const enabled = options.enabled ?? true

  /** 已执行的写操作（进程内流水，供自检使用；不是审计日志，进程退出即消失）。 */
  const journal: { at: string; op: string; ident: string; ok: boolean; detail: string }[] = []

  return {
    /** 写通道是否开启。 */
    enabled(): boolean {
      return enabled
    },

    /** 最近若干条写操作（只读，给诊断用）。 */
    recent(limit = 20): readonly { at: string; op: string; ident: string; ok: boolean; detail: string }[] {
      return journal.slice(-limit)
    },

    /**
     * 执行一次写操作。**UI 的所有改动都从这里出去。**
     * @param request - 归一化前的请求（来自 HTTP，字段不可信）。
     */
    async write(request: IssueWriteRequest): Promise<IssueWriteResult> {
      if (!enabled) {
        throw new WriteError('disabled', '本部署关闭了写通道（hostConfig.allowWrites=false），请到 Gitee Web UI 操作。')
      }

      // 文档页写：同一入口、不同实现（委派 MCP）。
      if (request?.op === 'doc-page-update') {
        const key = `doc:${Number(request.documentId)}#${Number(request.pageId)}`
        try {
          const result = await writeDocPage(docs, request)
          journal.push({
            at: new Date().toISOString(),
            op: 'doc-page-update',
            ident: key,
            ok: true,
            detail: `整页替换并通过乐观锁（expected_version=${String(request.expectedVersion).slice(0, 12)}）`,
          })
          return result
        } catch (error) {
          if (error instanceof WriteError) {
            journal.push({ at: new Date().toISOString(), op: 'doc-page-update', ident: key, ok: false, detail: error.message })
            throw error
          }
          const message = error instanceof Error ? error.message : String(error)
          journal.push({ at: new Date().toISOString(), op: 'doc-page-update', ident: key, ok: false, detail: message })
          throw new WriteError('failed', message)
        }
      }

      const { args, stdin, describe } = normalizeIssueWrite(request)
      const op = String(request.op)
      const ident = String(request.ident).toUpperCase()

      try {
        const data = await runner.execJsonWithInput<Record<string, unknown>>(args, stdin, runner.fixtureFallback)
        journal.push({ at: new Date().toISOString(), op, ident, ok: true, detail: describe })
        return {
          ok: true,
          op: op as IssueWriteResult['op'],
          ident,
          stateId: typeof request.stateId === 'number' ? request.stateId : undefined,
          state: typeof data.state === 'string' ? data.state : undefined,
          stateTitle: typeof data.stateTitle === 'string' ? data.stateTitle : undefined,
          noteId: typeof data.noteId === 'number' ? data.noteId : undefined,
          assigneeId: typeof request.assigneeId === 'number' ? request.assigneeId : undefined,
          owner: typeof data.owner === 'string' ? data.owner : undefined,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        journal.push({ at: new Date().toISOString(), op, ident, ok: false, detail: message })
        throw new WriteError('failed', message)
      }
    },
  }
}

/** 写通道类型。 */
export type IssueWriter = ReturnType<typeof createIssueWriter>
