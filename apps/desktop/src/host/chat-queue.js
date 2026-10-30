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
 * TerminalInput): once one message is queued — at the host (after_iteration)
 * or in the local after_turn queue — any further queue request is rejected
 * with the CLI's exact notice text instead of stacking a second slot.
 *
 * 用户输入只有一种排队时机：Enter/Tab/Shift+Tab 都按 after_iteration 交给
 * host 的 turn/steer，在下一个工具调用迭代边界注入当前 turn（与 CLI 的
 * TerminalInput 一致）。显式 after_turn 才落到本地队列等 turn 结束，renderer
 * 不再走这条路径。
 */
export function resolveBusyDispatch({ running, queueMode, queuedCount }) {
  if (!running) return { action: 'start' }
  if (queuedCount > 0) {
    return { action: 'reject', message: '已有一条排队消息，等待发送或重新编辑' }
  }
  if (queueMode === 'after_turn') return { action: 'enqueue' }
  return { action: 'steer' }
}

/**
 * Dispatch for a message sent while the host occupies the session outside a turn
 * (`mica/host/maintenance`, i.e. idle history compaction). Compaction is
 * synchronous, so the host cannot even read the next `turn/start` while it runs:
 * such a message has to wait in the local queue — visibly and recallable — and is
 * replayed once the host reports idle. Single slot, like every other queue path.
 */
export function resolveMaintenanceDispatch({ compacting, queuedCount }) {
  if (!compacting) return { action: 'start' }
  if (queuedCount > 0) {
    return { action: 'reject', message: '已有一条排队消息，等待发送或重新编辑' }
  }
  return { action: 'enqueue' }
}

/**
 * Merge the host-side after_iteration slot (`mica/queue/*` notifications) with
 * the local after_turn queue into the single list the renderer renders. Host
 * items come first (they were accepted earlier). Both are real queue entries
 * and recallable (`mica/queue/recall` empties the host slot, the same recall
 * the CLI offers with shift + ←); only the renderer's optimistic in-flight row
 * is flagged `pending`.
 */
export function mergeQueuedItems(id, hostPending, localItems) {
  const host = (hostPending || []).map((item, index) => ({
    id: item.id || `host:${id}:${index}`,
    text: item.text || '',
    position: index + 1,
    queueMode: item.queueMode || 'after_iteration',
    // 宿主在轮次之外占着会话（自动压缩）时，排队行要说清「等的是压缩收尾」，
    // 而不是等一个根本不存在的迭代边界。
    ...(item.waitingFor ? { waitingFor: item.waitingFor } : {})
  }))
  return [...host, ...(localItems || [])]
}
