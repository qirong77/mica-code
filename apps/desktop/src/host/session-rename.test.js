import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { renameSessionFile } from './session-rename'

let directory

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mica-session-rename-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function writeSession(session) {
  writeFileSync(join(directory, `${session.id}.json`), JSON.stringify(session, null, 2), 'utf8')
}

describe('renameSessionFile', () => {
  it('marks the title as manual and bumps the revision', () => {
    writeSession({
      version: 1,
      revision: 4,
      id: 'a1',
      title: 'old title',
      titleSource: 'derived',
      updatedAt: '2026-01-01T00:00:00.000Z',
      snapshot: { history: [] }
    })

    expect(renameSessionFile(directory, 'a1', '  新标题  ')).toBe('新标题')

    const stored = JSON.parse(readFileSync(join(directory, 'a1.json'), 'utf8'))
    expect(stored.title).toBe('新标题')
    expect(stored.titleSource).toBe('manual')
    expect(stored.revision).toBe(5)
    expect(stored.snapshot).toEqual({ history: [] })
    expect(stored.id).toBe('a1')
  })

  it('rejects an empty title and a missing session', () => {
    writeSession({ version: 1, revision: 1, id: 'b2', title: 'keep' })
    expect(() => renameSessionFile(directory, 'b2', '   ')).toThrow('Invalid session title')
    expect(() => renameSessionFile(directory, 'missing', 'x')).toThrow('Session not found')
  })

  it('rejects session ids that are not plain file names', () => {
    expect(() => renameSessionFile(directory, '../escape', 'x')).toThrow('Invalid session title')
  })
})
