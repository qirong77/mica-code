/** Progress updates retain their row (and collapse state); completed results remain history. */
export function upsertChatNotice(messages, notice, { replace = false } = {}) {
  if (Number.isInteger(notice.noticeIndex) && notice.noticeIndex >= 0) {
    const slot = messages.findIndex(
      (row) => row.kind === 'notice' && row.noticeIndex === notice.noticeIndex
    )
    if (slot >= 0) {
      return messages.map((row, i) => (i === slot ? { ...row, ...notice, id: row.id } : row))
    }
  }
  const command = notice.command
  if (!command) return [...messages, notice]
  const index = messages.findLastIndex(
    (row) =>
      row.kind === 'notice' &&
      row.command === command &&
      (!notice.status || row.status === 'running')
  )
  if (index >= 0)
    return messages.map((row, i) => (i === index ? { ...row, ...notice, id: row.id } : row))
  if (replace) {
    return [
      ...messages.filter((row) => !(row.kind === 'notice' && row.command === command)),
      notice
    ]
  }
  return [...messages, notice]
}

/** Replay rebuilds assistant output; restore its persisted notices afterwards, then apply live updates. */
export function restoreChatNotices(messages, restored, updates = []) {
  let next = messages
  for (const row of restored) {
    if (row.kind === 'notice') next = upsertChatNotice(next, row)
  }
  for (const event of updates) {
    if (event.type !== 'notice' || !Number.isInteger(event.noticeIndex)) continue
    next = upsertChatNotice(
      next,
      {
        id: `notice-${event.noticeIndex}`,
        kind: 'notice',
        role: 'notice',
        text: event.text,
        variant: event.variant,
        command: event.command,
        status: event.status,
        noticeIndex: event.noticeIndex
      },
      { replace: event.replace }
    )
  }
  return next
}
