import { KEYBOARD_MIN_INSET, viewportMetrics } from './viewport-metrics'

// Safari 的键盘动画可能晚于 focus/resize，期间的数值变化也不一定再发事件。
const SETTLE_DURATION = 1000
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number'])

function isEditing(element) {
  if (!element || element.readOnly || element.disabled) return false
  return (
    element.isContentEditable ||
    element.tagName === 'TEXTAREA' ||
    (element.tagName === 'INPUT' && TEXT_INPUT_TYPES.has(element.type || 'text'))
  )
}

/** 同步根容器的可见区域；返回 disposer，供 React effect 与事件时序测试共用。 */
export function syncVisualViewport(win, doc) {
  const viewport = win?.visualViewport
  const root = doc?.documentElement
  if (!viewport || !root) return undefined

  let appliedHeight = null
  let appliedTop = null
  let unfocusedHeight = 0
  let frame = null
  let settleUntil = 0
  let correctedScroll = false
  let restoreUntil = 0

  const update = () => {
    const metrics = viewportMetrics(viewport, {
      innerHeight: win.innerHeight,
      clientHeight: root.clientHeight,
      unfocusedHeight
    })
    if (!metrics) return
    const editing = isEditing(doc.activeElement)
    if (!editing && !(viewport.offsetTop > 0) && win.performance.now() >= restoreUntil) {
      unfocusedHeight = metrics.height
    }
    const fullHeight = Math.max(unfocusedHeight, win.innerHeight, root.clientHeight)

    // overflow:hidden 仍挡不住 iOS 聚焦输入框时滚动 document。应用自己已有高度避让，
    // 再保留这次页面滚动会把整个 shell 推走（甚至只剩底栏）。只复位页面，不动聊天滚动区；
    // 用户双指缩放后的平移则必须保留。高度还没算进键盘时，也保留浏览器原生的避让。
    if (
      win.matchMedia('(max-width: 767px)').matches &&
      Math.abs((viewport.scale || 1) - 1) < 0.02 &&
      ((editing && fullHeight - metrics.height >= KEYBOARD_MIN_INSET) ||
        (!editing && win.performance.now() < restoreUntil)) &&
      (win.scrollX !== 0 || win.scrollY !== 0)
    ) {
      win.scrollTo({ left: 0, top: 0, behavior: 'instant' })
      correctedScroll = true
    }

    if (metrics.height !== appliedHeight) {
      appliedHeight = metrics.height
      root.style.setProperty('--vvh', `${metrics.height}px`)
    }
    if (metrics.top !== appliedTop) {
      appliedTop = metrics.top
      if (metrics.top > 0) root.style.setProperty('--vvh-top', `${metrics.top}px`)
      else root.style.removeProperty('--vvh-top')
    }
  }

  const tick = () => {
    frame = null
    update()
    if (win.performance.now() < settleUntil) frame = win.requestAnimationFrame(tick)
  }
  const refresh = (event) => {
    if (event?.type === 'focusout' && correctedScroll) {
      restoreUntil = win.performance.now() + SETTLE_DURATION
      correctedScroll = false
    }
    update()
    settleUntil = win.performance.now() + SETTLE_DURATION
    if (frame === null) frame = win.requestAnimationFrame(tick)
  }
  const onPointer = (event) => {
    if (!win.matchMedia('(max-width: 767px)').matches) return
    // iOS 可以让输入框先获得焦点而不弹键盘（例如加载会话后的自动聚焦、点键盘的完成）。
    // 再点同一个输入框不会有 focusin，视口事件也可能晚到；从触摸本身启动复查。
    // pointerup 再续一次，覆盖长按结束后才弹出键盘的情况。
    if (isEditing(event.target) || isEditing(doc.activeElement)) refresh()
  }

  update()
  viewport.addEventListener('resize', refresh)
  viewport.addEventListener('scroll', refresh)
  win.addEventListener('resize', refresh)
  win.addEventListener('scroll', refresh)
  win.addEventListener('orientationchange', refresh)
  doc.addEventListener('focusin', refresh)
  doc.addEventListener('focusout', refresh)
  doc.addEventListener('pointerdown', onPointer, true)
  doc.addEventListener('pointerup', onPointer, true)

  return () => {
    if (frame !== null) win.cancelAnimationFrame(frame)
    viewport.removeEventListener('resize', refresh)
    viewport.removeEventListener('scroll', refresh)
    win.removeEventListener('resize', refresh)
    win.removeEventListener('scroll', refresh)
    win.removeEventListener('orientationchange', refresh)
    doc.removeEventListener('focusin', refresh)
    doc.removeEventListener('focusout', refresh)
    doc.removeEventListener('pointerdown', onPointer, true)
    doc.removeEventListener('pointerup', onPointer, true)
    root.style.removeProperty('--vvh')
    root.style.removeProperty('--vvh-top')
  }
}
