/**
 * Pick the resident host that should serve a plugin panel request.
 *
 * A panel can be opened from a page whose node id is different from the node
 * that already owns the same session. Reuse only a live host for that exact
 * session; a draft (or a missing/dead host) must keep the requesting node id
 * so the caller can preserve its existing spawn behavior.
 */
export function resolvePanelRunId(runs, nodeId, sessionId) {
  const targetSessionId = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!targetSessionId || !runs?.[Symbol.iterator]) return nodeId

  for (const [id, run] of runs) {
    const runSessionId = run?.sessionId || run?.requestedSessionId || ''
    if (runSessionId !== targetSessionId) continue
    if (run?.child?.stdin?.writable === true) return id
  }

  return nodeId
}
