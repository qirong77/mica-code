import { readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { isValidSessionId } from './session-delete'

/**
 * Direct read-modify-write of a session's `cwd` on disk.
 *
 * Only valid when **no process owns this session**: a live chat host rewrites the
 * file from its in-memory snapshot on every save and its snapshot writes
 * `process.cwd()` (the directory it was spawned in), so a direct write here is
 * silently reverted by the next turn. Both callers route the owned case through
 * the resident host (`mica/session/cwd`) and only fall back here when nothing is
 * writing the file.
 *
 * `updatedAt` is deliberately left alone: switching the project directory is a
 * metadata edit, not session activity, and bumping it would jump the session to
 * the top of Recent on every switch (same rule as `parentSessionId`).
 */
export function updateSessionCwdFile(directory, sessionId, cwd) {
  const nextCwd = typeof cwd === 'string' ? cwd.trim() : ''
  if (!directory || !isValidSessionId(sessionId) || !nextCwd) throw new Error('Invalid session cwd')
  const file = join(directory, `${sessionId}.json`)

  let session
  try {
    session = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new Error('Session not found')
  }
  if (!session || typeof session !== 'object' || session.id !== sessionId)
    throw new Error('Invalid session')
  if (session.cwd === nextCwd) return { cwd: nextCwd, changed: false }

  const updated = {
    ...session,
    cwd: nextCwd,
    revision: (Number.isInteger(session.revision) ? session.revision : 0) + 1
  }
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return { cwd: nextCwd, changed: true }
}
