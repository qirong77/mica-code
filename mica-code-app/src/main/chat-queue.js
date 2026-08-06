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

/**
 * Busy dispatch for a second message while a resident host is running.
 * Mirrors the CLI's single-slot queue semantics (MessageQueueService +
 * TerminalInput): once one message is queued — locally (plain Tab / Enter,
 * after_turn) or injected at the host (Shift+Tab, after_iteration) — any
 * further queue request is rejected with the CLI's exact notice text instead
 * of stacking a second slot.
 */
export function resolveBusyDispatch({ running, queueMode, queuedCount }) {
  if (!running) return { action: 'start' }
  if (queuedCount > 0) {
    return { action: 'reject', message: '已有一条排队消息，等待发送或重新编辑' }
  }
  if (queueMode === 'after_iteration') return { action: 'steer' }
  return { action: 'enqueue' }
}
