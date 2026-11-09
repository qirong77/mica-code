// Only actual view dispatches are measured (cache hits/coalesced callers are not).
// First output is an observable startup milestone, not a host-ready notification.
export function createPanelTiming({
  now = () => performance.now(),
  log,
  slowMs = 500,
  intervalMs = 10_000
}) {
  let lastLogAt = -Infinity
  let suppressed = 0
  return {
    start() {
      const started = now()
      return {
        dispatched(run, reused) {
          const sent = now()
          return (ok) => {
            const finished = now()
            if (finished - started < slowMs) return
            if (finished - lastLogAt < intervalMs) {
              suppressed = Math.min(suppressed + 1, 1_000_000)
              return
            }
            lastLogAt = finished
            const firstOutput = run?.firstHostOutputAt
            log({
              host: reused ? 'existing' : 'spawned',
              preparationMs: Math.round(sent - started),
              roundTripMs: Math.round(finished - sent),
              // null: no output observed; zero: output preceded dispatch.
              firstOutputWaitMs:
                firstOutput == null || firstOutput > finished
                  ? null
                  : Math.round(Math.max(0, firstOutput - sent)),
              ok: ok === true,
              suppressed
            })
            suppressed = 0
          }
        }
      }
    }
  }
}
