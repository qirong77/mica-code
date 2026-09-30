import { describe, expect, it } from 'bun:test'
import {
  POINTER_FOCUS_GRACE_MS,
  isInsidePopover,
  isPointerDrivenFocusChange,
  popoverTriggerSelector
} from './popover-dismiss'

/** 够用的假节点：只实现判定真正用到的 closest / contains，属性选择器按属性表匹配 */
function node({ attrs = {}, contains = [] } = {}) {
  return {
    closest: (selector) => {
      const match = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector)
      if (!match) return null
      const [, attr, value] = match
      if (!(attr in attrs)) return null
      if (value !== undefined && attrs[attr] !== value) return null
      return { selector }
    },
    contains: (target) => contains.includes(target)
  }
}

describe('popover trigger selector', () => {
  it('scopes to one popover when a name is given', () => {
    expect(popoverTriggerSelector('loop')).toBe('[data-popover-trigger="loop"]')
    expect(popoverTriggerSelector()).toBe('[data-popover-trigger]')
  })
})

describe('isInsidePopover', () => {
  const panel = { contains: (target) => target === 'inside' }

  it('treats missing targets as outside', () => {
    expect(isInsidePopover(null, { popover: panel })).toBe(false)
  })

  it('accepts the panel itself and its trigger button', () => {
    expect(isInsidePopover('inside', { popover: panel })).toBe(true)
    const trigger = node({ attrs: { 'data-popover-trigger': 'loop' } })
    expect(isInsidePopover(trigger, { popover: null, trigger: 'loop' })).toBe(true)
  })

  it('keeps another popover trigger as outside', () => {
    // 时钟面板开着时点齿轮：齿轮不是它的触发按钮，先关掉时钟再让齿轮打开自己的面板。
    const other = node({ attrs: { 'data-popover-trigger': 'auto-compact' } })
    expect(isInsidePopover(other, { popover: null, trigger: 'loop' })).toBe(false)
    // 不给名字时才按「任意触发按钮」放行（没接 ref 的调用方）
    expect(isInsidePopover(other, { popover: null })).toBe(true)
  })

  it('survives targets without closest', () => {
    expect(isInsidePopover({ nodeType: 3 }, { popover: panel, trigger: 'loop' })).toBe(false)
  })
})

describe('isPointerDrivenFocusChange', () => {
  it('treats a focus change right after a click as pointer driven', () => {
    expect(isPointerDrivenFocusChange({ now: 1000, pointerDownAt: 1000 })).toBe(true)
    expect(
      isPointerDrivenFocusChange({ now: 1000 + POINTER_FOCUS_GRACE_MS, pointerDownAt: 1000 })
    ).toBe(true)
  })

  it('keeps real focus changes (keyboard, programmatic) as their own signal', () => {
    expect(
      isPointerDrivenFocusChange({ now: 1000 + POINTER_FOCUS_GRACE_MS + 1, pointerDownAt: 1000 })
    ).toBe(false)
    expect(isPointerDrivenFocusChange({ now: 1000, pointerDownAt: 0 })).toBe(false)
    expect(isPointerDrivenFocusChange({ now: 999, pointerDownAt: 1000 })).toBe(false)
    expect(isPointerDrivenFocusChange({ now: Number.NaN, pointerDownAt: 1000 })).toBe(false)
  })
})
