import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionMover } from './session-move'

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'mica-session-move-'))
  const directory = join(root, 'sessions')
  mkdirSync(directory)
  let projects = { version: 1, groups: [{ id: 'group', name: 'Group' }], assignments: {} }
  let pins = {}
  let writes = 0
  const move = createSessionMover({
    sessionFile: (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id) ? join(directory, `${id}.json`) : null,
    readProjects: () => projects,
    writeProjects: (next) => { writes++; projects = next; return next },
    setPin: (id, pinned) => { writes++; pins = pinned ? { [id]: 1 } : {}; return pins }
  })
  return { root, directory, move, writes: () => writes }
}

describe('session moves', () => {
  it('moves root sessions between projects, pinned and recent', () => {
    const h = harness()
    try {
      writeFileSync(join(h.directory, 'root.json'), '{}')
      expect(h.move({ sessionId: 'root', section: 'project', groupId: 'group' }).projects.assignments.root).toBe('group')
      const pinned = h.move({ sessionId: 'root', section: 'pinned' })
      expect(pinned.projects.assignments.root).toBeUndefined()
      expect(pinned.pins.root).toBe(1)
      expect(h.move({ sessionId: 'root', section: 'recent' }).pins.root).toBeUndefined()
    } finally { rmSync(h.root, { recursive: true, force: true }) }
  })

  it('rejects children in every section without changing metadata', () => {
    const h = harness()
    try {
      writeFileSync(join(h.directory, 'child.json'), JSON.stringify({ parentSessionId: ' parent ' }))
      for (const section of ['project', 'pinned', 'recent']) {
        expect(() => h.move({ sessionId: 'child', section, groupId: 'group' })).toThrow('Cannot move a child session')
      }
      expect(h.writes()).toBe(0)
    } finally { rmSync(h.root, { recursive: true, force: true }) }
  })

  it('assigns a new session before its first snapshot is written', () => {
    const h = harness()
    try {
      expect(h.move({ sessionId: 'new-session', section: 'project', groupId: 'group' }).projects.assignments['new-session']).toBe('group')
    } finally { rmSync(h.root, { recursive: true, force: true }) }
  })

  it('rejects malformed and unsafe files before any writes', () => {
    const h = harness()
    try {
      writeFileSync(join(h.directory, 'bad.json'), '{')
      writeFileSync(join(h.directory, 'invalid.json'), JSON.stringify({ parentSessionId: {} }))
      writeFileSync(join(h.root, 'outside.json'), '{}')
      symlinkSync(join(h.root, 'outside.json'), join(h.directory, 'link.json'))
      expect(() => h.move({ sessionId: '../outside' })).toThrow('Invalid session id')
      expect(() => h.move({ sessionId: 'bad' })).toThrow('Cannot read session file')
      expect(() => h.move({ sessionId: 'invalid' })).toThrow('Invalid session file')
      expect(() => h.move({ sessionId: 'link' })).toThrow('Cannot read session file')
      expect(h.writes()).toBe(0)
    } finally { rmSync(h.root, { recursive: true, force: true }) }
  })
})
