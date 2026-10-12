/**
 * 从能力矩阵派生出**两份会被代码消费的产物**。
 *
 * 存在的意义：矩阵的唯一真源是 `scripts/gitee/gq.mjs` 里的 `TIERS`，
 * 以下两份都从它派生，再由 `--check` 断言「产物 == 真源」——于是产物不可能与行为漂移：
 *   1. `src/generated/tierWrites.ts` —— 只读部署硬拦写工具用的三档并集；
 *   2. 两个 preset 的 `--enabled-toolsets` 行。
 *
 * 用法：node scripts/gen-capabilities.mjs        # 写出产物
 *       node scripts/gen-capabilities.mjs --check # 只校验是否最新（CI 用）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { presetPatchPath } from './preset-files.mjs'
import { TIERS } from './gitee/gq.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 第二份派生物：`src/generated/tierWrites.ts`。
 *
 * 谁需要它：**公开 gateway**（host 半的 `gitee_ent` 工具）。只读部署
 * （`allowWrites: false`）时它必须硬拦写工具，而这个判定不能依赖
 * 「身份已经解析出来」——`role.current()` 可能是 null（取数故障、离线）。
 * 静态并集是那一刻唯一的兜底，而它的真源仍只有 TIERS 一处。
 */
const TIER_KEYS = ['exec', 'project', 'manager']
const generatedTarget = join(root, 'src', 'generated', 'tierWrites.ts')
const writesByTier = Object.fromEntries(TIER_KEYS.map((tier) => [tier, [...TIERS[tier].writes]]))
const writeTools = [...new Set(TIER_KEYS.flatMap((tier) => writesByTier[tier]))].sort()
const generatedContent = [
  '/**',
  ' * 本文件由 scripts/gen-capabilities.mjs 从 scripts/gitee/gq.mjs 的 TIERS 生成，请勿手改。',
  ' *',
  ' * 用途：host 半的公开 gateway（`gitee_ent`）在只读部署下必须硬拦写工具，',
  ' * 而那个判定不能依赖「身份已经解析出来」——`role.current()` 可能是 null。',
  ' */',
  '',
  '/** 三档写工具名的并集（= 只读部署必须硬拦的全部工具）。 */',
  `export const WRITE_TOOLS: readonly string[] = ${JSON.stringify(writeTools, null, 2)}`,
  '',
  '/** 各档自己的写工具（exec ⊂ project ⊂ manager）。 */',
  `export const WRITE_TOOLS_BY_TIER: Readonly<Record<'exec' | 'project' | 'manager', readonly string[]>> = ${JSON.stringify(writesByTier, null, 2)}`,
  '',
].join('\n')

/**
 * 每个 preset 该启用哪一档的工具集。
 *
 * ⚠️ 这里**不是**"preset 叫什么就给哪一档"。人格档是由 **Gitee 身份**推导的
 * （见 `deriveTier`），与 preset 无关 —— 同一个 preset 下，管理者、项目负责人、
 * 普通成员会落到不同档。所以 preset 必须启用**它下面可能出现的最高档**，
 * 由门禁（`ctx.tools.guard`）按推导出的档做硬拦截。
 *
 * `gitee-exec` 之所以给 **project** 而不是 exec：它的 `preset.yml` 自己写着
 * 「若你在某项目里是负责人，该项目会自动开启项目管理与分析」。给 exec 档会让
 * 负责人**静默少 13 个工具**（含 `create_wiki`/`move_doc_node`/`list_enterprise_members`），
 * 与它自己的说明矛盾。
 */
const PRESET_TIERS = {
  'gitee-manager': 'manager',
  'gitee-exec': 'project',
}

/** 把 preset 里 `--enabled-toolsets` 那一行换成 TIERS 派生的列表。 */
async function renderPresetToolset(name) {
  const file = presetPatchPath(name)
  const text = await readFile(file, 'utf8')
  const at = text.indexOf('--enabled-toolsets')
  if (at < 0) throw new Error(`${file} 里找不到 --enabled-toolsets`)
  const lineStart = text.indexOf('\n', at) + 1
  const lineEnd = text.indexOf('\n', lineStart)
  const before = text.slice(0, lineStart)
  const after = text.slice(lineEnd + 1)
  const list = TIERS[PRESET_TIERS[name]].tools.join(',')
  // 保持缩进与 `- '…'` 形状（YAML 序列的元素，整串一个引号里）
  const rawLine = text.slice(lineStart, lineEnd)
  const indent = rawLine.match(/^\s*/)[0]
  // 行尾沿用文件自己的换行符：本仓库 preset 是 CRLF，固定写 \n 会让 text !== next
  // 恒成立（工具集一字不差也判「不一致」），--write 还会把该行悄悄换成 LF。
  const eol = rawLine.endsWith('\r') ? '\r\n' : '\n'
  const next = `${before}${indent}- '${list}'${eol}${after}`
  return { file, name, text, next }
}

const presets = await Promise.all(Object.keys(PRESET_TIERS).map(renderPresetToolset))
const drifted = presets.filter((p) => p.text !== p.next)

if (process.argv.includes('--check')) {
  let bad = false
  const currentGenerated = await readFile(generatedTarget, 'utf8').catch(() => '')
  // 比的是内容，不是字节：Windows 检出（core.autocrlf=true）会把工作区文件写成 CRLF，
  // 而这里是按 '\n' 生成的 —— 原样比较会在 Windows 开发机/CI 上恒红：
  // 「src/generated/tierWrites.ts 与 TIERS 不一致」，可 TIERS 一字没动（ubuntu 上反而全绿）。
  if (currentGenerated.replace(/\r\n/g, '\n') !== generatedContent) {
    console.error('src/generated/tierWrites.ts 与 TIERS 不一致（只读闸门会拦错工具）。请运行：node scripts/gen-capabilities.mjs')
    bad = true
  }
  for (const p of drifted) {
    console.error(`${p.file} 的 --enabled-toolsets 与 TIERS 不一致。请运行：node scripts/gen-capabilities.mjs`)
    bad = true
  }
  if (bad) process.exit(1)
  console.log(`能力矩阵派生物一致 ✓（${presets.length} 个 preset 的工具集 + ${writeTools.length} 个写工具）`)
} else {
  await mkdir(dirname(generatedTarget), { recursive: true })
  await writeFile(generatedTarget, generatedContent)
  console.log(`已写出 ${generatedTarget}（写工具并集 ${writeTools.length} 个）`)
  for (const p of presets) {
    const tier = PRESET_TIERS[p.name]
    if (p.text === p.next) { console.log(`  · presets/${p.name} 已是最新（${tier} 档 ${TIERS[tier].tools.length} 个）`); continue }
    await writeFile(p.file, p.next)
    console.log(`  ✓ presets/${p.name} → ${tier} 档 ${TIERS[tier].tools.length} 个工具`)
  }
}
