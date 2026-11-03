import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { setAssignment } from './session-projects'
import { HEAD_BYTES, readTopLevelString } from './session-file-head'

/** A session file grown past the head buffer is still a closed JSON object. */
function endsAsClosedObject(fd, size) {
  const tail = Buffer.alloc(1)
  readSync(fd, tail, 0, 1, size - 1)
  return '}\n\r\t '.includes(tail.toString('utf8'))
}

/**
 * The persisted `parentSessionId`, or null for a root session.
 *
 * Sessions reach 52MB, so only files that fit the head buffer are parsed whole.
 * Larger ones are read through their head (the writer keeps this field before
 * `snapshot`) plus a cheap corruption check instead of a full JSON.parse.
 */
function readParentSessionId(file) {
  let fd
  try {
    // Do not follow a session filename that points outside the session directory.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    // A new draft can receive a session id before its first snapshot is saved.
    if (error.code === 'ENOENT') return null
    throw new Error('Cannot read session file')
  }
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, HEAD_BYTES)
    const buffer = Buffer.alloc(length)
    const head = buffer.toString('utf8', 0, readSync(fd, buffer, 0, length, 0))
    if (length < size) {
      if (!endsAsClosedObject(fd, size)) throw new Error('Cannot read session file')
      return readTopLevelString(head, 'parentSessionId')
    }
    let raw
    try {
      raw = JSON.parse(head)
    } catch {
      throw new Error('Cannot read session file')
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid session file')
    if (raw.parentSessionId != null && typeof raw.parentSessionId !== 'string') {
      throw new Error('Invalid session file')
    }
    return typeof raw.parentSessionId === 'string' ? raw.parentSessionId.trim() || null : null
  } finally {
    closeSync(fd)
  }
}

/** Validate the on-disk session before changing either sidebar metadata file. */
export function createSessionMover({ sessionFile, readProjects, writeProjects, setPin }) {
  return ({ sessionId, section, groupId } = {}) => {
    const file = sessionFile(sessionId)
    if (!file) throw new Error('Invalid session id')

    // Keep a draft's project assignment working; persisted children are checked below.
    if (readParentSessionId(file)) throw new Error('Cannot move a child session')

    const pinned = section === 'pinned'
    const target = section === 'project' ? groupId : null
    const projects = writeProjects(setAssignment(readProjects(), sessionId, target))
    return { pins: setPin(sessionId, pinned), projects }
  }
}
