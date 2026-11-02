import { constants, readFileSync } from 'node:fs'
import { setAssignment } from './session-projects'

/** Validate the on-disk session before changing either sidebar metadata file. */
export function createSessionMover({ sessionFile, readProjects, writeProjects, setPin }) {
  return ({ sessionId, section, groupId } = {}) => {
    const file = sessionFile(sessionId)
    if (!file) throw new Error('Invalid session id')

    // A new draft can receive a session id before its first snapshot is saved.
    // Keep its project assignment working; persisted children are checked below.
    let raw = {}
    try {
      // Do not follow a session filename that points outside the session directory.
      raw = JSON.parse(
        readFileSync(file, { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW })
      )
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot read session file')
    }
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      (raw.parentSessionId != null && typeof raw.parentSessionId !== 'string')
    ) {
      throw new Error('Invalid session file')
    }
    if (typeof raw.parentSessionId === 'string' && raw.parentSessionId.trim()) {
      throw new Error('Cannot move a child session')
    }

    const pinned = section === 'pinned'
    const target = section === 'project' ? groupId : null
    const projects = writeProjects(setAssignment(readProjects(), sessionId, target))
    return { pins: setPin(sessionId, pinned), projects }
  }
}
