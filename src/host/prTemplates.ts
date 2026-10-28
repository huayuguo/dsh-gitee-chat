/**
 * 审核 / 测试模板（0.5.4）。
 *
 * 三层优先级，越靠前越优先：
 *   1. **仓库级绑定**：`$DSH_HOME/.gitee-chat/config.json` 的
 *      `templateBindings[repoPath] = { review?: name, test?: name }`
 *      —— 同一个企业里不同仓库可以挂不同模板，且审核与测试**各自绑定**
 *      （兼容旧形状 `templateBindings[repoPath] = name`：两个 kind 都用它）；
 *   2. **用户副本**：`$DSH_HOME/.gitee-chat/templates/<name>.md` —— 界面里改过的版本；
 *   3. **随包内置**：`<插件根>/skills/dsh-gitee-chat/templates/{review,test}.md`。
 *
 * 为什么模板是**文件**而不是常量：用户要求「UI 可看可改、每个仓库可能不同」，
 * 而且改模板不该触发发版。内置那份只是兜底，永不覆盖用户副本。
 *
 * @module dsh-gitee-chat/host/prTemplates
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { packageRoot } from './gq.ts'
import type { PrTemplateMeta, PrTemplatesResponse } from '../types.ts'

/**
 * 模板种类。
 *   - `pr` —— 新建 PR 的**干净骨架**（只有小标题，点「套用模板」原样进描述框）；
 *   - `prGuide` —— 同一套小标题 + **每节该写什么**的说明（人看「写什么？」、AI 起草的输入）；
 *   - review/test 只服务 AI 审核与 AI 测试。
 */
export type TemplateKind = 'review' | 'test' | 'pr' | 'prGuide'

/** 全部 kind（遍历用；加 kind 只改这里 + 放一个内置文件）。 */
const KINDS = ['review', 'test', 'pr', 'prGuide'] as const

/** kind → 文件名主干（`prGuide` 的文件名是 `pr-guide`，与 kind 名不同）。 */
const FILE_STEM: Record<TemplateKind, string> = {
  review: 'review',
  test: 'test',
  pr: 'pr',
  prGuide: 'pr-guide',
}

/** 内置模板缺失时的占位标题。 */
const MISSING_LABEL: Record<TemplateKind, string> = {
  review: '代码审查模板',
  test: '测试验收模板',
  pr: 'PR 描述模板',
  prGuide: 'PR 描述填写说明',
}

/** 一个解析好的模板。 */
export interface ResolvedTemplate {
  name: string
  path: string
  content: string
  source: 'builtin' | 'user'
}

/** 依赖：只注入路径，方便测试替身。 */
export interface PrTemplateDeps {
  /** 用户配置目录（默认 `$DSH_HOME/.gitee-chat`）。 */
  readonly configRoot?: string
  /** 随包技能的 templates 目录（默认 `<包根>/skills/dsh-gitee-chat/templates`）。 */
  readonly builtinRoot?: string
}

/** 模板名只允许字母数字与 `-` `_`（它会变成文件名）。 */
function validName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/.test(name)
}

