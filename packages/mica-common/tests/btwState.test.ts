import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { btwStatePath, deleteBtwState, readBtwState, writeBtwState } from '../btwState.js'

let home = ''
const originalHome = process.env.MICA_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mica-btw-state-'))
  // 路径一律经 resolveMicaHomePath 解析（跟随 MICA_HOME），测试只改环境变量，不改真实目录
  process.env.MICA_HOME = home
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.MICA_HOME
  else process.env.MICA_HOME = originalHome
})

describe('btwStatePath', () => {
  it('keys the file by session id under MICA_HOME/btw', () => {
    expect(btwStatePath('abc-123')).toBe(join(home, 'btw', 'abc-123.json'))
  })

  it('refuses ids that would escape the directory', () => {
    expect(btwStatePath('../etc/passwd')).toBeNull()
    expect(btwStatePath('')).toBeNull()
    expect(btwStatePath('a/b')).toBeNull()
  })
})

describe('read/write', () => {
  it('round-trips threads and drops malformed ones', () => {
    writeBtwState('s1', [
      { id: 't1', entries: [{ id: 'e1', question: '问', answer: '答', status: 'completed' }], messages: [] },
      { id: '', entries: [] },
      { nope: true }
    ] as never)
    const stored = readBtwState('s1')
    expect(stored).toHaveLength(1)
    expect(stored[0].id).toBe('t1')
    expect((stored[0].entries[0] as { answer?: string }).answer).toBe('答')
  })

  it('writes a versioned document', () => {
    writeBtwState('s2', [{ id: 't1', entries: [], messages: [] }])
    const raw = JSON.parse(readFileSync(join(home, 'btw', 's2.json'), 'utf8'))
    expect(raw.version).toBe(1)
  })

  it('returns an empty list for a missing or corrupt file', () => {
    expect(readBtwState('missing')).toEqual([])
    mkdirSync(join(home, 'btw'), { recursive: true })
    writeFileSync(join(home, 'btw', 'bad.json'), 'not json')
    expect(readBtwState('bad')).toEqual([])
  })
})

describe('deleteBtwState', () => {
  it('removes the file so a deleted session leaves no btw data', () => {
    writeBtwState('s3', [{ id: 't1', entries: [], messages: [] }])
    expect(existsSync(join(home, 'btw', 's3.json'))).toBe(true)
    deleteBtwState('s3')
    expect(existsSync(join(home, 'btw', 's3.json'))).toBe(false)
    expect(readBtwState('s3')).toEqual([])
  })

  it('tolerates a missing file', () => {
    expect(() => deleteBtwState('nope')).not.toThrow()
  })
})
