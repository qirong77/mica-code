import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'node:child_process'
import { updateSessionCwdFile } from './session-cwd'
import { createTurnLeaseRunner } from './session-lease'

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

  it('refuses a direct write while another process holds the turn lease', () => {
    writeSession({ id: 'd4', revision: 1, cwd: '/old' })
    const withTurnLease = createTurnLeaseRunner({ lockDir: () => join(directory, '.turn-locks') })
    withTurnLease('d4', () => {
      const script = `
        import { updateSessionCwdFile } from ${JSON.stringify(new URL('./session-cwd.js', import.meta.url).href)}
        try { updateSessionCwdFile(process.argv[1], 'd4', '/new'); process.exit(2) }
        catch (error) { if (error.code !== 'TURN_LEASE_BUSY') { console.error(error); process.exit(3) } }
      `
      const child = spawnSync(process.execPath, ['-e', script, directory], { encoding: 'utf8' })
      expect(child.stderr).toBe('')
      expect(child.status).toBe(0)
      expect(JSON.parse(readFileSync(join(directory, 'd4.json'), 'utf8')).cwd).toBe('/old')
    })
    expect(updateSessionCwdFile(directory, 'd4', '/new')).toEqual({ cwd: '/new', changed: true })
  })

  it('releases the lease even if the session cannot be read', () => {
    expect(() => updateSessionCwdFile(directory, 'e5', '/new')).toThrow('Session not found')
    writeSession({ id: 'e5', cwd: '/old' })
    expect(updateSessionCwdFile(directory, 'e5', '/new')).toEqual({ cwd: '/new', changed: true })
  })
})
