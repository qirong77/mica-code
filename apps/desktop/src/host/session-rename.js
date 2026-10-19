import { readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { isValidSessionId } from './session-delete'

/**
 * Direct read-modify-write of a session's title on disk.
 *
 * Only valid when **no process owns this session** — a live chat host (or a TUI
 * holding the turn lease) rewrites the file from its in-memory snapshot and
 * would drop the new title on its next save. Both callers route the running case
 * through the owner (`mica/session/rename` / `SessionController.renameCurrent`)
 * and only fall back here when nothing is writing the file.
 */
export function renameSessionFile(directory, sessionId, title) {
  const nextTitle = typeof title === 'string' ? title.trim() : ''
  if (!directory || !isValidSessionId(sessionId) || !nextTitle) throw new Error('Invalid session title')
  const file = join(directory, `${sessionId}.json`)

  let session
  try {
    session = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error('Session not found')
  }
  if (!session || typeof session !== 'object' || session.id !== sessionId)
    throw new Error('Invalid session')

  const updated = {
    ...session,
    title: nextTitle,
    titleSource: 'manual',
    revision: (Number.isInteger(session.revision) ? session.revision : 0) + 1,
    updatedAt: new Date().toISOString()
  }
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return updated.title
}
