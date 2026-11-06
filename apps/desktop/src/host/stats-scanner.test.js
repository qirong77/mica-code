import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStatsScanner } from './stats-scanner'
import { createSessionUsageReader } from './session-usage-reader'

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

const flushReads = () => new Promise((resolve) => setImmediate(resolve))

function checkpoint(version, inputTokens) {
  return fixture('one', {
    title: `Checkpoint ${version}`,
    snapshot: {
      ...fixture('one').snapshot,
      conversationMessages: [{ role: 'user', content: `body ${version}` }],
      usageHistory: [{ usageId: `usage-${version}`, inputTokens, outputTokens: 1 }]
    }
  })
}

function controlledReader() {
  const jobs = []
  const read = createSessionUsageReader({
    // 每次 stat 同步取样、异步返回，竞争顺序由 worker 回包控制。
    stat: async (file, options) => statSync(file, options),
    largeFileBytes: 0,
    startWorker(file, mode) {
      const worker = new EventEmitter()
      const value = JSON.parse(readFileSync(file, 'utf8'))
      worker.terminate = async () => {}
      jobs.push({
        file,
        mode,
        finish(reply = { ok: true, value }) { worker.emit('message', reply) }
      })
      return worker
    }
  })
  return { read, jobs }
}

function readProjection(scanner, file, mode) {
  return mode === 'usage' ? scanner.scanStats() : scanner.readText(file)
}

function expectCheckpointB(value, mode) {
  if (mode === 'usage') {
    expect(value).toEqual([expect.objectContaining({ id: 'one', title: 'Checkpoint B', totalTokens: 21 })])
  } else {
    expect(value).toEqual({ id: 'one', text: 'body B', truncated: false })
  }
}

