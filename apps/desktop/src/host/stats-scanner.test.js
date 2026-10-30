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
    version: 1,
    id,
    title: `Session ${id}`,
    cwd: `/work/${id}`,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    turnState: 'completed',
    snapshot: {
      providerId: 'test',
      model: 'm1',
      effort: 'medium',
      messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      conversationMessages: [{ id: 'c1', role: 'user', text: 'hi' }],
      usageHistory: []
    },
    ...overrides,
    value: undefined
  }
}

function memoryIndexStore() {
  return {
    text: null,
    async read() {
      if (this.text == null) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return this.text
    },
    async write(text) {
      this.text = text
    }
  }
}

/** 等一轮宏任务，让索引的后台写入跑完（测试里 debounce 设为 0）。 */
function flushIndex() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function createHarness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mica-stats-scanner-'))
  temporaryDirectories.push(dir)
  const reads = []
  const store = options.store ?? memoryIndexStore()
  const fileSystem = {
    readdirSync: options.readdirSync ?? readdirSync,
    statSync,
    readFileSync(file, encoding) {
      reads.push(file)
      return readFileSync(file, encoding)
    }
  }
  const scanner = createStatsScanner({
    directory: () => dir,
    fileSystem,
    indexStore: store,
    indexWriteDelayMs: 0,
    ...options.scanner
  })
  return {
    dir,
    reads,
    store,
    scanner,
    files: {
      write(name, value) {
        writeFileSync(join(dir, `${name}.json`), JSON.stringify(value), 'utf8')
      },
      remove(name) {
        unlinkSync(join(dir, `${name}.json`))
      }
    }
  }
}

