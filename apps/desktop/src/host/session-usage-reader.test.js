import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSessionEvents, parseSessionText } from './stats-core'
import { createSessionUsageReader, sessionFileIdentity } from './session-usage-reader'

const directories = []

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  return {
    version: 1,
    id: 'session-1',
    title: 'Saved title',
    cwd: '/work',
    parentSessionId: 'parent',
    awaitingInput: 'Choose one',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-02T00:00:00.000Z',
    turnState: 'running',
    snapshot: {
      providerId: 'provider-1', model: 'model-1', effort: 'high', role: 'default',
      contextWindowSize: 200000,
      messages: [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer', tool_calls: [{ arguments: 'unneeded' }] },
        { role: 'tool', content: 'tool output' },
        null,
        { role: 'assistant', content: 'follow-up' }
      ],
      conversationMessages: [{ role: 'user', content: 'question' }],
      usageHistory: [
        {
          inputTokens: '12', outputTokens: 3, cachedInputTokens: 4, totalTokens: 15,
          providerId: 'provider-1', model: 'model-1', turnId: 1,
          durationMs: 10, firstTokenMs: 2, responseWaitMs: 3, generationDurationMs: 7,
          legacyExtra: { keepThisForIdentity: ['original', 1] }
        },
        { usageId: 'u-2', inputTokens: 5, outputTokens: 2 }
      ],
      subagentUsageHistory: [
        {
          taskId: 'task-1', origin: 'delegation', pluginId: 'subagent',
          initiatedByCallId: 'call-1', subagentType: 'Explore', description: 'Inspect files',
          model: 'model-2', effort: 'medium', status: 'completed',
          startedAt: '2025-01-01T12:00:00.000Z', finishedAt: '2025-01-01T13:00:00.000Z',
          requests: [{ inputTokens: 7, outputTokens: 2, legacyExtra: true }],
          summary: { records: 1, totalTokens: 9 }
        }
      ],
      lastUsage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      displayUsage: { totalTokens: 20, compactedAt: '2025-01-01T10:00:00.000Z' }
    }
  }
}

function sessionFile(raw) {
  const dir = mkdtempSync(join(tmpdir(), 'mica-session-usage-reader-'))
  directories.push(dir)
  const file = join(dir, 'session.json')
  writeFileSync(file, typeof raw === 'string' ? raw : JSON.stringify(raw))
  return file
}

function replaceFile(file, raw) {
  const next = `${file}.next`
  writeFileSync(next, JSON.stringify(raw))
  renameSync(next, file)
}

function controlledWorkers() {
  const jobs = []
  return {
    jobs,
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
  }
}

// 注入同步取样的 async stat，让当前宏任务结束前所有请求都确定入队/起读。
const asyncStat = async (file, options) => statSync(file, options)
const flushReads = () => new Promise((resolve) => setImmediate(resolve))

