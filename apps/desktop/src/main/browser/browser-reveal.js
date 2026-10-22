import { windowRestoreAction, windowRevealDimmed, windowRevealPlan } from './browser-core.js'

/**
 * 受控浏览器窗口的「临时露出」控制器。
 *
 * 隐藏窗口没有显示面：合成器不产帧（截图拿到旧帧，整页截图甚至一直不返回），原生输入事件
 * 也会被丢掉。所以依赖显示面的操作要先 `showInactive` 把窗口显示出来。但每次操作都
 * show/hide 一次会让窗口不停闪，所以这里做两件事：
 *
 * 1. **显示但不透**：先 `setOpacity(0)` 再显示。对 Chromium 而言它仍是可见窗口（照常出帧、
 *    原生输入照常生效），对用户则完全看不见。透明窗口照样会吃掉范围内的鼠标事件，所以同时
 *    让点击穿透。
 * 2. **空闲再收**：操作结束不立刻收起，留一段空窗期给紧跟着的操作（点击 → 输入 → 截图）
 *    复用同一次露出；空闲期到了才真正 hide/最小化，并把透明度还原。
 *
 * 顺序都是成对的，反了会闪帧：压透明度 → 显示；收起 → 恢复透明度。
 */
export function createRevealController({
  idleMs = 1500,
  env = process.env,
  timers = { set: setTimeout, clear: clearTimeout }
} = {}) {
  /** win -> { plan, dimmed, depth, timer } */
  const sessions = new WeakMap()

  function safe(win, fn) {
    if (win.isDestroyed()) return
    try {
      fn()
    } catch {
      // 平台不支持（如 Linux 的 setOpacity）或窗口正在销毁：让操作继续，不要因为装饰失败中断
    }
  }

  function begin(win) {
    if (!win || win.isDestroyed()) return null
    const existing = sessions.get(win)
    if (existing) {
      if (existing.timer !== null) {
        timers.clear(existing.timer)
        existing.timer = null
      }
      existing.depth += 1
      return existing.plan
    }
    const plan = windowRevealPlan({ visible: win.isVisible(), minimized: win.isMinimized() })
    if (!plan) return null
    const dimmed = windowRevealDimmed(plan, env)
    if (dimmed) {
      safe(win, () => win.setOpacity(0))
      safe(win, () => win.setIgnoreMouseEvents(true))
    }
    if (plan.minimized) safe(win, () => win.restore())
    else safe(win, () => win.showInactive())
    const session = { plan, dimmed, depth: 1, timer: null }
    sessions.set(win, session)
    return plan
  }

  function end(win) {
    const session = sessions.get(win)
    if (!session) return
    session.depth -= 1
    if (session.depth > 0) return
    if (session.timer !== null) timers.clear(session.timer)
    session.timer = timers.set(() => {
      session.timer = null
      flush(win)
    }, idleMs)
    session.timer?.unref?.()
  }

  /** 立刻收起（用户/agent 显式显隐窗口、销毁窗口时用） */
  function flush(win) {
    const session = sessions.get(win)
    if (!session) return
    sessions.delete(win)
    if (session.timer !== null) {
      timers.clear(session.timer)
      session.timer = null
    }
    if (win.isDestroyed()) return
    const action = windowRestoreAction(session.plan)
    if (action === 'minimize') safe(win, () => win.minimize())
    else if (action === 'hide') safe(win, () => win.hide())
    if (session.dimmed) {
      safe(win, () => win.setIgnoreMouseEvents(false))
      safe(win, () => win.setOpacity(1))
    }
  }

  return {
    begin,
    end,
    flush,
    isRevealed: (win) => sessions.has(win)
  }
}
