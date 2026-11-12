/** Progress updates retain their row (and collapse state); completed results remain history. */
export function upsertChatNotice(messages, notice, { replace = false } = {}) {
  const command = notice.command
  // The host removes completed copies before appending a replacement. Their removal
  // shifts every following persisted index; the incoming slot may still belong to
  // a different notice in our old projection. Running rows keep their slot instead.
  if (
    replace &&
    command &&
    !messages.some(
      (row) => row.kind === 'notice' && row.command === command && row.status === 'running'
    )
  ) {
    const removed = messages.filter((row) => row.kind === 'notice' && row.command === command)
    const sameSlot =
      Number.isInteger(notice.noticeIndex) &&
      removed.find((row) => row.noticeIndex === notice.noticeIndex)
    // A replay of an already projected replacement must not move it past a live reply.
    if (sameSlot && removed.length === 1) {
      return messages.map((row) => (row === sameSlot ? { ...row, ...notice, id: row.id } : row))
    }
    const indices = removed.map((row) => row.noticeIndex).filter(Number.isInteger)
    const next = messages
      .filter((row) => !(row.kind === 'notice' && row.command === command))
      .map((row) => {
        if (row.kind !== 'notice' || !Number.isInteger(row.noticeIndex)) return row
        const shift = indices.filter((index) => index < row.noticeIndex).length
        return shift ? { ...row, noticeIndex: row.noticeIndex - shift } : row
      })
    return appendNotice(next, { ...notice, id: sameSlot?.id || notice.id })
  }
  if (Number.isInteger(notice.noticeIndex) && notice.noticeIndex >= 0) {
    const slot = messages.findIndex(
      (row) => row.kind === 'notice' && row.noticeIndex === notice.noticeIndex
    )
    if (slot >= 0) {
      return messages.map((row, i) => (i === slot ? { ...row, ...notice, id: row.id } : row))
    }
  }
  if (!command) return appendNotice(messages, notice)
  const index = messages.findLastIndex(
    (row) =>
      row.kind === 'notice' &&
      row.command === command &&
      (!notice.status || row.status === 'running')
  )
  if (index >= 0)
    return messages.map((row, i) => (i === index ? { ...row, ...notice, id: row.id } : row))
  return appendNotice(messages, notice)
}

function appendNotice(messages, notice) {
  // Persisted positions move after replacement; React row identity must not.
  if (notice.id && !messages.some((row) => row.id === notice.id)) return [...messages, notice]
  const ids = new Set(messages.map((row) => row.id))
  const base = notice.id || 'notice'
  let id = base
  for (let suffix = 1; ids.has(id); suffix += 1) id = `${base}-${suffix}`
  return [...messages, id === notice.id ? notice : { ...notice, id }]
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
        fullText: typeof event.fullText === 'string' ? event.fullText : undefined,
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
