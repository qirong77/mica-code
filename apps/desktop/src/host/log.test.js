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
import { flushLogs, logger, readPerformanceSummary, stats } from './log.js'

let dir = ''
const originalLogDir = process.env.MICA_LOG_DIR

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'mica-log-test-'))
  process.env.MICA_LOG_DIR = dir
})

afterEach(() => {
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

  it('counts hidden-window samples apart from measurable ones', () => {
    const perf = logger('perf')
    perf.info('sample', { lag: null, dom: 900, heapMB: 60, vis: 0 })
    flushLogs()

    const summary = readPerformanceSummary({ maxBytes: 1024 * 1024 })
    expect(summary.totals.samples).toBe(0)
    expect(summary.totals.hiddenSamples).toBe(1)
  })
})
