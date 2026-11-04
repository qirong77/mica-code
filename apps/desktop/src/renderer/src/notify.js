/**
 * 顶部通知队列：全局一份，任何地方 `notify()` 一次就在窗口顶部弹一条。
 *
 * 用 key 去重而不是每次新增：同一条持续更新的提示（例如「插件与工具有更新 · 3s 后重载」
 * 这种每秒刷新的倒计时）反复 push 只会原地改那一条，不会叠出一列。没有 key 的通知
 * 各自独立，按顺序排队，最多同时留 `MAX_ITEMS` 条。
 *
 * 队列本身不设定时器：自动消失由 `NotificationHost` 按 `timeout` 排，这样这个模块
 * 是纯数据、能在单测里直接断言。
 */

const MAX_ITEMS = 3
const AFTER_RELOAD_KEY = 'mica.notice.after-reload'

let items = []
const listeners = new Set()
let sequence = 0

/** 当前队列（只读，不要改）。 */
export function getNotifications() {
  return items
}

/** 订阅队列变化，返回取消订阅的函数。 */
export function subscribeNotifications(listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function publish(next) {
  items = next
  for (const listener of [...listeners]) listener(items)
}

/**
 * 弹一条通知，返回它的 id。带 `key` 时同 key 的那条会被原地更新（位置不变）。
 *
 * - `level`：`info` / `success` / `warning` / `error`，只影响圆点颜色。
 * - `text`：一行主文案；`detail`：次要说明（产物列表、错误详情）。
 * - `timeout`：毫秒，`0` 表示不自动消失（倒计时、需要用户点的那种）。
 * - `actions`：`[{ label, variant, onClick, disabled }]`，渲染在右侧。
 * - `sticky`：置顶（排在队列最前面），用于必须打断当前视线的那一条。
 */
export function notify(input = {}) {
  const item = {
    id: '',
    key: input.key || null,
    level: input.level || 'info',
    text: input.text || '',
    detail: input.detail || '',
    timeout: Number.isFinite(input.timeout) ? Math.max(0, input.timeout) : 0,
    actions: Array.isArray(input.actions) ? input.actions : [],
    sticky: !!input.sticky,
    createdAt: Date.now()
  }
  if (item.key) {
    const index = items.findIndex((current) => current.key === item.key)
    if (index >= 0) {
      const next = [...items]
      next[index] = { ...item, id: items[index].id, createdAt: items[index].createdAt }
      publish(next)
      return next[index].id
    }
  }
  sequence += 1
  item.id = `notice-${sequence}`
  const next = [...items, item]
  if (next.length > MAX_ITEMS) {
    // 先淘汰最旧的、不是置顶的那条：置顶的往往还没被读到。
    const victim = next.findIndex((current) => !current.sticky)
    next.splice(victim >= 0 ? victim : 0, 1)
  }
  if (item.sticky) {
    const index = next.indexOf(item)
    if (index > 0) {
      next.splice(index, 1)
      next.unshift(item)
    }
  }
  publish(next)
  return item.id
}

/** 关掉一条：给 id 或 key 都行。 */
export function dismissNotification(target) {
  if (!target) return
  const next = items.filter((item) => item.id !== target && item.key !== target)
  if (next.length !== items.length) publish(next)
}

/** 清空（测试与会话切换用）。 */
export function clearNotifications() {
  if (items.length > 0) publish([])
}

/**
 * 记一条「下一次页面加载后弹出来」的通知：界面重载会把 DOM 连同队列一起清掉，
 * 想让用户看到「界面已更新」就得先存到 sessionStorage 里。
 */
export function queueAfterReload(notice) {
  try {
    window.sessionStorage.setItem(AFTER_RELOAD_KEY, JSON.stringify(notice || {}))
  } catch {
    // 存不了就算了：少一条提示，不影响重载本身。
  }
}

/** 取走并清掉那条跨重载的通知（`NotificationHost` 挂载时调一次）。 */
export function takeAfterReload() {
  try {
    const raw = window.sessionStorage.getItem(AFTER_RELOAD_KEY)
    if (!raw) return null
    window.sessionStorage.removeItem(AFTER_RELOAD_KEY)
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
