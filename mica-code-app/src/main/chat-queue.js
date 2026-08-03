export function createChatQueue(maxSize = Infinity) {
  const queues = new Map()

  return {
    enqueue(id, value) {
      const queue = queues.get(id) || []
      if (queue.length >= maxSize) return { ok: false, position: queue.length }
      queue.push(value)
      queues.set(id, queue)
      return { ok: true, position: queue.length }
    },

    take(id) {
      const queue = queues.get(id)
      if (!queue?.length) {
        queues.delete(id)
        return undefined
      }
      const value = queue.shift()
      if (!queue.length) queues.delete(id)
      return value
    },

    size(id) {
      return queues.get(id)?.length || 0
    },

    values(id) {
      return [...(queues.get(id) || [])]
    },

    remove(id, predicate) {
      const queue = queues.get(id)
      if (!queue?.length) return undefined
      const index = queue.findIndex(predicate)
      if (index < 0) return undefined
      const [value] = queue.splice(index, 1)
      if (!queue.length) queues.delete(id)
      return value
    },

    clear(id) {
      queues.delete(id)
    },

    clearAll() {
      queues.clear()
    }
  }
}
