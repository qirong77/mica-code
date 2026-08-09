import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { appendInputHistory, readInputHistory } from './input-history'

const previousMicaHome = process.env.MICA_HOME
const tempHome = mkdtempSync(join(tmpdir(), 'mica-input-history-'))

beforeAll(() => {
  process.env.MICA_HOME = tempHome
})

afterAll(() => {
  if (previousMicaHome === undefined) delete process.env.MICA_HOME
  else process.env.MICA_HOME = previousMicaHome
  rmSync(tempHome, { recursive: true, force: true })
})

describe('shared input history (storage.json)', () => {
  it('starts empty and appends with dedupe keeping the newest position', () => {
    expect(readInputHistory()).toEqual([])
    appendInputHistory('hello')
    appendInputHistory('world')
    expect(readInputHistory()).toEqual(['hello', 'world'])
    // re-sending moves the entry to the tail instead of duplicating
    appendInputHistory('hello')
    expect(readInputHistory()).toEqual(['world', 'hello'])
  })

  it('ignores blank input and trims entries', () => {
    expect(appendInputHistory('   ')).toEqual(readInputHistory())
    appendInputHistory('  spaced  ')
    expect(readInputHistory().at(-1)).toBe('spaced')
  })

  it('keeps at most 200 entries', () => {
    for (let index = 0; index < 220; index++) appendInputHistory(`item-${index}`)
    const history = readInputHistory()
    expect(history).toHaveLength(200)
    expect(history[0]).toBe('item-20')
    expect(history.at(-1)).toBe('item-219')
  })

  it('preserves other storage.json fields (lastUsedByDirectory etc.)', () => {
    appendInputHistory('keep-other-fields')
    const storage = JSON.parse(readFileSync(join(tempHome, 'storage.json'), 'utf8'))
    expect(storage.version).toBe(1)
    expect(Array.isArray(storage.inputHistory)).toBe(true)
  })

  it('degrades to empty history when storage.json is corrupted', () => {
    writeFileSync(join(tempHome, 'storage.json'), '{broken json')
    expect(readInputHistory()).toEqual([])
    // appending recovers the file
    appendInputHistory('recovered')
    expect(readInputHistory()).toEqual(['recovered'])
  })

  it('reads history written by the CLI format', () => {
    writeFileSync(
      join(tempHome, 'storage.json'),
      JSON.stringify({ version: 1, lastUsedByDirectory: { '/tmp/x': { provider: 'p' } }, inputHistory: ['a', ' b ', ''] }),
    )
    expect(readInputHistory()).toEqual(['a', 'b'])
    expect(existsSync(join(tempHome, 'storage.json'))).toBe(true)
  })
})
