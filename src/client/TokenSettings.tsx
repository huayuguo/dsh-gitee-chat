/**
 * Gitee 企业版 token 配置 —— **只有应用设置一个入口**：
 * `GiteeSettingsSection` 注册在槽位 `settings.section`（应用「设置 → Gitee 企业项目」，
 * 与「插件市场」并列）。不知道 token 该去哪配的人，第一眼就该在设置里找到它。
 *
 * ⚠️ **不要再把配置入口做进「Gitee 项目」标签页**（曾经有一个 `⚙ 设置` 弹窗，已删除）：
 * 那个标签页只在 Gitee 模式的会话里才有内容，而"能不能进 Gitee 模式"和"有没有 token"
 * 本来就可能互为前提 —— 把配置放进标签页，等于让使用者先有 token 才能找到配 token 的地方。
 * 机器级配置就该待在机器级的设置页里。
 *
 * `TokenForm` 干实际的事：状态行 + 输入 + 保存 →
 * `POST /api/gitee-chat/token` → 宿主写 `~/.dsh/.gitee-chat/token` → gq 脚本下次调用即读到。
 *
 * @module dsh-gitee-chat/client/TokenSettings
 */

import { createElement as h, useCallback, useEffect, useState } from 'react'
import {
  BoardApiError,
  fetchEnterprises,
  fetchTokenStatus,
  postEnterprise,
  postToken,
  type EnterpriseEntry,
  type EnterpriseListResponse,
} from './api.ts'

type Msg = { kind: 'ok' | 'err'; text: string } | null

/**
 * token 表单主体：配置状态行 + 输入框 + 保存按钮。
 *
 * @param props.onSaved - 保存成功后的回调。
 */
export function TokenForm(props: { onSaved?: () => void }) {
  const [status, setStatus] = useState<{ configured: boolean; source: string | null } | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg>(null)

  useEffect(() => {
    const ctrl = new AbortController()
    void fetchTokenStatus(ctrl.signal)
      .then((s) => setStatus({ configured: s.configured, source: s.source }))
      .catch(() => { /* 静默：状态行不出现而已 */ })
    return () => ctrl.abort()
  }, [])

  const save = useCallback(async () => {
    const token = value.trim()
    if (token === '') {
      setMsg({ kind: 'err', text: '请先粘贴 token' })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      await postToken(token)
      setMsg({ kind: 'ok', text: '已保存。取数即时生效；如仓库 WIKI 仍取不到，重启一次 dsh web 即可。' })
      setValue('')
      setStatus({ configured: true, source: 'file' })
      props.onSaved?.()
    } catch (error) {
      setMsg({ kind: 'err', text: error instanceof BoardApiError ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }, [value, props])

  return h('div', null,
    status === null
      ? null
      : h('div', {
          style: {
            fontSize: 12,
            marginBottom: 8,
            color: status.configured ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)',
          },
        },
          status.configured
            ? `✓ 已配置（来源：${status.source}）`
            : '⚠ 尚未配置 —— 取数会提示「未配置 token」',
        ),
    h('input', {
      type: 'password',
      placeholder: '粘贴企业版 access token',
      value,
      onChange: (e: { currentTarget: { value: string } }) => setValue(e.currentTarget.value),
      style: inputStyle,
    }),
    msg === null
      ? null
      : h('div', { style: { fontSize: 12, marginTop: 8, color: msg.kind === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)', lineHeight: 1.6 } }, msg.text),
    h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 } },
      h('button', { onClick: save, disabled: busy, style: btnStyle(true) }, busy ? '保存中…' : '保存'),
    ),
  )
}

/** 当前企业的中文描述（列表可能还没加载出来）。 */
function describeCurrent(data: EnterpriseListResponse): string {
  if (data.pinned > 0) return `${nameOf(data, data.pinned)}（由插件配置钉住）`
  if (data.effective > 0) return `${nameOf(data, data.effective)}（来源：${data.source}）`
  return '未指定 —— 只属于一个企业时自动使用，多个企业时取数会要求先选'
}

/** 在列表里找名字；找不到就退回 id。 */
function nameOf(data: EnterpriseListResponse, id: number): string {
  const hit: EnterpriseEntry | undefined = data.enterprises.find((e) => e.id === id)
  return hit === undefined ? String(id) : `${hit.name}（${id}）`
}

/**
 * 企业选择器 —— **配好 token 之后就在这里选企业**。
 *
 * 以前换企业只能「让 AI 跑 `gq enterprises --use <id>`」：那等于把一条机器级配置
 * 藏进一段对话里，还得先知道有这条命令。这里把它做成设置页的正规控件：
 * 列出 token 可见的企业、标出当前用的是哪家、选了立刻写入，并让宿主**同时**失效
 * 看板缓存与身份人格（见 `host/enterprise.ts`）—— 否则会出现「列表换了、卡片还是
 * 上一家」的静默错数据。
 *
 * 取不到列表时只显示一句提示，不弹错：它与 token 表单同节，顺序本就是先配 token。
 *
 * @param props.reloadKey - 外部（token 保存成功）触发的重新拉取信号。
 */
export function EnterprisePicker(props: { reloadKey?: number }) {
  const [data, setData] = useState<EnterpriseListResponse | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const ctrl = new AbortController()
    void fetchEnterprises(ctrl.signal)
      .then((d) => {
        setData(d)
        setProblem(null)
      })
      .catch((error: unknown) => {
        if ((error as Error)?.name === 'AbortError') return
        setData(null)
        setProblem(error instanceof BoardApiError ? error.message : String(error))
      })
    return () => ctrl.abort()
  }, [props.reloadKey, tick])

  const apply = useCallback(async (id: number) => {
    if (!Number.isInteger(id) || id <= 0) return
    setBusy(true)
    setMsg(null)
    try {
      const res = await postEnterprise(id)
      const name = res.selected === null ? String(res.effective) : `${res.selected.name}（${res.selected.id}）`
      const blocked = res.pinned > 0 && res.pinned !== (res.selected?.id ?? 0)
      setMsg({
        kind: blocked ? 'err' : 'ok',
        text: blocked
          ? `已写入 ${name}，但插件配置把企业钉在 ${res.pinned} —— 实际生效的仍是它。`
            + '要让这里的选择生效，请重跑安装脚本且**不**指定企业 id。'
          : `已切换到 ${name}。${res.invalidated.join('、')}已随之失效，下一次取数就是这家企业的数据（无需重启）。`,
      })
      setTick((t) => t + 1)
    } catch (error) {
      setMsg({ kind: 'err', text: error instanceof BoardApiError ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }, [])

  const list = data?.enterprises ?? []
  const locked = (data?.pinned ?? 0) > 0

  return h('div', { style: { marginTop: 22 } },
    h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 8 } }, '当前企业'),
    h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 10 } },
      'token 属于多个企业时必须选一个 —— 插件不会替你挑（挑错就会出现「拿错公司数据」）。',
      data === null ? null : h('br'),
      data === null ? null : `当前：${describeCurrent(data)}`,
    ),
    data === null
      ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
          problem === null ? '读取中…' : `还没取到企业列表：${problem}`)
      : h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('select', {
            value: data.effective > 0 ? String(data.effective) : '',
            disabled: busy || locked,
            onChange: (e: { currentTarget: { value: string } }) => { void apply(Number(e.currentTarget.value)) },
            style: selectStyle,
          },
            data.effective > 0 ? null : h('option', { value: '' }, '未指定（自动）'),
            list.map((e) => h('option', { key: e.id, value: String(e.id) }, `${e.name}（${e.id}）`)),
          ),
          h('button', {
            onClick: () => setTick((t) => t + 1),
            disabled: busy,
            style: btnStyle(false),
          }, busy ? '切换中…' : '刷新'),
        ),
    locked
      ? h('div', { style: { fontSize: 12, marginTop: 8, color: 'var(--dsw-alias-state-warn-primary)' } },
          `⚠ 插件配置把企业钉在 ${data?.pinned}，这里选择不会生效。`)
      : null,
    msg === null
      ? null
      : h('div', {
          style: {
            fontSize: 12,
            marginTop: 8,
            lineHeight: 1.6,
            color: msg.kind === 'ok' ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
          },
        }, msg.text),
  )
}

