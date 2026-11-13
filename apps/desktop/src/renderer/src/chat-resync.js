// Coalesce requests while a restore is in flight, but always run once more after
// it finishes: a transport gap can occur after the snapshot was requested.
export function createChatResyncQueue(run, onError = () => {}, {
  retryDelays = [1000, 3000, 10000],
  schedule = setTimeout,
  cancel = clearTimeout
} = {}) {
  let running = false
  let pending = false
  let disposed = false
  let retryTimer = null
  let failures = 0

  async function drain() {
    running = true
    while (pending && !disposed) {
      pending = false
      try {
        await run()
        failures = 0
      } catch (error) {
        if (disposed) break
        onError(error)
        if (disposed) break
        if (failures < retryDelays.length || (pending && retryDelays.length)) {
          pending = true
          const delay = retryDelays[Math.min(failures, retryDelays.length - 1)]
          failures = failures < retryDelays.length ? failures + 1 : 0
          retryTimer = schedule(() => {
            retryTimer = null
            if (!disposed && pending && !running) void drain()
          }, delay)
        } else {
          pending = false
          failures = 0
        }
        break
      }
    }
    running = false
  }

  return {
    request() {
      if (disposed) return
      pending = true
      if (!running && retryTimer === null) void drain()
    },
    dispose() {
      disposed = true
      pending = false
      if (retryTimer !== null) cancel(retryTimer)
      retryTimer = null
    }
  }
}
