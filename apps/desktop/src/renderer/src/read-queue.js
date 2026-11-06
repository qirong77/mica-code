/**
 * Polls and push notifications can arrive before a previous read finishes. Share that read;
 * only invalidations request one follow-up, so slow polling never builds a request backlog.
 * `isCurrent` lets callers discard results after disposal or a newer local action.
 */
export function createReadQueue(read, { canRead = () => true, onError = () => {} } = {}) {
  let disposed = false
  let inFlight = null
  let queued = false
  let revision = 0

  const enabled = () => !disposed && canRead()
  const refresh = ({ trailing = false } = {}) => {
    if (!enabled()) return inFlight || Promise.resolve()
    if (inFlight) {
      queued ||= trailing
      return inFlight
    }
    inFlight = Promise.resolve()
      .then(async () => {
        do {
          queued = false
          if (!enabled()) break
          const startedRevision = revision
          try {
            await read(() => !disposed && startedRevision === revision)
          } catch (error) {
            if (!disposed && startedRevision === revision) onError(error)
          }
        } while (queued)
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  return {
    refresh,
    invalidate() {
      revision += 1
      queued = false
    },
    dispose() {
      disposed = true
      queued = false
    }
  }
}
