/**
 * 0.5.4 视觉令牌 —— 界面里**唯一**允许出现裸色值/裸尺寸的地方。
 *
 * 口径来自 `docs/design/ui-style.md`（已批准原型 `.tmp/design/pr-panel/project.html`）：
 *   - 结构色（底/面/边/字）映射到 DSH 主题令牌 `--dsw-alias-*`，带 ui-style 的兜底值，
 *     所以浅色主题下与原型一致、深色主题下自动跟随宿主；
 *   - 语义色（成功/警告/危险/信息/紫）是设计稿指定的固定色，保持字面值不随主题漂移，
 *     浅底一律用 `color-mix()` 由语义色与「面」色现场混合，深色主题下也不会糊。
 *
 * 页面与组件**只准**用 `var(--gq-*)`（CSS）或 `GQ.*`（内联样式），
 * 间距/圆角/字号用 `SP` / `RADIUS` / `FS`，不再出现 `12px` 这类魔法值。
 *
 * @module dsh-gitee-chat/client/tokens
 */

/** 令牌定义（注入到 `<style>` 的最前面，作用域限定在 Gitee 视图根节点内）。 */
export const TOKENS_CSS = `
[data-gq-root] {
  --gq-bg: var(--dsw-alias-bg-base, #f6f7f9);
  --gq-surface: var(--dsw-alias-bg-layer-1, #ffffff);
  --gq-surface-2: var(--dsw-alias-bg-layer-2, #f9fafb);
  --gq-border: var(--dsw-alias-border-l1, #e5e7eb);
  --gq-border-2: var(--dsw-alias-border-l2, #d1d5db);
  --gq-text: var(--dsw-alias-label-primary, #111827);
  --gq-text-2: var(--dsw-alias-label-secondary, #4b5563);
  --gq-text-3: #9ca3af;
  --gq-ok: #16a34a;
  --gq-warn: #d97706;
  --gq-danger: #dc2626;
  --gq-info: #2563eb;
  --gq-violet: #7c3aed;
  --gq-muted: #6b7280;
  --gq-slate: #94a3b8;
  --gq-brand: var(--dsw-alias-brand-primary, #c71d23);
  --gq-brand-fg: var(--dsw-alias-label-primary-foreground, #ffffff);
  /* 暖色系（卡片外框专用）——低饱和，只做「一眼能分开」的层次，不抢内容 */
  --gq-warm-line: #ece2d3;
  --gq-warm-line-2: #d9c3a3;
  --gq-warm-soft: #fdf8f1;
  --gq-warm-shadow: 0 2px 10px rgba(150, 110, 60, 0.08);
  --gq-shadow-1: 0 1px 2px rgba(17, 24, 39, 0.05);
  --gq-shadow-2: 0 10px 30px rgba(17, 24, 39, 0.16);
  --gq-shadow-3: 0 24px 60px rgba(17, 24, 39, 0.28);
  --gq-overlay: rgba(17, 24, 39, 0.42);
  --gq-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
`.trim()

/** 语义色 → CSS 变量。内联样式 / 内联 SVG 一律走这里。 */
export const GQ = {
  bg: 'var(--gq-bg)',
  surface: 'var(--gq-surface)',
  surface2: 'var(--gq-surface-2)',
  border: 'var(--gq-border)',
  border2: 'var(--gq-border-2)',
  text: 'var(--gq-text)',
  text2: 'var(--gq-text-2)',
  text3: 'var(--gq-text-3)',
  ok: 'var(--gq-ok)',
  warn: 'var(--gq-warn)',
  danger: 'var(--gq-danger)',
  info: 'var(--gq-info)',
  violet: 'var(--gq-violet)',
  muted: 'var(--gq-muted)',
  slate: 'var(--gq-slate)',
  brand: 'var(--gq-brand)',
} as const

/** 语义色名（与 ui-style.md 的 6 种圆点/胶囊一致）。 */
export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'violet' | 'muted' | 'slate'

/** 语义色名 → CSS 值。 */
export function toneColor(tone: Tone): string {
  return GQ[tone]
}

/** 间距令牌（4 的倍数）。 */
export const SP = {
  p1: '4px',
  p2: '8px',
  p3: '12px',
  p4: '16px',
  p5: '20px',
  p6: '24px',
  p7: '32px',
} as const

/** 圆角令牌。 */
export const RADIUS = {
  card: '10px',
  inner: '8px',
  btn: '6px',
  input: '6px',
  pill: '999px',
} as const

/** 字号令牌。 */
export const FS = {
  page: '20px',
  section: '15px',
  body: '13px',
  aux: '12px',
  micro: '11.5px',
  kpi: '27px',
} as const