/** DSH 主目录。 */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 创建模板服务。 */
export function createPrTemplates(deps: PrTemplateDeps = {}) {
  const configRoot = deps.configRoot ?? join(dshHome(), '.gitee-chat')
  const builtinRoot = deps.builtinRoot ?? join(packageRoot(), 'skills', 'dsh-gitee-chat', 'templates')
  const userRoot = join(configRoot, 'templates')
  const configPath = join(configRoot, 'config.json')

  /** 读 config.json（坏文件当空对象，不抛）。 */
  function readConfig(): Record<string, unknown> {
    try {
      if (!existsSync(configPath)) return {}
      const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  /** 仓库级绑定表，规整成 `repoPath -> { review?, test? }`。 */
  function bindings(): Record<string, Partial<Record<TemplateKind, string>>> {
    const raw = readConfig().templateBindings
    if (typeof raw !== 'object' || raw === null) return {}
    const out: Record<string, Partial<Record<TemplateKind, string>>> = {}
    for (const [repoPath, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string') {
        // 旧形状：一个名字同时管审核与测试
        if (validName(value)) out[repoPath] = { review: value, test: value }
        continue
      }
      if (typeof value !== 'object' || value === null) continue
      const entry: Partial<Record<TemplateKind, string>> = {}
      for (const kind of KINDS) {
        const name = (value as Record<string, unknown>)[kind]
        if (typeof name === 'string' && validName(name)) entry[kind] = name
      }
      if (Object.keys(entry).length > 0) out[repoPath] = entry
    }
    return out
  }

  /** 某个仓库某个 kind 的绑定名（没有就 undefined）。 */
  function boundName(kind: TemplateKind, repoPath: string): string | undefined {
    if (repoPath === '') return undefined
    return bindings()[repoPath]?.[kind]
  }

  /**
   * 把绑定写回 config.json（保留其它字段）。
   *
   * `kind` 缺省表示「两个 kind 都绑这个模板」（老行为）；给了 kind 只动那一份，
   * 另一份保持不变 —— 审核模板与测试模板是两份文档，不该互相覆盖。
   */
  function writeBinding(repoPath: string, kind: TemplateKind | null, name: string | null): void {
    const cfg = readConfig()
    const table = bindings()
    const entry = table[repoPath] ?? {}
    if (kind === null) {
      if (name === null) delete table[repoPath]
      else table[repoPath] = { review: name, test: name }
    } else if (name === null) {
      delete entry[kind]
      if (Object.keys(entry).length === 0) delete table[repoPath]
      else table[repoPath] = entry
    } else {
      table[repoPath] = { ...entry, [kind]: name }
    }
    const keys = Object.keys(table)
    if (keys.length === 0) delete cfg.templateBindings
    else cfg.templateBindings = table
    mkdirSync(configRoot, { recursive: true })
    writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8')
  }

  /** 内置模板文件名：review → review.md，test → test.md。 */
  function builtinPath(kind: TemplateKind): string {
    return join(builtinRoot, `${FILE_STEM[kind]}.md`)
  }

  /** 读文件，读不到返回空串。 */
  function readOr(path: string): string {
    try {
      return existsSync(path) ? readFileSync(path, 'utf8') : ''
    } catch {
      return ''
    }
  }

  /** 列所有可用模板（内置 + 用户）。 */
  function list(): PrTemplateMeta[] {
    const items: PrTemplateMeta[] = []
    for (const kind of KINDS) {
      const path = builtinPath(kind)
      if (existsSync(path)) {
        items.push({
          name: kind,
          path,
          source: 'builtin',
          updatedAt: undefined,
        })
      }
    }
    if (existsSync(userRoot)) {
      for (const file of readdirSync(userRoot).sort()) {
        if (!file.endsWith('.md')) continue
        const name = file.slice(0, -3)
        if (!validName(name)) continue
        items.push({ name, path: join(userRoot, file), source: 'user' })
      }
    }
    return items
  }

  /** 解析某仓库当前生效的模板：仓库绑定 → 用户副本 → 内置。 */
  function resolve(kind: TemplateKind, repoPath: string): ResolvedTemplate {
    const bound = boundName(kind, repoPath)
    const candidates: Array<{ name: string; path: string; source: 'builtin' | 'user' }> = []
    if (bound !== undefined) {
      const userPath = join(userRoot, `${bound}.md`)
      const builtinCandidate = join(builtinRoot, `${bound}.md`)
      if (existsSync(userPath)) candidates.push({ name: bound, path: userPath, source: 'user' })
      else if (existsSync(builtinCandidate)) candidates.push({ name: bound, path: builtinCandidate, source: 'builtin' })
    }
    const userKind = join(userRoot, `${kind}.md`)
    if (existsSync(userKind)) candidates.push({ name: kind, path: userKind, source: 'user' })
    const builtin = builtinPath(kind)
    if (existsSync(builtin)) candidates.push({ name: kind, path: builtin, source: 'builtin' })

    const hit = candidates[0]
    if (hit === undefined) {
      return {
        name: kind,
        path: builtin,
        source: 'builtin',
        content: `# ${MISSING_LABEL[kind]}（缺失）\n\n没有找到内置模板，请在「设置 → Gitee 企业项目」检查随包 skills 目录。\n`,
      }
    }
    return { ...hit, content: readOr(hit.path) }
  }

  /**
   * 四份生效模板 + 名字。
   *   - `pr` = 干净骨架（对话框「套用模板」原样插入）；
   *   - `prGuide` = 带每节说明（对话框「写什么？」展示，AI 起草时当写作要求）。
   */
  function active(repoPath: string): PrTemplatesResponse {
    const review = resolve('review', repoPath)
    const test = resolve('test', repoPath)
    const pr = resolve('pr', repoPath)
    const prGuide = resolve('prGuide', repoPath)
    return {
      items: list(),
      active: { review: review.content, test: test.content, pr: pr.content, prGuide: prGuide.content },
      activeName: { review: review.name, test: test.name, pr: pr.name, prGuide: prGuide.name },
    }
  }

  /**
   * 保存一份用户模板；给了 `repoPath` 就顺手绑定。
   *
   * `kind` 缺省 = 两个 kind 都绑（老行为）；给了 kind 只绑那一份。
   */
  function save(input: {
    name: string
    content: string
    repoPath?: string | null
    kind?: TemplateKind | null
  }): PrTemplateMeta {
    if (!validName(input.name)) {
      throw new Error('模板名只允许字母/数字/下划线/连字符，长度 1–41。')
    }
    mkdirSync(userRoot, { recursive: true })
    const path = join(userRoot, `${input.name}.md`)
    writeFileSync(path, input.content, 'utf8')
    const repoPath = input.repoPath ?? null
    if (repoPath !== null && repoPath !== '') writeBinding(repoPath, input.kind ?? null, input.name)
    return { name: input.name, path, source: 'user', ...(input.kind == null ? {} : { kind: input.kind }) }
  }

  /** 只绑仓库，不改内容（选择已有模板）；`kind` 缺省 = 两个都绑。 */
  function bind(repoPath: string, name: string | null, kind: TemplateKind | null = null): void {
    if (name !== null && !validName(name)) throw new Error('模板名不合法。')
    writeBinding(repoPath, kind, name)
  }

  return { list, resolve, active, save, bind, builtinPath, userRoot }
}

/** 模板服务类型。 */
export type PrTemplates = ReturnType<typeof createPrTemplates>
