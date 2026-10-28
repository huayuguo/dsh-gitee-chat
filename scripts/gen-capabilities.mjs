/**
 * 从能力矩阵生成 CAPABILITIES.md。
 *
 * 存在的意义：矩阵的唯一真源是 `scripts/gitee/gq.mjs` 里的 `TIERS`，
 * 文档由它派生，冒烟测试再断言「文档 == 生成结果」——于是文档不可能与行为漂移。
 *
 * 用法：node scripts/gen-capabilities.mjs        # 写出 CAPABILITIES.md
 *       node scripts/gen-capabilities.mjs --check # 只校验是否最新（CI 用）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { presetPatchPath } from './preset-files.mjs'
import { renderMatrix, TIERS } from './gitee/gq.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const target = join(root, 'docs', 'CAPABILITIES.md')
const header = '<!-- 本文件由 scripts/gen-capabilities.mjs 从 gq.mjs 的 TIERS 生成，请勿手改 -->\n\n'
const content = header + renderMatrix() + '\n'

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
 * 0.5.4 起只剩一个 preset（`gitee`），按「执行 / 管理两模式合并」的决策
 * （见 `docs/decisions/0002-single-preset.md`）：工具**全量**给到 manager 档，
 * 能不能写由云端 token 的角色与 PR 的 `auths` 决定，不再靠预选模式。
 */
const PRESET_TIERS = {
  gitee: 'manager',
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
  // CAPABILITIES.md 是「只在本机维护、不入库」的内部文档（见 .gitignore 与 AGENTS.md）。
  // 公开仓库/CI 的干净检出里没有这个文件 —— 那种情况下跳过比对，而不是判红：
  // 真正的防漂移靠下面的 tierWrites.ts 与 preset 工具集，这两份都是入库产物。
  const current = await readFile(target, 'utf8').catch(() => null)
  // 比的是内容，不是字节。Windows 检出（core.autocrlf=true）把 CAPABILITIES.md
  // 写成 CRLF，而上面那份是按 '\n' 拼的 —— 原样比较会在 Windows 开发机/CI 上恒红。
  if (current !== null && current.replace(/\r\n/g, '\n') !== content) {
    console.error(`${target} 与代码里的能力矩阵不一致。请运行：node scripts/gen-capabilities.mjs`)
    bad = true
  }
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
  const docNote = current === null ? '未入库的内部文档已跳过' : 'CAPABILITIES.md 与能力矩阵一致'
  console.log(`${docNote} ✓（含 ${presets.length} 个 preset 的工具集 + ${writeTools.length} 个写工具）`)
} else {
  await writeFile(target, content)
  console.log(`已写出 ${target}（${content.length} 字符）`)
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
