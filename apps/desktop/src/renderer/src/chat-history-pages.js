/** Keep only range metadata in transcript handoffs, not a second copy of rows. */
export function historyPageState(page) {
  if (!page) return null
  const state = { ...page }
  delete state.rows
  return state
}

export function canPrependHistoryPage(current, older) {
  return Boolean(
    current?.nextBefore &&
    older &&
    !older.reset &&
    older.end === current.start &&
    older.start < current.start
  )
}

/** A reply from an old node/range/resync must never touch the live transcript. */
export function historyPageRequestStatus(request, current, older) {
  if (
    request.generation !== current.generation ||
    request.sessionId !== current.sessionId ||
    request.page !== current.page ||
    current.restoring ||
    !current.visible
  )
    return 'stale'
  if (request.mutation !== current.mutation || !canPrependHistoryPage(current.page, older))
    return 'resync'
  return 'prepend'
}

export function prependedScrollTop(anchor, scrollHeight) {
  return anchor.top + Math.max(0, scrollHeight - anchor.height)
}

/** Replacement may remove notices in the unloaded prefix and shift every later slot. */
export function noticeNeedsHistoryResync(page, event) {
  return Boolean(page?.start > 0 && event?.type === 'notice' && event.replace && event.command)
}
