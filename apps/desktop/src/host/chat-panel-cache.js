/** 面板视图的短缓存。请求进行中始终合并，成功后的复用窗口从完成时开始。 */
export function createPanelViewCache({ reuseMs = 3000, maxEntries = 128, now = Date.now } = {}) {
  const entries = new Map()
  return {
    clear() {
      entries.clear()
    },
    read(key, load) {
      const at = now()
      for (const [entryKey, entry] of entries) {
        if (!entry.pending && at - entry.at >= reuseMs) entries.delete(entryKey)
      }
      const cached = entries.get(key)
      if (cached) return cached.promise
      if (entries.size >= maxEntries) {
        // 优先回收已完成的视图；全是在途请求时不再向忙碌宿主堆请求。
        const settled = [...entries].find(([, entry]) => !entry.pending)
        if (settled) entries.delete(settled[0])
        else return Promise.resolve({ ok: false, error: '插件面板请求繁忙，请稍后重试' })
      }
      const entry = { at, pending: true, promise: null }
      // 先登记再启动，处理同步失败与同步返回值，也避免同一 key 重入时重复执行。
      entry.promise = Promise.resolve()
        .then(load)
        .then(
          (result) => {
            if (entries.get(key) === entry) {
              if (result?.ok === false) entries.delete(key)
              else {
                entry.pending = false
                entry.at = now()
              }
            }
            return result
          },
          (error) => {
            if (entries.get(key) === entry) entries.delete(key)
            throw error
          }
        )
      entries.set(key, entry)
      return entry.promise
    }
  }
}
