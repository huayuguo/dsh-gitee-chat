/**
 * 可拖拽的栏宽 —— 项目列表 / 仓库列表用。
 *
 * 用户 2026-10-27 口径：「项目列表和仓库列表长度可以拉动么，可变长度。用户可以自行改变其长度」。
 *
 * ## 为什么用 localStorage 记住
 *
 * 栏宽是**偏好**，不是数据：刷新页面、切项目、重开面板都该保持用户上次的宽度。
 * 存储键带 `gq:colw:` 前缀，避免和其他插件的键撞。
 *
 * ## 为什么用 pointer 事件挂在 window
 *
 * 拖拽时鼠标很容易跑出那 6px 的把手（尤其是窄面板里），所以在 `pointerdown` 时
 * 只记起点，真正的 `pointermove` / `pointerup` 监听挂在 window 上 —— 出了把手也
 * 继续跟随，松手即结束。拖拽期间把 `body.cursor` 锁成 `col-resize`、禁用选中，
 * 否则会顺手选中一屏文字。
 */
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import css from './board.module.css'

/** 栏宽上下限（太窄放不下标题；上限给到 560，窄面板下仍受容器自身宽度约束）。 */
export const COL_MIN = 140
export const COL_MAX = 560

/**
 * 读/存一条栏宽。
 *
 * @param key     存储键（如 `project` / `repo`）。
 * @param fallback 没有存过 / 存的值不合法时的默认宽度。
 */
export function useColWidth(key: string, fallback: number): [number, (width: number) => void] {
  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(`gq:colw:${key}`)
      const parsed = raw === null ? Number.NaN : Number(raw)
      return Number.isFinite(parsed) && parsed >= COL_MIN && parsed <= COL_MAX ? parsed : fallback
    } catch {
      // 隐私模式下 localStorage 会抛 —— 用默认值即可。
      return fallback
    }
  })

  // 必须 memo：`ColResizer` 的 pointermove 挂在 window 上、依赖里有 onResize，
  // 每次渲染换一个新函数会让监听器反复解绑/重挂（拖拽时掉帧，甚至丢 pointerup）。
  const update = useCallback((next: number): void => {
    const clamped = Math.min(COL_MAX, Math.max(COL_MIN, Math.round(next)))
    setWidth(clamped)
    try {
      localStorage.setItem(`gq:colw:${key}`, String(clamped))
    } catch {
      // 存不住就算了，不影响本次会话。
    }
  }, [key])

  return [width, update]
}

/** 6px 的竖向拖拽把手；双击回到 220。 */
export function ColResizer(props: { width: number; onResize: (width: number) => void; label?: string }) {
  const { width, onResize, label = '拖动调整宽度（双击复位）' } = props
  const drag = useRef<{ x: number; width: number } | null>(null)

  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const start = drag.current
      if (start === null) return
      onResize(start.width + (event.clientX - start.x))
    }
    const onUp = (): void => {
      if (drag.current === null) return
      drag.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      onUp()
    }
  }, [onResize])

  return h('div', {
    className: css.gqVResizer,
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': label,
    title: label,
    onPointerDown: (event: { preventDefault: () => void; clientX: number }) => {
      event.preventDefault()
      drag.current = { x: event.clientX, width }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    onDoubleClick: () => onResize(220),
  })
}
