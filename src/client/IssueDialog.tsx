/**
 * 「新建任务 / 需求 / 缺陷」弹窗 —— 视觉对齐 Gitee 网页版的新建弹窗。
 *
 * 用户口径（m03447 / m03569，「效果完全不接受」之后重做）：
 *
 *   - 弹窗居中、白底、小圆角，标题按选中的类型换词（新建任务 / 新建需求 / 新建缺陷）；
 *   - 两列栅格：标题独占一行 → 负责人/协作者 + 类型 → 优先级 + **计划时间（开始 + 结束）**
 *     → 关联项目/仓库（只读）→ 描述；
 *   - **描述就是纯文本框，不带工具条**（用户明确否掉了 Markdown 工具条）；
 *   - 必填项在 label 上带红星，逐字段报错；底部右对齐「取消 / 创建任务」。
 *
 * 状态由 `RepoPanel` 持有（`values` + `onChange`），这里只负责展示与必填校验。
 *
 * @module dsh-gitee-chat/client/IssueDialog
 */

import { createElement as h, useCallback, useEffect, useState } from 'react'
import css from './issue.module.css'
import type { IssueTypeRow } from '../types.ts'

/** 弹窗里编辑的字段（与 host `/issue-create` 的请求体一一对应）。 */
export interface IssueFormValues {
  title: string
  typeId: number
  assigneeId: number
  priority: number
  /** 计划开始日（YYYY-MM-DD）。 */
  planStartedAt: string
  /** 计划结束日 / 截止日（YYYY-MM-DD）。 */
  deadline: string
  description: string
}

/** 项目成员（负责人候选）。 */
export interface IssueMember {
  id: number
  name: string
}

export interface IssueDialogProps {
  /** 是否展示。 */
  open: boolean
  /** 工作项类型（任务/需求/缺陷…）。 */
  types: IssueTypeRow[]
  /** 负责人候选（项目成员）。 */
  members: IssueMember[]
  /** 当前项目名（只读展示）。 */
  programName: string
  /** 当前仓库名（只读展示）。 */
  repoName: string
  /** 当前表单值。 */
  values: IssueFormValues
  /** 正在提交。 */
  saving: boolean
  /** 提交结果 / 错误提示（空串 = 不显示）。 */
  hint: string
  /** 字段变更。 */
  onChange: (patch: Partial<IssueFormValues>) => void
  /** 关闭。 */
  onClose: () => void
  /** 提交（调用方负责真正发请求）。 */
  onSubmit: () => void
}

/** 优先级候选（企业版 priority：4=P0 最高 … 1=P3 最低）。 */
const PRIORITIES: Array<{ value: number; label: string }> = [
  { value: 4, label: 'P0 紧急' },
  { value: 3, label: 'P1 高' },
  { value: 2, label: 'P2 中' },
  { value: 1, label: 'P3 低' },
]

/**
 * 计划时间快捷段（Gitee 网页版是日期区间选择器，这里用「开始 + 结束」两个日期 + 几个快捷段，
 * 不引第三方日期库 —— 插件只依赖打包期之外零运行时依赖）。
 */
const RANGES: Array<{ key: string; label: string; days: number }> = [
  { key: '3d', label: '3 天', days: 3 },
  { key: '1w', label: '1 周', days: 7 },
  { key: '2w', label: '2 周', days: 14 },
]

/** 各字段的错误文案（空对象 = 都填好了）。 */
type IssueErrors = Partial<Record<keyof IssueFormValues, string>>

/** YYYY-MM-DD（本地时区，避免 toISOString 的 UTC 偏差把「今天」算成昨天）。 */
function isoDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 必填校验：每个字段各自报错，改哪个清哪个。 */
function validate(values: IssueFormValues, members: IssueMember[]): IssueErrors {
  const errors: IssueErrors = {}
  if (values.title.trim() === '') errors.title = '请填写标题。'
  if (values.assigneeId <= 0) errors.assigneeId = members.length === 0 ? '取不到项目成员：先确认这个项目里有人。' : '请选择负责人。'
  if (values.priority <= 0) errors.priority = '请选择优先级。'
  if (values.planStartedAt.trim() === '') errors.planStartedAt = '请选择开始日期。'
  if (values.deadline.trim() === '') errors.deadline = '请选择结束日期。'
  if (values.planStartedAt !== '' && values.deadline !== '' && values.deadline < values.planStartedAt) {
    errors.deadline = '结束日期不能早于开始日期。'
  }
  return errors
}

