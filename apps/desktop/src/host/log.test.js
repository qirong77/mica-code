import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { flushLogs, logger, readPerformanceSummary, readPerformanceSummaryAsync, startMemorySampler, stats } from './log.js'

let dir = ''
const originalLogDir = process.env.MICA_LOG_DIR

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mica-log-test-'))
  process.env.MICA_LOG_DIR = dir
})

afterEach(() => {
  // 队列里可能还压着没落盘的条目。先按当前的临时目录写下去：否则 2s 后的定时器会在
  // 环境变量恢复之后把它们写进真实日志目录，每跑一次测试就污染一份诊断数据。
  flushLogs()
  if (originalLogDir === undefined) delete process.env.MICA_LOG_DIR
  else process.env.MICA_LOG_DIR = originalLogDir
  rmSync(dir, { recursive: true, force: true })
})

describe('log writer', () => {
  it('writes into MICA_LOG_DIR instead of the system temp dir', () => {
    logger('runtime').info('boot', { pid: 1234 })
    flushLogs()
    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    const body = readFileSync(path.join(dir, files[0]), 'utf8').trim()
    expect(JSON.parse(body)).toMatchObject({ scope: 'runtime', event: 'boot', pid: 1234 })
    expect(stats().dir).toBe(path.resolve(dir))
  })

  it('keeps a hostile scope inside the log dir', () => {
    logger('../../escaped').warn('boom', {})
    flushLogs()
    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(files[0]).not.toContain('/')
    expect(files[0]).not.toContain('..')
  })

  it('drops log files older than the retention window', () => {
    const stale = path.join(dir, 'runtime-19700101.jsonl')
    writeFileSync(stale, '{"at":1}\n')
    const old = Date.now() / 1000 - 30 * 24 * 60 * 60
    utimesSync(stale, old, old)

    logger('runtime').info('boot')
    flushLogs()

    expect(existsSync(stale)).toBe(false)
    expect(readdirSync(dir).length).toBe(1)
  })

  it('rotates to the next shard instead of a new file per flush', () => {
    const d = new Date()
    const stamp = [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0')
    ].join('')
    const dayFile = path.join(dir, `perf-${stamp}.jsonl`)
    writeFileSync(dayFile, 'x'.repeat(17 * 1024 * 1024))

    const perf = logger('perf')
    perf.info('sample', { lag: 1 })
    flushLogs()
    perf.info('sample', { lag: 2 })
    flushLogs()

    const shard = path.join(dir, `perf-${stamp}-1.jsonl`)
    // 两次 flush 都落在同一个分片里，而不是各建一个文件
    expect(readFileSync(shard, 'utf8').trim().split('\n')).toHaveLength(2)
    expect(
      readdirSync(dir)
        .filter((name) => name.startsWith(`perf-${stamp}`))
        .sort()
    ).toEqual([`perf-${stamp}-1.jsonl`, `perf-${stamp}.jsonl`].sort())
  })

  it('reads back every sample it wrote', () => {
    const perf = logger('perf')
    perf.info('batch', { count: 2 })
    perf.info('sample', { lag: 4, long: 0, longN: 0, dom: 900, heapMB: 60, vis: 1 })
    perf.info('sample', { lag: 8, long: 12, longN: 1, dom: 901, heapMB: 61, vis: 1 })
    flushLogs()

    const summary = readPerformanceSummary({ maxBytes: 1024 * 1024 })
    expect(summary.totals.samples).toBe(2)
    expect(summary.totals.hiddenSamples).toBe(0)
    expect(summary.timeline.map((point) => point.lag)).toEqual([4, 8])
  })

  it('forwards the async performance reader with the same sample data', async () => {
    logger('perf').info('sample', { lag: 4, dom: 900, vis: 1 })
    flushLogs()
    expect(await readPerformanceSummaryAsync()).toEqual(readPerformanceSummary())
  })

  it('counts hidden-window samples apart from measurable ones', () => {
    const perf = logger('perf')
    perf.info('sample', { lag: null, dom: 900, heapMB: 60, vis: 0 })
    flushLogs()

    const summary = readPerformanceSummary({ maxBytes: 1024 * 1024 })
    expect(summary.totals.samples).toBe(0)
    expect(summary.totals.hiddenSamples).toBe(1)
  })

  it('records why a call that failed in its return value failed', async () => {
    // 通道把失败包在返回值里（`{ error }`）时，日志必须留下原因，
    // 否则只剩一条慢调用，看不出是超时、被取消还是真报错。
    const invoke = logger('invoke')
    await invoke.timedResult('git:change-counts', async () => ({ counts: 3, error: null }))
    await invoke.timedResult('git:change-counts', async () => ({ counts: null, error: 'boom' }))
    flushLogs()

    const summary = readPerformanceSummary({ maxBytes: 1024 * 1024 })
    const bucket = summary.buckets.find((item) => item.event === 'git:change-counts')
    expect(bucket.count).toBe(2)
    expect(bucket.fails).toBe(1)
    const failed = summary.events.find((entry) => entry.event === 'git:change-counts')
    expect(failed.error).toBe('boom')
  })

  it('still counts a thrown call as a failure', async () => {
    const invoke = logger('invoke')
    await expect(
      invoke.timedResult('git:status', async () => {
        throw new Error('spawn failed')
      })
    ).rejects.toThrow('spawn failed')
    flushLogs()

    const summary = readPerformanceSummary({ maxBytes: 1024 * 1024 })
    expect(summary.buckets.find((item) => item.event === 'git:status')?.fails).toBe(1)
  })

  it('samples process memory with the scene the caller provides', () => {
    const stop = startMemorySampler({ host: 'app-server', describe: () => ({ session: 'sess-1' }) })
    stop()
    flushLogs()

    const summary = readPerformanceSummary({ maxBytes: 1024 * 1024 })
    // 内存单独一条线：不和耗时聚合混在一起，也不进事件流。
    expect(summary.totals.memSamples).toBe(1)
    expect(summary.totals.peakRssMB).toBeGreaterThan(0)
    expect(summary.processes).toHaveLength(1)
    expect(summary.processes[0]).toMatchObject({
      host: 'app-server',
      session: 'sess-1',
      pid: process.pid
    })
    expect(summary.processes[0].lastRssMB).toBeGreaterThan(0)
    expect(summary.buckets.some((item) => item.scope === 'mem')).toBe(false)
    expect(summary.events.some((item) => item.scope === 'mem')).toBe(false)
  })

  it('keeps sampling when describe throws', () => {
    // 采样补现场时读会话状态可能失败，但那不该让进程少一条内存记录。
    const stop = startMemorySampler({
      host: 'runtime',
      describe: () => {
        throw new Error('nope')
      }
    })
    stop()
    flushLogs()

    const summary = readPerformanceSummary({ maxBytes: 1024 * 1024 })
    expect(summary.processes[0].host).toBe('runtime')
    expect(summary.processes[0].samples).toBe(1)
  })
})
