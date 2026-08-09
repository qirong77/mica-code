/**
 * Sidebar activity is process-local. A persisted session snapshot may retain
 * turnState="running" after a crash, so it must never drive the live dot.
 */
export function liveSessionRowState({ notificationState }) {
  if (notificationState?.running) return 'running'
  if (notificationState?.unread) return 'unread'
  return null
}