describe('session usage reader', () => {
  test('large files are parsed in a worker without returning bodies or changing usage identities', async () => {
    const raw = fixture()
    raw.snapshot.systemPrompt = 'x'.repeat(4 * 1024 * 1024)
    raw.snapshot.pluginState = { large: 'unneeded' }
    raw.padding = 'unneeded'
    const file = sessionFile(raw)
    const read = createSessionUsageReader({
      readFile() { throw new Error('Large files must not be read in the host') }
    })

    const value = await read(file)
    expect(parseSessionEvents(value)).toEqual(parseSessionEvents(raw))
    expect(JSON.stringify(value.snapshot.usageHistory)).toBe(JSON.stringify(raw.snapshot.usageHistory))
    expect(JSON.stringify(value.snapshot.subagentUsageHistory)).toBe(JSON.stringify(raw.snapshot.subagentUsageHistory))
    expect(value).toMatchObject({
      version: 1, id: raw.id, title: raw.title, cwd: raw.cwd,
      parentSessionId: raw.parentSessionId, awaitingInput: raw.awaitingInput,
      snapshot: {
        effort: 'high', role: 'default', contextWindowSize: 200000,
        lastUsage: raw.snapshot.lastUsage, displayUsage: raw.snapshot.displayUsage
      }
    })
    expect(value.snapshot.messages).toEqual([
      { role: 'user' }, { role: 'assistant' }, { role: 'tool' }, { role: undefined }, { role: 'assistant' }
    ])
    expect(value.snapshot.conversationMessages).toEqual([])
    expect(value.snapshot.systemPrompt).toBeUndefined()
    expect(value.snapshot.pluginState).toBeUndefined()
    expect(value.padding).toBeUndefined()
    expect(JSON.stringify(value).length).toBeLessThan(10000)
  })

  test('small files use asynchronous reads and preserve invalid message-array shapes', async () => {
    const raw = fixture()
    raw.snapshot.messages = { role: 'assistant' }
    raw.snapshot.conversationMessages = null
    let reads = 0
    const read = createSessionUsageReader({
      stat: async () => ({ size: 1 }),
      readFile: async () => { reads += 1; return Buffer.from(JSON.stringify(raw)) },
      startWorker() { throw new Error('Small files should not start a worker') }
    })
    const value = await read('small')
    expect(reads).toBe(1)
    expect(Array.isArray(value.snapshot.messages)).toBe(false)
    expect(Array.isArray(value.snapshot.conversationMessages)).toBe(false)
    expect(parseSessionEvents(value)).toEqual(parseSessionEvents(raw))
  })

  test('a file that grows after stat is parsed in a worker', async () => {
    const raw = fixture()
    raw.snapshot.systemPrompt = 'x'.repeat(4096)
    const file = sessionFile(raw)
    const read = createSessionUsageReader({ stat: async () => ({ size: 1 }), largeFileBytes: 4096 })
    expect(parseSessionEvents(await read(file))).toEqual(parseSessionEvents(raw))
  })

  test('text mode keeps the existing search projection, including display content and both ends of long text', async () => {
    const raw = fixture()
    raw.snapshot.conversationMessages = [
      null,
      { role: 'notice', content: 'ignored notice' },
      { role: 'user', content: '[Mica compact boundary] internal metadata' },
      { role: 'user', content: 'first task', displayContent: 'injected task' },
      { role: 'assistant', content: '[Mica compact checkpoint] retained summary' },
      { role: 'assistant', content: [
        { type: 'text', text: 'answer' }, { type: 'image', data: 'base64 payload' },
        { type: 'tool_use', input: 'private tool arguments' },
        { type: 'thinking', text: 'private reasoning' }, null, 'invalid block'
      ] },
      { role: 'user', content: 'middle '.repeat(5000) },
      { role: 'assistant', content: 'latest answer', displayContent: [{ type: 'text', text: 'displayed answer' }] }
    ]
    const read = createSessionUsageReader({ largeFileBytes: 0 })
    const value = await read(sessionFile(raw), { mode: 'text' })
    expect(parseSessionText(value)).toEqual(parseSessionText(raw))
    expect(parseSessionText(value, { maxChars: 100000 })).toEqual(parseSessionText(raw, { maxChars: 100000 }))
    expect(parseSessionText(value).text).toStartWith('first task\ninjected task')
    expect(parseSessionText(value).text).toEndWith('latest answer\ndisplayed answer')
    expect(JSON.stringify(value)).not.toContain('base64 payload')
    expect(JSON.stringify(value)).not.toContain('private tool arguments')
    expect(value.snapshot.usageHistory).toBeUndefined()
  })

  test('coalesces concurrent file reads and bounds workers across projection modes', async () => {
    let alive = 0
    let peak = 0
    let starts = 0
    let terminations = 0
    const workers = []
    const read = createSessionUsageReader({
      stat: async () => ({ size: 100 }),
      largeFileBytes: 0,
      maxConcurrentReads: 2,
      startWorker(file, mode) {
        starts += 1
        alive += 1
        peak = Math.max(peak, alive)
        const worker = new EventEmitter()
        worker.terminate = async () => { alive -= 1; terminations += 1 }
        workers.push(worker)
        queueMicrotask(() => worker.emit('message', { ok: true, value: { file, mode } }))
        return worker
      }
    })
    const first = read('one')
    const duplicate = read('one')
    expect(await Promise.all([first, duplicate, read('two'), read('one', { mode: 'text' }), read('three')])).toEqual([
      { file: 'one', mode: 'usage' }, { file: 'one', mode: 'usage' }, { file: 'two', mode: 'usage' },
      { file: 'one', mode: 'text' }, { file: 'three', mode: 'usage' }
    ])
    expect(starts).toBe(4)
    expect(peak).toBe(2)
    expect(alive).toBe(0)
    expect(terminations).toBe(4)
    for (const worker of workers) expect(worker.eventNames()).toEqual([])
  })

  test.each(['usage', 'text'])('does not coalesce %s requests across atomic replacements', async (mode) => {
    const file = sessionFile(fixture())
    const workers = controlledWorkers()
    const read = createSessionUsageReader({
      // A/B 的大小和时间戳相同，仍要按 inode 区分原子替换。
      stat: async (path, options) => ({ ...statSync(path, options), mtimeNs: 1n, ctimeNs: 1n }),
      largeFileBytes: 0,
      startWorker: workers.startWorker
    })
    const first = read(file, { mode }).then((value) => ({ value }), (error) => ({ error }))
    await flushReads()

    const replacement = fixture()
    replacement.title = 'Newer title'
    replaceFile(file, replacement)
    const second = read(file, { mode })
    const duplicate = read(file, { mode })
    await flushReads()
    for (const job of workers.jobs) job.finish()

    expect(await first).toMatchObject({ error: { code: 'ERR_SESSION_FILE_CHANGED' } })
    const values = await Promise.all([second, duplicate])
    expect(values.map((value) => value.title)).toEqual(['Newer title', 'Newer title'])
    expect(workers.jobs).toHaveLength(2)
  })

  test('accepts a stable expected identity and rejects one replaced before the reader stat', async () => {
    const file = sessionFile(fixture())
    const expectedIdentity = sessionFileIdentity(statSync(file, { bigint: true }))
    const workers = controlledWorkers()
    const read = createSessionUsageReader({ startWorker: workers.startWorker })
    expect((await read(file, { expectedIdentity })).id).toBe('session-1')
    replaceFile(file, fixture())

    await expect(read(file, { expectedIdentity })).rejects.toMatchObject({ code: 'ERR_SESSION_FILE_CHANGED' })
    expect(workers.jobs).toHaveLength(0)
  })

  test('rejects a queued version replaced before its worker starts and retries the new version', async () => {
    const blocker = sessionFile(fixture())
    const file = sessionFile(fixture())
    const workers = controlledWorkers()
    const read = createSessionUsageReader({
      stat: asyncStat, largeFileBytes: 0, maxConcurrentReads: 1, startWorker: workers.startWorker
    })
    const blockingRead = read(blocker)
    await flushReads()
    const queuedRead = read(file).then((value) => ({ value }), (error) => ({ error }))
    await flushReads()
    replaceFile(file, { ...fixture(), title: 'Replaced while queued' })
    workers.jobs[0].finish()

    await blockingRead
    expect(await queuedRead).toMatchObject({ error: { code: 'ERR_SESSION_FILE_CHANGED' } })
    expect(workers.jobs).toHaveLength(1)

    const retry = read(file)
    await flushReads()
    workers.jobs[1].finish()
    expect((await retry).title).toBe('Replaced while queued')
    expect(workers.jobs).toHaveLength(2)
  })

  test.each(['usage', 'text'])('rejects an atomic replacement during a small asynchronous %s read', async (mode) => {
    const file = sessionFile(fixture())
    let finishRead
    let reads = 0
    const read = createSessionUsageReader({
      stat: asyncStat,
      readFile(path) {
        reads += 1
        const value = readFileSync(path)
        if (reads === 1) return new Promise((resolve) => { finishRead = () => resolve(value) })
        return Promise.resolve(value)
      }
    })
    const first = read(file, { mode }).then((value) => ({ value }), (error) => ({ error }))
    await flushReads()
    const replacement = fixture()
    replacement.title = 'Replaced during async read'
    replacement.snapshot.conversationMessages = [{ role: 'user', content: replacement.title }]
    replaceFile(file, replacement)
    finishRead()

    expect(await first).toMatchObject({ error: { code: 'ERR_SESSION_FILE_CHANGED' } })
    const value = await read(file, { mode })
    expect(mode === 'usage' ? value.title : parseSessionText(value).text).toBe(replacement.title)
    expect(reads).toBe(2)
  })

  test.each(['throw', 'error', 'exit', 'timeout'])('terminates and falls back after worker %s, then allows a fresh read', async (kind) => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    let terminations = 0
    let reads = 0
    let starts = 0
    const read = createSessionUsageReader({
      stat: async () => ({ size: 100 }),
      readFile: async () => {
        expect(terminations).toBe(kind === 'throw' ? 0 : starts)
        reads += 1
        return Buffer.from(JSON.stringify(fixture()))
      },
      largeFileBytes: 0,
      workerTimeoutMs: 5,
      startWorker() {
        starts += 1
        if (kind === 'throw') throw new Error('cannot start worker')
        const worker = new EventEmitter()
        worker.terminate = async () => { terminations += 1 }
        if (kind === 'error') queueMicrotask(() => worker.emit('error', new Error('worker failed')))
        if (kind === 'exit') queueMicrotask(() => worker.emit('exit', 0))
        return worker
      }
    })
    try {
      expect((await read('one')).id).toBe('session-1')
      expect((await read('one')).id).toBe('session-1')
      expect(reads).toBe(2)
      expect(starts).toBe(2)
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  test('corrupt JSON returned as a worker read error is not parsed again in the host', async () => {
    let reads = 0
    const read = createSessionUsageReader({
      largeFileBytes: 0,
      readFile: async () => { reads += 1; return Buffer.from('{}') }
    })
    const file = sessionFile('{broken')
    await expect(read(file)).rejects.toMatchObject({ name: 'SyntaxError' })
    expect(reads).toBe(0)
    writeFileSync(file, JSON.stringify(fixture()))
    expect((await read(file)).id).toBe('session-1')
  })
})