/**
 * 「设置 → Gitee 企业项目」分节（正式入口）。
 *
 * 槽位 `settings.section` 传给分节的 owner props 只有 `close`，这里用不上 ——
 * 配好 token 之后提示使用者去新建 Gitee 模式的会话即可，不需要替他跳转。
 */
export function GiteeSettingsSection(_props: { close?: () => void }) {
  // token 刚保存 → 企业列表可能才有内容，重新拉一次（不必让使用者手动刷新）。
  const [tick, setTick] = useState(0)
  return h('div', { style: { maxWidth: 640, lineHeight: 1.8 } },
    h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 8 } }, 'Gitee 企业版 Token'),
    h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 12 } },
      '存到 ', h('code', null, '~/.dsh/.gitee-chat/token'),
      '，取数脚本每次现读 —— 保存后即时生效，不用重启 dsh。',
      h('br'),
      '在 Gitee 企业版「设置 → 私人令牌」生成，勾选企业版接口权限后粘贴到下方。',
    ),
    h(TokenForm, { onSaved: () => setTick((t) => t + 1) }),
    h(EnterprisePicker, { reloadKey: tick }),
    h('div', {
      style: {
        marginTop: 20,
        paddingTop: 14,
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },
    },
      h('div', { style: { fontWeight: 600, marginBottom: 6, color: 'var(--dsw-alias-label-primary)' } }, '配好之后怎么用'),
      h('div', null,
        '新建会话时在预设里选「Gitee 企业项目管理」或「Gitee 项目执行」；',
        '会话里会多出「Gitee 项目」标签页 —— 项目看板、仓库 WIKI、知识库文档、固定分析都在那里。',
      ),
      h('div', { style: { marginTop: 6 } },
        '换企业：直接在上面「当前企业」里选，不用重启 dsh，也不用记命令。',
        h('br'),
        '看 token 有没有生效、环境是否连通：让 AI 跑 ',
        h('code', null, 'node scripts/setup.mjs verify'),
        '。',
      ),
    ),
  )
}

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  border: '1px solid var(--dsw-alias-label-secondary)',
  borderRadius: 4,
  fontFamily: 'monospace',
  fontSize: 13,
} as const

/** 下拉框：沿用输入框的边框语言，但字体交回界面（企业名不是代码）。 */
const selectStyle = {
  ...inputStyle,
  width: 'auto',
  minWidth: 260,
  fontFamily: 'inherit',
  fontSize: 13,
} as const

function btnStyle(primary: boolean): Record<string, string> {
  return {
    padding: '6px 16px',
    borderRadius: 4,
    border: '1px solid ' + (primary ? 'var(--dsw-alias-button-primary-fill)' : 'var(--dsw-alias-label-secondary)'),
    background: primary ? 'var(--dsw-alias-button-primary-fill)' : 'var(--dsw-alias-bg-base)',
    color: primary ? 'var(--dsw-alias-label-primary-foreground)' : 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
    fontSize: 13,
  }
}
