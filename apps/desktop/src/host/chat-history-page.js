import { createHash } from 'node:crypto'
import { comparableText } from '@packages/mica-common/promptText.js'

export const HISTORY_PAGE_SIZE = 80

// Cursors describe a prefix, not the file's mtime: appending new replies must not
// invalidate an older page, while edits/compaction anywhere before it must.
function prefixAnchor(rows, index) {
  const hash = createHash('sha256')
  for (let i = 0; i <= index && i < rows.length; i += 1) {
    hash.update(JSON.stringify(rows[i]))
    hash.update('\n')
  }
  return hash.digest('hex')
}

function validCursor(rows, cursor) {
  return (
    Number.isInteger(cursor?.index) &&
    cursor.index >= 0 &&
    cursor.index < rows.length &&
    typeof cursor.anchor === 'string' &&
    prefixAnchor(rows, cursor.index) === cursor.anchor
  )
}

/** Wire pages. `from` refreshes the loaded range; `before` reads older rows.
 * Only explicit full-text search requests `all` older rows. */
export function historyPage(
  history,
  { before, from, all = false, limit = HISTORY_PAGE_SIZE, replayPrompt } = {}
) {
  const rows = Array.isArray(history) ? history : []
  const total = rows.length
  const cursor = before || from
  const reset = Boolean(cursor && !validCursor(rows, cursor))
  const end = before && !reset ? before.index : total
  const size = Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : HISTORY_PAGE_SIZE
  let start = from && !reset ? from.index : all && before && !reset ? 0 : Math.max(0, end - size)
  // Steered user messages may occur inside one turn. Its original prompt, not
  // the last injected user row, is the boundary used by event replay.
  if (!before && replayPrompt && start > 0) {
    const key = comparableText(replayPrompt)
    const promptIndex = rows.findLastIndex(
      (row) => row.role === 'user' && comparableText(row.text) === key
    )
    if (promptIndex >= 0) start = Math.min(start, promptIndex)
  }
  // Replay trims at the current user prompt. Never split that turn across pages;
  // compact boundary/checkpoint user rows also remain together this way.
  while (start > 0 && rows[start]?.role !== 'user') start -= 1
  if (
    start > 0 &&
    String(rows[start]?.text || '')
      .trimStart()
      .startsWith('[Mica compact checkpoint]') &&
    String(rows[start - 1]?.text || '')
      .trimStart()
      .startsWith('[Mica compact boundary]')
  )
    start -= 1
  const startCursor = total ? { index: start, anchor: prefixAnchor(rows, start) } : null
  let noticeOffset = 0
  for (let i = 0; i < start; i += 1) if (rows[i].role === 'notice') noticeOffset += 1
  return {
    rows: rows.slice(start, end),
    start,
    end,
    total,
    noticeOffset,
    startCursor,
    nextBefore: start > 0 ? startCursor : null,
    reset
  }
}
