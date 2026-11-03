import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { updateSessionCwdFile } from './session-cwd'

let directory

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mica-session-cwd-'))
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function writeSession(session) {
  writeFileSync(join(directory, `${session.id}.json`), JSON.stringify(session, null, 2), 'utf8')
}

describe('updateSessionCwdFile', () => {
  it('rewrites cwd, bumps the revision and keeps updatedAt / snapshot', () => {
    writeSession({
      version: 1,
      revision: 3,
      id: 'a1',
      title: 'keep',
      cwd: '/old/place',
      updatedAt: '2026-01-01T00:00:00.000Z',
      snapshot: { history: [] }
    })

    expect(updateSessionCwdFile(directory, 'a1', '  /new/place  ')).toEqual({
      cwd: '/new/place',
      changed: true
    })

    const stored = JSON.parse(readFileSync(join(directory, 'a1.json'), 'utf8'))
    expect(stored.cwd).toBe('/new/place')
    expect(stored.revision).toBe(4)
    // 「换项目目录」不是会话活动：动 updatedAt 会把它顶到 Recent 最前面。
    expect(stored.updatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(stored.title).toBe('keep')
    expect(stored.snapshot).toEqual({ history: [] })
  })

  it('reports no change when the directory is already the one on disk', () => {
    writeSession({ version: 1, revision: 1, id: 'b2', cwd: '/same/place' })
    expect(updateSessionCwdFile(directory, 'b2', '/same/place')).toEqual({
      cwd: '/same/place',
      changed: false
    })
    const stored = JSON.parse(readFileSync(join(directory, 'b2.json'), 'utf8'))
    expect(stored.revision).toBe(1)
  })

  it('rejects an empty cwd, a missing session and path-like ids', () => {
    writeSession({ version: 1, revision: 1, id: 'c3', cwd: '/x' })
    expect(() => updateSessionCwdFile(directory, 'c3', '  ')).toThrow('Invalid session cwd')
    expect(() => updateSessionCwdFile(directory, 'missing', '/x')).toThrow('Session not found')
    expect(() => updateSessionCwdFile(directory, '../escape', '/x')).toThrow('Invalid session cwd')
  })
})
