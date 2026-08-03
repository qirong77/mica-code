import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStatsScanner } from './stats-scanner'

const temporaryDirectories = []

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(id, overrides = {}) {
  return {
    id,
    title: `Session ${id}`,
    cwd: `/work/${id}`,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    turnState: 'completed',
    value: 1,
    ...overrides
  }
}

function createHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'mica-stats-scanner-'))
  temporaryDirectories.push(dir)
  const reads = []
  const parses = []
  const fileSystem = {
    readdirSync,
    statSync,
    readFileSync(file, encoding) {
      reads.push(file)
      return readFileSync(file, encoding)
    }
  }
  const scanner = createStatsScanner({
    directory: () => dir,
    fileSystem,
    parseStats(raw) {
      parses.push(raw.id)
      return raw.statsValid === false ? null : { id: raw.id, value: raw.value }
    },
    dedupeStats: (rows) => rows
  })
  return {
    dir,
    reads,
    parses,
    scanner,
    write(name, value) {
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(value), 'utf8')
    }
  }
}

describe('incremental session scanner', () => {
  test('cold scan reads every JSON file and preserves metadata semantics', () => {
    const harness = createHarness()
    harness.write(
      'older',
      fixture('older', {
        title: '  Older title  ',
        cwd: '  /older  ',
        createdAt: 'invalid',
        updatedAt: '2025-01-02T00:00:00.000Z',
        turnState: ''
      })
    )
    harness.write(
      'newer',
      fixture('newer', { updatedAt: '2025-01-03T00:00:00.000Z', statsValid: false })
    )
    harness.write('ignored', fixture('ignored', { updatedAt: 'invalid' }))
    writeFileSync(join(harness.dir, 'notes.txt'), '{}', 'utf8')

    expect(harness.scanner.scanMeta()).toEqual([
      {
        id: 'newer',
        title: 'Session newer',
        cwd: '/work/newer',
        updatedAtMs: Date.parse('2025-01-03T00:00:00.000Z'),
        createdAtMs: Date.parse('2025-01-01T00:00:00.000Z'),
        turnState: 'completed'
      },
      {
        id: 'older',
        title: 'Older title',
        cwd: '/older',
        updatedAtMs: Date.parse('2025-01-02T00:00:00.000Z'),
        createdAtMs: 0,
        turnState: 'completed'
      }
    ])
    expect(harness.reads).toHaveLength(3)
    expect(harness.parses).toHaveLength(0)
    const stats = harness.scanner.scanStats()
    expect(stats).toHaveLength(2)
    expect(stats).toContainEqual({ id: 'older', value: 1 })
    expect(stats).toContainEqual({ id: 'ignored', value: 1 })
    expect(harness.reads).toHaveLength(6)
    expect(harness.parses).toHaveLength(3)
  })

  test('warm scans reuse all parsed entries', () => {
    const harness = createHarness()
    harness.write('one', fixture('one'))
    harness.write('two', fixture('two'))

    harness.scanner.scanStats()
    harness.scanner.scanStats()
    harness.scanner.scanMeta()

    expect(harness.reads).toHaveLength(4)
    expect(harness.parses).toHaveLength(2)
  })

  test('changing one file only rereads that file', () => {
    const harness = createHarness()
    harness.write('one', fixture('one'))
    harness.write('two', fixture('two'))
    harness.scanner.scanStats()

    harness.write('two', fixture('two', { value: 22222 }))

    expect(harness.scanner.scanStats()).toContainEqual({ id: 'two', value: 22222 })
    expect(harness.reads).toHaveLength(3)
    expect(harness.reads.at(-1)).toBe(join(harness.dir, 'two.json'))
  })

  test('adding a file only reads the new file', () => {
    const harness = createHarness()
    harness.write('one', fixture('one'))
    harness.scanner.scanStats()

    harness.write('two', fixture('two'))

    expect(harness.scanner.scanStats()).toEqual([
      { id: 'one', value: 1 },
      { id: 'two', value: 1 }
    ])
    expect(harness.reads).toHaveLength(2)
    expect(harness.reads.at(-1)).toBe(join(harness.dir, 'two.json'))
  })

  test('deleting a file removes its cached row without reading another file', () => {
    const harness = createHarness()
    harness.write('one', fixture('one'))
    harness.write('two', fixture('two'))
    harness.scanner.scanStats()

    unlinkSync(join(harness.dir, 'one.json'))

    expect(harness.scanner.scanStats()).toEqual([{ id: 'two', value: 1 }])
    expect(harness.reads).toHaveLength(2)
  })

  test('caches a damaged file as null and reads it again after repair', () => {
    const harness = createHarness()
    writeFileSync(join(harness.dir, 'broken.json'), '{broken', 'utf8')

    expect(harness.scanner.scanStats()).toEqual([])
    expect(harness.scanner.scanMeta()).toEqual([])
    expect(harness.reads).toHaveLength(2)

    harness.write('broken', fixture('repaired', { value: 123456 }))

    expect(harness.scanner.scanStats()).toEqual([{ id: 'repaired', value: 123456 }])
    expect(harness.reads).toHaveLength(3)
  })

  test('loads metadata and full statistics lazily, then caches both projections', () => {
    const harness = createHarness()
    harness.write('one', fixture('one'))

    expect(harness.scanner.scanMeta()).toHaveLength(1)
    expect(harness.reads).toHaveLength(1)
    expect(harness.parses).toEqual([])
    expect(harness.scanner.scanStats()).toEqual([{ id: 'one', value: 1 }])
    expect(harness.scanner.scanMeta()).toHaveLength(1)
    expect(harness.scanner.scanStats()).toEqual([{ id: 'one', value: 1 }])

    expect(harness.reads).toHaveLength(2)
    expect(harness.parses).toEqual(['one'])
  })

  test('all signature fields participate in cache invalidation', () => {
    let reads = 0
    const signature = {
      dev: 1n,
      ino: 2n,
      size: 3n,
      mtimeNs: 4n,
      ctimeNs: 5n
    }
    const scanner = createStatsScanner({
      directory: () => '/sessions',
      fileSystem: {
        readdirSync: () => ['one.json'],
        statSync: () => ({ ...signature }),
        readFileSync: () => {
          reads += 1
          return JSON.stringify(fixture('one'))
        }
      },
      parseStats: (raw) => ({ id: raw.id }),
      dedupeStats: (rows) => rows
    })

    scanner.scanStats()
    for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
      signature[field] += 1n
      scanner.scanStats()
    }

    expect(reads).toBe(6)
  })

  test('does not cache a parse when the signature changes during its read', () => {
    let reads = 0
    let stats = 0
    const scanner = createStatsScanner({
      directory: () => '/sessions',
      fileSystem: {
        readdirSync: () => ['one.json'],
        statSync: () => {
          stats += 1
          const version = stats === 1 ? 1n : 2n
          return { dev: 1n, ino: 1n, size: 1n, mtimeNs: version, ctimeNs: version }
        },
        readFileSync: () => {
          reads += 1
          return JSON.stringify(fixture('one'))
        }
      },
      parseStats: (raw) => ({ id: raw.id }),
      dedupeStats: (rows) => rows
    })

    expect(scanner.scanStats()).toEqual([])
    expect(scanner.scanStats()).toEqual([{ id: 'one' }])
    expect(scanner.scanStats()).toEqual([{ id: 'one' }])

    expect(reads).toBe(2)
  })

  test('keeps the last stable rows on transient directory errors and clears them on ENOENT', () => {
    const harness = createHarness()
    harness.write('one', fixture('one'))
    let transientFailure = false
    const scanner = createStatsScanner({
      directory: () => harness.dir,
      fileSystem: {
        readdirSync(directory) {
          if (transientFailure) throw Object.assign(new Error('too many files'), { code: 'EMFILE' })
          return readdirSync(directory)
        },
        statSync,
        readFileSync
      },
      parseStats: (raw) => ({ id: raw.id }),
      dedupeStats: (rows) => rows
    })

    const stable = scanner.scanMeta()
    transientFailure = true
    expect(scanner.scanMeta()).toEqual(stable)

    transientFailure = false
    rmSync(harness.dir, { recursive: true, force: true })
    expect(scanner.scanMeta()).toEqual([])
  })

  test('does not recompute global statistics while file signatures stay unchanged', () => {
    const harness = createHarness()
    harness.write('one', fixture('one'))
    let dedupes = 0
    const scanner = createStatsScanner({
      directory: () => harness.dir,
      fileSystem: { readdirSync, statSync, readFileSync },
      parseStats: (raw) => ({ id: raw.id }),
      dedupeStats(rows) {
        dedupes += 1
        return rows
      }
    })

    scanner.scanStats()
    scanner.scanStats()

    expect(dedupes).toBe(1)
  })
})