/** 弹窗主体。 */
export function IssueDialog(props: IssueDialogProps) {
  const { open, types, members, values, saving, hint } = props
  const [touched, setTouched] = useState(false)

  // 关掉就复位「试过提交」的标记，下次打开不残留红字
  useEffect(() => {
    if (!open) setTouched(false)
  }, [open])

  // Esc 关窗（只在没在提交时）
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, saving, props])

  const errors = validate(values, members)
  const fieldErr = (field: keyof IssueFormValues): string => (touched ? (errors[field] ?? '') : '')

  /** 底部的提交：先过必填校验，再交给调用方。 */
  const submit = useCallback(() => {
    setTouched(true)
    if (saving) return
    if (Object.keys(validate(values, members)).length > 0) return
    props.onSubmit()
  }, [members, props, saving, values])

  /** 快捷段：以开始日为基准往后推 N 天填结束日。 */
  const applyRange = useCallback((days: number) => {
    const base = values.planStartedAt === '' ? new Date() : new Date(`${values.planStartedAt}T00:00:00`)
    const end = new Date(base.getTime())
    end.setDate(end.getDate() + days)
    props.onChange({
      planStartedAt: values.planStartedAt === '' ? isoDay(base) : values.planStartedAt,
      deadline: isoDay(end),
    })
  }, [props, values.planStartedAt])

  if (!open) return null

  const typeTitle = types.find((item) => item.id === values.typeId)?.title ?? '任务'
  const noun = typeTitle.replace(/^\S+\s*/, '') || typeTitle
  const startError = fieldErr('planStartedAt')
  const endError = fieldErr('deadline')

  return h('div', {
    className: css.gqIssueOverlay,
    role: 'presentation',
    onMouseDown: (event: { target?: unknown; currentTarget?: unknown }) => {
      // 点蒙层空白处关窗（点弹窗内部不关）
      if (event.target === event.currentTarget && !saving) props.onClose()
    },
  },
    h('div', {
      className: css.gqIssueModal,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': `新建${noun}`,
      tabIndex: -1,
    },
      h('div', { className: css.gqIssueHd },
        h('h2', { className: css.gqIssueTitle }, `新建${noun}`),
        h('button', {
          type: 'button',
          className: css.gqIssueClose,
          title: '关闭',
          disabled: saving,
          onClick: () => props.onClose(),
        }, '×'),
      ),

      h('div', { className: css.gqIssueBd },
        // 标题（独占一行）
        h('label', { className: `${css.gqIssueField} ${css.gqIssueFull}` },
          h('span', { className: css.gqIssueLabel }, '标题', h('span', { className: css.gqIssueReq }, '*')),
          h('input', {
            className: css.gqIssueInput,
            value: values.title,
            placeholder: '请填写',
            autoFocus: true,
            onChange: (event: { target?: { value?: string } }) => props.onChange({ title: event.target?.value ?? '' }),
          }),
          fieldErr('title') === '' ? null : h('span', { className: css.gqIssueErr }, fieldErr('title')),
        ),

        // 负责人/协作者 + 类型
        h('label', { className: css.gqIssueField },
          h('span', { className: css.gqIssueLabel }, '负责人/协作者', h('span', { className: css.gqIssueReq }, '*')),
          h('select', {
            className: css.gqIssueSelect,
            value: String(values.assigneeId),
            onChange: (event: { target?: { value?: string } }) => props.onChange({ assigneeId: Number(event.target?.value ?? 0) }),
          },
            values.assigneeId > 0 ? null : h('option', { value: '0' }, members.length === 0 ? '（取不到项目成员）' : '指派负责人/协作者'),
            members.map((member) => h('option', { key: member.id, value: String(member.id) }, member.name)),
          ),
          fieldErr('assigneeId') === '' ? null : h('span', { className: css.gqIssueErr }, fieldErr('assigneeId')),
        ),
        h('label', { className: css.gqIssueField },
          h('span', { className: css.gqIssueLabel }, '类型', h('span', { className: css.gqIssueReq }, '*')),
          h('select', {
            className: css.gqIssueSelect,
            value: String(values.typeId),
            onChange: (event: { target?: { value?: string } }) => props.onChange({ typeId: Number(event.target?.value ?? 0) }),
          },
            types.length === 0 ? h('option', { value: '0' }, '任务') : null,
            types.map((item) => h('option', { key: item.id, value: String(item.id) }, item.title)),
          ),
        ),

        // 优先级
        h('label', { className: css.gqIssueField },
          h('span', { className: css.gqIssueLabel }, '优先级', h('span', { className: css.gqIssueReq }, '*')),
          h('select', {
            className: css.gqIssueSelect,
            value: String(values.priority),
            onChange: (event: { target?: { value?: string } }) => props.onChange({ priority: Number(event.target?.value ?? 0) }),
          },
            values.priority > 0 ? null : h('option', { value: '0' }, '请选择'),
            PRIORITIES.map((item) => h('option', { key: item.value, value: String(item.value) }, item.label)),
          ),
          fieldErr('priority') === '' ? null : h('span', { className: css.gqIssueErr }, fieldErr('priority')),
        ),

        // 计划时间：开始 + 结束（同一行两个日期 + 快捷段）
        h('div', { className: css.gqIssueField },
          h('span', { className: css.gqIssueLabel }, '计划时间', h('span', { className: css.gqIssueReq }, '*')),
          h('div', { className: css.gqIssueRange },
            h('input', {
              className: `${css.gqIssueInput} ${css.gqIssueDate}`,
              type: 'date',
              value: values.planStartedAt,
              title: '开始日期',
              onChange: (event: { target?: { value?: string } }) => props.onChange({ planStartedAt: event.target?.value ?? '' }),
            }),
            h('span', { className: css.gqIssueRangeSep }, '→'),
            h('input', {
              className: `${css.gqIssueInput} ${css.gqIssueDate}`,
              type: 'date',
              value: values.deadline,
              title: '结束日期',
              onChange: (event: { target?: { value?: string } }) => props.onChange({ deadline: event.target?.value ?? '' }),
            }),
          ),
          startError === '' ? null : h('span', { className: css.gqIssueErr }, startError),
          endError === '' ? null : h('span', { className: css.gqIssueErr }, endError),
        ),

        // 关联项目 / 关联仓库（只读，新建时就定死，避免挂错地方）
        h('label', { className: css.gqIssueField },
          h('span', { className: css.gqIssueLabel }, '关联项目'),
          h('span', { className: css.gqIssueReadonly, title: props.programName }, props.programName),
        ),
        h('label', { className: css.gqIssueField },
          h('span', { className: css.gqIssueLabel }, '关联仓库'),
          h('span', { className: css.gqIssueReadonly, title: props.repoName }, props.repoName),
        ),

        // 描述：纯文本（用户口径：不要工具条）
        h('div', { className: `${css.gqIssueField} ${css.gqIssueFull}` },
          h('span', { className: css.gqIssueLabel }, '描述'),
          h('textarea', {
            className: css.gqIssueArea,
            value: values.description,
            placeholder: '背景 / 期望结果 / 验收口径…',
            onChange: (event: { target?: { value?: string } }) => props.onChange({ description: event.target?.value ?? '' }),
          }),
        ),

        hint === ''
          ? null
          : h('div', {
              className: hint.startsWith('已创建') ? css.gqIssueHint : `${css.gqIssueHint} ${css.gqIssueHintErr}`,
            }, hint),
      ),

      h('div', { className: css.gqIssueFt },
        h('span', { className: css.gqIssueFtTip }, '带 * 的是必填项'),
        h('button', {
          type: 'button',
          className: css.gqIssueBtn,
          disabled: saving,
          onClick: () => props.onClose(),
        }, '取消'),
        h('button', {
          type: 'button',
          className: `${css.gqIssueBtn} ${css.gqIssueBtnPrimary}`,
          disabled: saving,
          onClick: submit,
        }, saving ? '正在创建…' : `创建${noun}`),
      ),
    ),
  )
}
