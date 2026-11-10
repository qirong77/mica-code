// 启动阶段均为相对 navigationStart 的毫秒数；不记录 URL、会话或用户数据。
export function createStartupTiming(win) {
  const enabled = new URLSearchParams(win.location.search).get('perf') !== '0'
  const timing = {}
  const now = () => Math.round(win.performance.now() * 10) / 10
  return {
    mark(name) {
      if (enabled) timing[name] = now()
    },
    setTime(name, value) {
      if (enabled && Number.isFinite(value)) timing[name] = Math.round(value * 10) / 10
    },
    setView(view) {
      if (enabled) timing.route = view
    },
    finish() {
      if (!enabled || timing.commit != null) return
      timing.commit = now()
      const navigation = win.performance.getEntriesByType?.('navigation')?.[0]
      if (navigation && Number.isFinite(navigation.responseEnd)) {
        timing.responseEnd = Math.round(navigation.responseEnd * 10) / 10
      }
      // 探针可能尚未加载，完成后保留到它的下一次采样。
      win.__micaStartupTiming = { ...timing }
    }
  }
}
