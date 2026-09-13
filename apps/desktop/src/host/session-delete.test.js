import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deleteSessionFiles,
  isValidSessionId,
  stripSessionFromSort,
  turnLockPath
} from './session-delete'

function makeDirs() {
  const root = mkdtempSync(join(tmpdir(), 'mica-desktop-delete-'))
  const directory = join(root, 'sessions')
  const lockDir = join(directory, '.turn-locks')
  mkdirSync(lockDir, { recursive: true })
  return { root, directory, lockDir }
}

describe('isValidSessionId', () => {
  it('accepts uuid-ish ids and rejects path escapes / blanks', () => {
    expect(isValidSessionId('0f8a-1b_2C')).toBe(true)
    expect(isValidSessionId('../secrets')).toBe(false)
    expect(isValidSessionId('a/b')).toBe(false)
    expect(isValidSessionId('')).toBe(false)
    expect(isValidSessionId(null)).toBe(false)
  })
})

describe('deleteSessionFiles', () => {
  it('removes the session file and its turn lock', () => {
    const { root, directory, lockDir } = makeDirs()
    try {
      const file = join(directory, 's1.json')
      writeFileSync(file, '{}', 'utf8')
      const lock = turnLockPath(lockDir, 's1')
      writeFileSync(lock, '{"pid":1}', 'utf8')

      expect(deleteSessionFiles({ directory, lockDir, sessionId: 's1' })).toBe(true)
      expect(existsSync(file)).toBe(false)
      expect(existsSync(lock)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('clears an orphan lock when the session file is already gone', () => {
    const { root, directory, lockDir } = makeDirs()
    try {
      const lock = turnLockPath(lockDir, 's2')
      writeFileSync(lock, '{"pid":1}', 'utf8')

      expect(deleteSessionFiles({ directory, lockDir, sessionId: 's2' })).toBe(false)
      expect(existsSync(lock)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves other sessions untouched and rejects bad ids', () => {
    const { root, directory, lockDir } = makeDirs()
    try {
      writeFileSync(join(directory, 'keep.json'), '{}', 'utf8')
      expect(() => deleteSessionFiles({ directory, lockDir, sessionId: '../keep' })).toThrow()
      expect(existsSync(join(directory, 'keep.json'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('stripSessionFromSort', () => {
  it('drops the id from every section and keeps the rest', () => {
    const next = stripSessionFromSort(
      { pinned: ['a', 'b'], sessions: ['a'], 'project:g1': ['a', 'c'] },
      'a'
    )
    expect(next).toEqual({ pinned: ['b'], sessions: [], 'project:g1': ['c'] })
  })

  it('tolerates missing or malformed sections', () => {
    expect(stripSessionFromSort(null, 'a')).toEqual({})
    expect(stripSessionFromSort({ pinned: null }, 'a')).toEqual({ pinned: [] })
  })
})
