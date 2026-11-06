/** 已结束轮次只是断线重放缓存，完整对话已经落盘。条数和文本体积都要有界。 */
export function createCompletedRunCache({ maxRuns = 40, maxChars = 16 * 1024 * 1024 } = {}) {
  const values = new Map()
  const weights = new Map()
  let chars = 0
  const remove = (key) => {
    if (!values.has(key)) return false
    chars -= weights.get(key) || 0
    weights.delete(key)
    return values.delete(key)
  }
  return {
    get: (key) => values.get(key),
    delete: remove,
    clear() {
      values.clear()
      weights.clear()
      chars = 0
    },
    set(key, value) {
      remove(key)
      const weight = textSize(value)
      // 单份超预算时不留副本；读取历史仍走会话文件，不截断用户内容。
      if (weight > maxChars) return
      while (values.size && (values.size >= maxRuns || chars + weight > maxChars)) {
        remove(values.keys().next().value)
      }
      values.set(key, value)
      weights.set(key, weight)
      chars += weight
    }
  }
}

function textSize(value) {
  const pending = [value]
  const seen = new Set()
  let chars = 0
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string') chars += item.length
    else if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item)
      for (const [key, field] of Object.entries(item)) {
        chars += key.length
        pending.push(field)
      }
    }
  }
  return chars
}