function createHarness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mica-stats-scanner-'))
  temporaryDirectories.push(dir)
  const reads = []
  const store = options.store ?? memoryIndexStore()
  const fileSystem = {
    readdirSync: options.readdirSync ?? readdirSync,
    statSync,
    // 大会话走「只读文件头」的快路径，真实宿主同样有这三个同步方法。
    openSync,
    readSync,
    closeSync,
    readFileSync(file, encoding) {
      reads.push(file)
      return readFileSync(file, encoding)
    }
  }
  const scanner = createStatsScanner({
    directory: () => dir,
    ledgerFile: () => join(dir, 'usage-ledger.jsonl'),
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
      replace(name, value) {
        const file = join(dir, `${name}.json`)
        writeFileSync(`${file}.next`, JSON.stringify(value), 'utf8')
        renameSync(`${file}.next`, file)
      },
      remove(name) {
        unlinkSync(join(dir, `${name}.json`))
      },
      writeLedger(entries) {
        writeFileSync(
          join(dir, 'usage-ledger.jsonl'),
          entries.map((entry) => JSON.stringify(entry)).join('\n'),
          'utf8'
        )
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

  test('uses the async JSON reader for scans, ownership changes and body searches', async () => {
    const reads = []
    const harness = createHarness({
      scanner: {
        async readJson(file, options) {
          reads.push({ file, options })
          await new Promise((resolve) => setImmediate(resolve))
          return JSON.parse(readFileSync(file, 'utf8'))
        }
      }
    })
    const shared = { inputTokens: 20, outputTokens: 2, extra: { legacyIdentity: true } }
    const snapshot = {
      ...fixture('source').snapshot,
      conversationMessages: [{ role: 'user', content: 'searchable body' }],
      usageHistory: [shared]
    }
    harness.files.write('source', fixture('source', { snapshot }))
    harness.files.write('fork', fixture('fork', {
      createdAt: '2025-01-02T00:00:00.000Z', snapshot
    }))
    expect((await harness.scanner.scanStats()).map((row) => row.totalTokens)).toEqual([22, 0])
    expect(reads).toHaveLength(2)
    expect(harness.reads).toHaveLength(0)

    harness.files.remove('source')
    expect((await harness.scanner.scanStats()).map((row) => row.totalTokens)).toEqual([22])
    expect(reads).toHaveLength(3)
    const file = join(harness.dir, 'fork.json')
    expect(await harness.scanner.readText(file)).toEqual({ id: 'fork', text: 'searchable body', truncated: false })
    expect(reads.at(-1)).toEqual({ file, options: { mode: 'text', expectedIdentity: expect.any(String) } })
  })

  test.each(['usage', 'text'])('does not cache an older pending %s projection under a replacement signature', async (mode) => {
    const workers = controlledReader()
    const harness = createHarness({ scanner: { readJson: workers.read } })
    harness.files.write('one', checkpoint('A', 10))
    const file = join(harness.dir, 'one.json')
    // 详情/另一处搜索已经拿到 A，worker 尚未回包。
    const detail = workers.read(file, { mode }).then((value) => ({ value }), (error) => ({ error }))
    await flushReads()
    harness.files.replace('one', checkpoint('B', 20))

    const scan = readProjection(harness.scanner, file, mode)
    await flushReads()
    for (const job of workers.jobs) job.finish()
    const value = await scan
    expectCheckpointB(value, mode)
    expect(await detail).toMatchObject({ error: { code: 'ERR_SESSION_FILE_CHANGED' } })
    expect(workers.jobs).toHaveLength(2)
    expect(await readProjection(harness.scanner, file, mode)).toBe(value)
    expect(workers.jobs).toHaveLength(2)

    if (mode === 'usage') {
      await flushIndex()
      const restarted = createStatsScanner({
        directory: () => harness.dir,
        fileSystem: { readdirSync, statSync, readFileSync },
        indexStore: harness.store,
        readJson() { throw new Error('The persisted B projection must be reused') }
      })
      expectCheckpointB(await restarted.scanStats(), mode)
    }
  })

  test.each(['usage', 'text'])('retries %s on the next scan when replacement happens during its worker read', async (mode) => {
    const workers = controlledReader()
    const harness = createHarness({ scanner: { readJson: workers.read } })
    harness.files.write('one', checkpoint('A', 10))
    const file = join(harness.dir, 'one.json')
    const first = readProjection(harness.scanner, file, mode)
    await flushReads()
    harness.files.replace('one', checkpoint('B', 20))
    workers.jobs[0].finish()
    expect(await first).toEqual(mode === 'usage' ? [] : null)

    const retry = readProjection(harness.scanner, file, mode)
    await flushReads()
    workers.jobs[1].finish()
    const value = await retry
    expectCheckpointB(value, mode)
    expect(await readProjection(harness.scanner, file, mode)).toBe(value)
    expect(workers.jobs).toHaveLength(2)
  })

  test.each(['ERR_SESSION_FILE_CHANGED', 'EIO', 'EMFILE'])('does not cache a worker %s failure as a damaged file', async (code) => {
    const workers = controlledReader()
    const harness = createHarness({ scanner: { readJson: workers.read } })
    harness.files.write('one', checkpoint('A', 10))
    const initial = harness.scanner.scanStats()
    await flushReads()
    workers.jobs[0].finish()
    const stable = await initial

    harness.files.replace('one', checkpoint('B', 20))
    const failed = harness.scanner.scanStats()
    await flushReads()
    workers.jobs[1].finish({ ok: false, error: { name: 'Error', message: 'Transient read failure', code } })
    expect(await failed).toBe(stable)

    const retry = harness.scanner.scanStats()
    await flushReads()
    workers.jobs[2].finish()
    const value = await retry
    expectCheckpointB(value, 'usage')
    expect(await harness.scanner.scanStats()).toBe(value)
    expect(workers.jobs).toHaveLength(3)
  })

  test('does not cache data replaced while awaiting the JSON reader', async () => {
    let notifyStarted
    let finishRead
    const started = new Promise((resolve) => { notifyStarted = resolve })
    const waiting = new Promise((resolve) => { finishRead = resolve })
    const harness = createHarness({
      scanner: {
        async readJson(file) {
          const raw = JSON.parse(readFileSync(file, 'utf8'))
          notifyStarted()
          await waiting
          return raw
        }
      }
    })
    harness.files.write('one', fixture('one'))
    const first = harness.scanner.scanMeta()
    await started
    harness.files.write('one', fixture('one', { title: 'updated during read' }))
    finishRead()
    expect(await first).toEqual([])
    expect(await harness.scanner.scanMeta()).toEqual([
      expect.objectContaining({ id: 'one', title: 'updated during read' })
    ])
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

  test('updates a huge session from its head instead of re-parsing the whole file', async () => {
    const harness = createHarness()
    // 超过 LARGE_FILE_BYTES（4MB）：真实库里这样的会话一份就要 parse 1s。
    const padding = 'x'.repeat(4 * 1024 * 1024)
    harness.files.write('big', fixture('big', { padding }))
    const first = await harness.scanner.scanMeta()
    expect(first.find((row) => row.id === 'big')?.title).toBe('Session big')
    const readsAfterFirst = harness.reads.length

    // 跑完一轮：文件被整份重写，标题也换了。
    harness.files.write('big', fixture('big', { padding, title: 'Renamed big' }))
    const second = await harness.scanner.scanMeta()

    // 标题立刻跟上（读文件头即可），但没有再整份读一遍文件。
    expect(second.find((row) => row.id === 'big')?.title).toBe('Renamed big')
    expect(harness.reads).toHaveLength(readsAfterFirst)
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
    // 收尾那一帧带上「这一轮读了几个文件、其中几个是新会话」：页面据此判断要不要重读
    // 整份列表，只在补索引（没人新建会话）时不跟。
    expect(seen.at(-1)).toEqual({ building: false, done: 3, total: 3, parsedFiles: 3, added: 3 })
  })

  test('adds session-less ledger usage as project rows and refreshes when it grows', async () => {
    const harness = createHarness()
    harness.files.write('one', fixture('one'))
    harness.files.writeLedger([
      {
        id: 'commit-1',
        occurredAt: '2025-01-05T10:00:00.000Z',
        model: 'deepseek-chat',
        pluginId: 'commit',
        purpose: '写提交说明',
        cwd: '/work/one',
        inputTokens: 120,
        cachedInputTokens: 20,
        outputTokens: 30
      }
    ])

    const first = await harness.scanner.scanStats()
    const ledgerRow = first.find((row) => row.ledger)
    // 一次性命令没有会话可写：它以「项目 + 来源」的形式进统计，但不冒充一条会话。
    expect(ledgerRow).toMatchObject({ id: null, ledger: true, cwd: '/work/one', requests: 1 })
    expect(ledgerRow.days[0].sources).toEqual([
      expect.objectContaining({ kind: 'plugin', id: 'commit', purposes: ['写提交说明'] })
    ])
    expect(first.find((row) => row.id === 'one').requests).toBe(0)
    // 会话元信息里不该出现账本行（侧栏只列真会话）。
    expect((await harness.scanner.scanMeta()).map((row) => row.id)).toEqual(['one'])

    harness.files.writeLedger([
      {
        id: 'commit-1',
        occurredAt: '2025-01-05T10:00:00.000Z',
        model: 'deepseek-chat',
        pluginId: 'commit',
        purpose: '写提交说明',
        cwd: '/work/one',
        inputTokens: 120,
        cachedInputTokens: 20,
        outputTokens: 30
      },
      {
        id: 'commit-2',
        occurredAt: '2025-01-06T10:00:00.000Z',
        model: 'deepseek-chat',
        pluginId: 'commit',
        purpose: '写提交说明',
        cwd: '/work/one',
        inputTokens: 60,
        outputTokens: 10
      }
    ])
    const second = await harness.scanner.scanStats()
    expect(second.find((row) => row.ledger).requests).toBe(2)
    expect(second.find((row) => row.ledger)).not.toBe(ledgerRow)
  })
})