describe('incremental session scanner', () => {
  test('projects parentSessionId only for sessions that have one', async () => {
    const harness = createHarness()
    harness.files.write('child', fixture('child', { parentSessionId: '  parent-1  ' }))
    harness.files.write('root', fixture('root', { parentSessionId: '' }))

    const rows = await harness.scanner.scanMeta()
    expect(rows.find((row) => row.id === 'child').parentSessionId).toBe('parent-1')
    // 没有父会话时整个键都不出现：行对象的形状对「有没有派生关系」保持稳定。
    expect('parentSessionId' in rows.find((row) => row.id === 'root')).toBe(false)
  })

  test('cold scan reads every JSON file and preserves metadata semantics', async () => {
    const harness = createHarness()
    harness.files.write(
      'older',
      fixture('older', {
        title: '  Older title  ',
        cwd: '  /older  ',
        createdAt: 'invalid',
        updatedAt: '2025-01-02T00:00:00.000Z',
        turnState: ''
      })
    )
    harness.files.write('newer', fixture('newer', { updatedAt: '2025-01-03T00:00:00.000Z' }))
    harness.files.write('ignored', fixture('ignored', { updatedAt: 'invalid' }))
    writeFileSync(join(harness.dir, 'notes.txt'), '{}', 'utf8')

    expect(await harness.scanner.scanMeta()).toEqual([
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

    // 统计投影要求创建/更新时间都合法，所以 createdAt 无效的 older 与 updatedAt
    // 无效的 ignored 都不出现在这里。
    const stats = await harness.scanner.scanStats()
    expect(stats.map((row) => row.id)).toEqual(['newer'])
  })

  test('warm scans reuse all parsed entries and keep array identity', async () => {
    const harness = createHarness()
    harness.files.write('one', fixture('one'))
    harness.files.write('two', fixture('two'))

    const firstStats = await harness.scanner.scanStats()
    expect(await harness.scanner.scanStats()).toBe(firstStats)
    const firstMeta = await harness.scanner.scanMeta()
    expect(await harness.scanner.scanMeta()).toBe(firstMeta)

    expect(harness.reads).toHaveLength(2)
  })

  test('changing one file only rereads that file', async () => {
    const harness = createHarness()
    harness.files.write('one', fixture('one'))
    harness.files.write('two', fixture('two'))
    await harness.scanner.scanStats()

    harness.files.write(
      'two',
      fixture('two', {
        snapshot: {
          ...fixture('two').snapshot,
          usageHistory: [{ usageId: 'u-2', inputTokens: 7, outputTokens: 1 }]
        }
      })
    )

    const stats = await harness.scanner.scanStats()
    expect(stats.find((row) => row.id === 'two').requests).toBe(1)
    expect(harness.reads).toHaveLength(3)
    expect(harness.reads.at(-1)).toBe(join(harness.dir, 'two.json'))
  })

  test('rereads metadata when only the session title changes', async () => {
    const harness = createHarness()
    harness.files.write('one', fixture('one', { title: 'First prompt' }))

    expect(await harness.scanner.scanMeta()).toEqual([
      expect.objectContaining({ id: 'one', title: 'First prompt' })
    ])

    // The CLI rewrites title on every turn, so the sidebar must pick the new
    // value up from the next scan without any other field changing.
    harness.files.write('one', fixture('one', { title: 'A much later prompt' }))

    expect(await harness.scanner.scanMeta()).toEqual([
      expect.objectContaining({ id: 'one', title: 'A much later prompt' })
    ])
    expect(harness.reads).toHaveLength(2)
  })

  test('adding a file only reads the new file', async () => {
    const harness = createHarness()
    harness.files.write('one', fixture('one'))
    await harness.scanner.scanStats()

    harness.files.write('two', fixture('two'))

    expect((await harness.scanner.scanStats()).map((row) => row.id)).toEqual(['one', 'two'])
    expect(harness.reads).toHaveLength(2)
    expect(harness.reads.at(-1)).toBe(join(harness.dir, 'two.json'))
  })

  test('keeps a stable row order regardless of the directory listing order', async () => {
    const harness = createHarness({
      readdirSync: (dir) => [...readdirSync(dir)].reverse()
    })
    harness.files.write('one', fixture('one'))
    harness.files.write('two', fixture('two'))

    expect((await harness.scanner.scanStats()).map((row) => row.id)).toEqual(['one', 'two'])
  })

  test('deleting a file removes its cached row without reading another file', async () => {
    const harness = createHarness()
    harness.files.write('one', fixture('one'))
    harness.files.write('two', fixture('two'))
    await harness.scanner.scanStats()

    harness.files.remove('one')

    expect((await harness.scanner.scanStats()).map((row) => row.id)).toEqual(['two'])
    expect(harness.reads).toHaveLength(2)
  })

  test('caches a damaged file and reads it again after repair', async () => {
    const harness = createHarness()
    writeFileSync(join(harness.dir, 'broken.json'), '{broken', 'utf8')

    expect(await harness.scanner.scanStats()).toEqual([])
    expect(await harness.scanner.scanMeta()).toEqual([])
    expect(harness.reads).toHaveLength(1)

    harness.files.write('broken', fixture('repaired'))

    expect((await harness.scanner.scanStats()).map((row) => row.id)).toEqual(['repaired'])
    expect(harness.reads).toHaveLength(2)
  })

  test('does not cache a parse when the signature changes during its read', async () => {
    let reads = 0
    let stats = 0
    const scanner = createStatsScanner({
      directory: () => '/sessions',
      indexStore: null,
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
      }
    })

    expect(await scanner.scanStats()).toEqual([])
    expect((await scanner.scanStats()).map((row) => row.id)).toEqual(['one'])
    expect((await scanner.scanStats()).map((row) => row.id)).toEqual(['one'])

    expect(reads).toBe(2)
  })

  test('keeps the last stable rows on transient directory errors and clears them on ENOENT', async () => {
    const harness = createHarness()
    harness.files.write('one', fixture('one'))
    let transientFailure = false
    const scanner = createStatsScanner({
      directory: () => harness.dir,
      indexStore: null,
      fileSystem: {
        readdirSync(directory) {
          if (transientFailure) throw Object.assign(new Error('too many files'), { code: 'EMFILE' })
          return readdirSync(directory)
        },
        statSync,
        readFileSync
      }
    })

    const stable = await scanner.scanMeta()
    transientFailure = true
    expect(await scanner.scanMeta()).toBe(stable)

    transientFailure = false
    rmSync(harness.dir, { recursive: true, force: true })
    expect(await scanner.scanMeta()).toEqual([])
  })

  test('attributes a usage record copied by an old fork to the oldest session', async () => {
    const shared = { usageId: 'shared', inputTokens: 100, outputTokens: 10 }
    const harness = createHarness()
    harness.files.write(
      'source',
      fixture('source', {
        createdAt: '2025-01-01T00:00:00.000Z',
        snapshot: { ...fixture('source').snapshot, usageHistory: [shared] }
      })
    )
    harness.files.write(
      'fork',
      fixture('fork', {
        createdAt: '2025-02-01T00:00:00.000Z',
        snapshot: {
          ...fixture('fork').snapshot,
          usageHistory: [shared, { usageId: 'own', inputTokens: 20, outputTokens: 2 }]
        }
      })
    )

    const stats = await harness.scanner.scanStats()
    expect(stats.map((row) => [row.id, row.requests, row.totalTokens])).toEqual([
      ['source', 1, 110],
      ['fork', 1, 22]
    ])
    expect((await harness.scanner.ownedIdentities('source')).has('id:shared')).toBe(true)
    expect((await harness.scanner.ownedIdentities('fork')).has('id:shared')).toBe(false)
    expect(await harness.scanner.ownedIdentities('missing')).toBeNull()
  })

  test('gives a copied record back when the session that owned it is deleted', async () => {
    const shared = { usageId: 'shared', inputTokens: 100, outputTokens: 10 }
    const harness = createHarness()
    harness.files.write(
      'source',
      fixture('source', {
        createdAt: '2025-01-01T00:00:00.000Z',
        snapshot: { ...fixture('source').snapshot, usageHistory: [shared] }
      })
    )
    harness.files.write(
      'fork',
      fixture('fork', {
        createdAt: '2025-02-01T00:00:00.000Z',
        snapshot: { ...fixture('fork').snapshot, usageHistory: [shared] }
      })
    )
    expect((await harness.scanner.scanStats()).map((row) => row.totalTokens)).toEqual([110, 0])

    harness.files.remove('source')
    const stats = await harness.scanner.scanStats()
    expect(stats.map((row) => [row.id, row.totalTokens])).toEqual([['fork', 110]])
  })

  test('reuses the on-disk index instead of parsing every session again', async () => {
    const harness = createHarness()
    harness.files.write('one', fixture('one'))
    harness.files.write('two', fixture('two'))
    await harness.scanner.scanStats()
    await flushIndex()
    expect(harness.store.text).toBeTruthy()

    const readsBefore = harness.reads.length
    const restarted = createStatsScanner({
      directory: () => harness.dir,
      fileSystem: {
        readdirSync,
        statSync,
        readFileSync(file, encoding) {
          harness.reads.push(file)
          return readFileSync(file, encoding)
        }
      },
      indexStore: harness.store,
      indexWriteDelayMs: 0
    })
    const rows = await restarted.scanStats()

    expect(rows.map((row) => row.id)).toEqual(['one', 'two'])
    expect(harness.reads).toHaveLength(readsBefore)
  })

  test('rebuilds the index when its format version is unknown', async () => {
    const harness = createHarness()
    harness.files.write('one', fixture('one'))
    await harness.scanner.scanStats()
    await flushIndex()

    harness.store.text = JSON.stringify({ version: 999, files: {} })
    const restarted = createStatsScanner({
      directory: () => harness.dir,
      fileSystem: { readdirSync, statSync, readFileSync },
      indexStore: harness.store,
      indexWriteDelayMs: 0
    })

    expect((await restarted.scanStats()).map((row) => row.id)).toEqual(['one'])
  })

  test('readText parses a session body once per file signature', async () => {
    const harness = createHarness()
    harness.files.write('one', fixture('one'))
    let parses = 0
    const scanner = createStatsScanner({
      directory: () => harness.dir,
      indexStore: null,
      fileSystem: { readdirSync, statSync, readFileSync },
      parseText(raw) {
        parses += 1
        return { id: raw.id, text: '正文', truncated: false }
      }
    })
    const file = join(harness.dir, 'one.json')

    expect(await scanner.readText(file)).toEqual({ id: 'one', text: '正文', truncated: false })
    expect(await scanner.readText(file)).toEqual({ id: 'one', text: '正文', truncated: false })
    expect(parses).toBe(1)

    // 文件被改写后签名变化，下次读取重新解析。
    harness.files.write('one', fixture('one', { title: 'changed' }))
    await scanner.readText(file)
    expect(parses).toBe(2)
  })

  test('readText tolerates a missing file and caches an unsearchable body', async () => {
    const harness = createHarness()
    let parses = 0
    const scanner = createStatsScanner({
      directory: () => harness.dir,
      indexStore: null,
      fileSystem: { readdirSync, statSync, readFileSync },
      parseText() {
        parses += 1
        return null
      }
    })

    expect(await scanner.readText(join(harness.dir, 'missing.json'))).toBeNull()
    expect(parses).toBe(0)

    harness.files.write('empty', fixture('empty'))
    const file = join(harness.dir, 'empty.json')
    expect(await scanner.readText(file)).toBeNull()
    expect(await scanner.readText(file)).toBeNull()
    // 没有正文的会话只解析一次，不会每个查询都重读。
    expect(parses).toBe(1)
  })

  test('reports progress while the index is being built', async () => {
    const harness = createHarness()
    for (const id of ['a', 'b', 'c']) harness.files.write(id, fixture(id))
    const seen = []
    const scanner = createStatsScanner({
      directory: () => harness.dir,
      indexStore: null,
      fileSystem: { readdirSync, statSync, readFileSync },
      onProgress(progress) {
        seen.push({ ...progress })
      }
    })

    await scanner.scanStats()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)).toEqual({ building: false, done: 3, total: 3 })
  })
})
