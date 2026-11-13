// The snapshot sequence is sampled atomically with the tail by the host. Events
// received while it is in flight can therefore be replayed without duplicates.
export function createTerminalResync({ snapshot, reset, data, exit, isCurrent }) {
  let pending = null
  let again = false
  let buffered = null
  let lastSeq = 0

  function apply(event) {
    if (Number.isSafeInteger(event.seq)) {
      if (event.seq <= lastSeq) return
      lastSeq = event.seq
    }
    if (event.type === 'data') data(event)
    else exit(event)
  }

  function receive(event) {
    if (buffered) buffered.push(event)
    else apply(event)
  }

  async function run() {
    do {
      again = false
      buffered = []
      try {
        const state = await snapshot()
        if (!isCurrent()) return
        if (!state || !Number.isSafeInteger(state.seq)) throw new Error('Invalid terminal snapshot')
        lastSeq = state.seq
        if (state.exists) await reset(state.replay || '')
        else exit({ type: 'exit', missing: true })
      } finally {
        const events = buffered
        buffered = null
        if (isCurrent()) for (const event of events) apply(event)
      }
    } while (again && isCurrent())
  }

  function resync() {
    if (pending) {
      again = true
      return pending
    }
    pending = run().finally(() => { pending = null })
    return pending
  }

  return { receive, resync }
}
