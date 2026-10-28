/**
 * 「新建工作项」的弹窗外壳 —— 把「取类型 / 取成员 / 提交 / 报错」这套状态收在一处。
 *
 * 两个入口共用它：
 *
 *   - 项目详情页（只挂项目，不带仓库）；
 *   - 仓库详情页（带上 `repoId`，工作项就挂在这个仓库下）。
 *
 * 视觉与字段由 `IssueDialog` 负责（对齐 Gitee 网页版），这里只管数据与提交。
 *
 * @module dsh-gitee-chat/client/IssueCreate
 */

import { createElement as h, useCallback, useEffect, useState } from 'react'
import { IssueDialog, type IssueFormValues, type IssueMember } from './IssueDialog.tsx'
import { createIssue, fetchIssueTypes, fetchMembers } from './api.ts'
import type { IssueTypeRow } from '../types.ts'

/** 新建时的归属：项目必给，仓库可选（项目页新建就不带仓库）。 */
export interface IssueCreateTarget {
  /** 项目 id（企业版 `program_id`）。 */
  programId: number | null
  /** 项目名（只读展示）。 */
  programName: string
  /** 仓库 id（企业版 `project_id`）；项目页新建时为 null。 */
  repoId: number | null
  /** 仓库名（只读展示）。 */
  repoName: string
}

export interface IssueCreateDialogProps {
  /** 是否展示。 */
  open: boolean
  /** 归属（项目 / 仓库）。 */
  target: IssueCreateTarget | null
  /** 关闭（成功后也会调）。 */
  onClose: () => void
  /** 建成之后通知调用方刷新列表；参数是「已创建 <ident> <title>」那句话。 */
  onCreated?: (message: string) => void
}

/** 空表单（弹窗要一直有值可渲染）。 */
const EMPTY_FORM: IssueFormValues = {
  title: '',
  typeId: 0,
  assigneeId: 0,
  priority: 0,
  planStartedAt: '',
  deadline: '',
  description: '',
}

/** YYYY-MM-DD（本地时区；不用 toISOString，避免 UTC 偏移把「今天」算成昨天）。 */
function isoDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 默认计划时间：今天 → 下周五（多数工作项都要一个截止日，空着反而挡提交）。 */
function defaultRange(): { planStartedAt: string; deadline: string } {
  const today = new Date()
  const friday = new Date(today.getTime())
  friday.setDate(friday.getDate() + ((5 - friday.getDay() + 7) % 7 || 7))
  return { planStartedAt: isoDay(today), deadline: isoDay(friday) }
}

/** 新建工作项弹窗（自带取数、校验与提交）。 */
export function IssueCreateDialog(props: IssueCreateDialogProps) {
  const { open, target } = props
  const programId = target?.programId ?? null

  const [form, setForm] = useState<IssueFormValues | null>(null)
  const [types, setTypes] = useState<IssueTypeRow[]>([])
  const [members, setMembers] = useState<IssueMember[]>([])
  const [saving, setSaving] = useState(false)
  const [hint, setHint] = useState('')

  /** 打开时给默认值并拉候选（类型 / 成员）。 */
  useEffect(() => {
    if (!open) {
      setForm(null)
      setHint('')
      return
    }
    setForm({ ...EMPTY_FORM, ...defaultRange(), priority: 2 })
    setHint('')
    if (programId === null || programId <= 0) return
    let cancelled = false
    void (async () => {
      try {
        const rows = await fetchIssueTypes(programId)
        if (cancelled) return
        setTypes(rows)
        setForm((prev) => (prev === null ? prev : { ...prev, typeId: prev.typeId > 0 ? prev.typeId : (rows[0]?.id ?? 0) }))
      } catch (error) {
        if (!cancelled) setHint(`取工作项类型失败：${error instanceof Error ? error.message : String(error)}`)
      }
      try {
        const rows = await fetchMembers(programId)
        if (cancelled) return
        const list: IssueMember[] = rows
          .map((member) => ({ id: Number(member.id), name: member.name }))
          .filter((member) => Number.isFinite(member.id) && member.id > 0)
        setMembers(list)
        setForm((prev) => (prev === null ? prev : { ...prev, assigneeId: prev.assigneeId > 0 ? prev.assigneeId : (list[0]?.id ?? 0) }))
      } catch (error) {
        if (!cancelled) setHint(`取项目成员失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    return () => { cancelled = true }
  }, [open, programId])

  /** 提交（校验在 IssueDialog 里先过一遍）。 */
  const submit = useCallback(async () => {
    if (target === null || form === null) return
    setSaving(true)
    setHint('')
    try {
      const created = await createIssue({
        title: form.title.trim(),
        ...(target.programId !== null && target.programId > 0 ? { programId: target.programId } : {}),
        ...(target.repoId !== null && target.repoId > 0 ? { repoId: target.repoId } : {}),
        ...(form.typeId > 0 ? { typeId: form.typeId } : {}),
        ...(form.description.trim() !== '' ? { description: form.description } : {}),
        assigneeId: form.assigneeId,
        priority: form.priority,
        planStartedAt: form.planStartedAt,
        deadline: form.deadline,
      })
      const message = `已创建 ${created.ident === '' ? '' : `${created.ident} `}${created.title}`
      props.onCreated?.(message)
      props.onClose()
    } catch (error) {
      setHint(`新建失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setSaving(false)
    }
  }, [form, props, target])

  return h(IssueDialog, {
    open: open && form !== null,
    types,
    members,
    programName: target?.programName === '' ? '（未选择项目）' : (target?.programName ?? ''),
    repoName: target?.repoId === null || target?.repoId === undefined ? '（不挂仓库）' : target.repoName,
    values: form ?? EMPTY_FORM,
    saving,
    hint,
    onChange: (patch) => setForm((prev) => (prev === null ? prev : { ...prev, ...patch })),
    onClose: () => { if (!saving) props.onClose() },
    onSubmit: () => void submit(),
  })
}
