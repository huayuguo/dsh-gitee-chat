/**
 * preset 的路径与读取 —— **一处定义，三处（smoke / gen-capabilities / build-mcp）共用**。
 *
 * 为什么要有这个文件：DSH 0.1.7 起 preset 的交付形态变了（见 `DESIGN.md` §29）——
 * 不再是 `$DSH_HOME/.agent-presets/<id>/agent.cordis.yml` 那样的目录，
 * 而是**本包 bundle 补丁列表里**的 `presets/<id>.patch.yml`（声明式 preset 行）。
 * 于是"读某个 preset 的组合文本"这件事从"进目录"变成了"打开对应补丁文件"，
 * 而它散落在好几个脚本里 —— 散着写就会出现"有的脚本还在找老路径"这种半迁移状态。
 *
 * 用法：
 *   import { presetPatchPath, listPresetIds, readPresetPatchText } from './preset-files.mjs'
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** 本包 preset 补丁所在目录。 */
export const presetDir = join(root, 'presets')

/** preset 补丁的后缀（也是"这个目录里什么算 preset"的唯一判据）。 */
export const PRESET_PATCH_SUFFIX = '.patch.yml'

/** 一个 preset id 对应的补丁文件绝对路径。 */
export function presetPatchPath(id) {
  return join(presetDir, `${id}${PRESET_PATCH_SUFFIX}`)
}

/** 仓库里所有 preset id（按补丁文件名升序）。 */
export function listPresetIds() {
  if (!existsSync(presetDir)) return []
  return readdirSync(presetDir)
    .filter((f) => f.endsWith(PRESET_PATCH_SUFFIX))
    .map((f) => f.slice(0, -PRESET_PATCH_SUFFIX.length))
    .sort()
}

/** 读一个 preset 补丁的文本。找不到就抛 —— 静默回落成空文本会假装"这个 preset 没问题"。 */
export function readPresetPatchText(id) {
  return readFileSync(presetPatchPath(id), 'utf8')
}
