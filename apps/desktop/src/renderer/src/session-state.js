/**
 * Sidebar activity is process-local. A persisted session snapshot may retain
 * turnState="running" after a crash, so it must never drive the live dot.
 */
export function liveSessionRowState({ notificationState }) {
  if (notificationState?.running) return 'running'
  if (notificationState?.unread) return 'unread'
  return null
}

/**
 * Inbox only lists finished work the user has not reviewed yet: a running turn
 * has no result to look at, so it stays out of the list (the session tree row
 * already shows its running dot).
 */
export function buildInboxItems({
  sessions = [],
  draftTabs = [],
  openBySession = {},
  unread = {}
}) {
  const items = []
  for (const session of sessions) {
    const nodeId = openBySession[session.id]
    const state = nodeId ? unread[nodeId] : null
    if (state?.unread) items.push({ key: nodeId, nodeId, session, state })
  }
  for (const draft of draftTabs) {
    const state = unread[draft.id]
    if (state?.unread) items.push({ key: draft.id, nodeId: draft.id, draft, state })
  }
  return items.sort((a, b) => (b.state.lastEventAt || 0) - (a.state.lastEventAt || 0))
}
