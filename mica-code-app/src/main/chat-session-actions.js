export function forkSessionSnapshot(session, id, now = new Date().toISOString()) {
  if (!session || typeof session !== 'object' || !session.snapshot) {
    throw new Error('Invalid session')
  }
  if (!id || typeof id !== 'string') throw new Error('Invalid fork session id')
  const title =
    typeof session.title === 'string' && session.title.trim() ? session.title.trim() : 'Chat'
  return {
    ...session,
    id,
    title: `${title} (fork)`,
    titleSource: 'manual',
    revision: 1,
    createdAt: now,
    updatedAt: now,
    turnState: 'completed',
    snapshot: structuredClone(session.snapshot)
  }
}
