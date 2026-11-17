import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushLogs } from '@packages/mica-diagnostics/index.js'
import { createPluginWebRuntime } from './plugin-web-runtime.js'

const runtimes = []
const homes = []
let originalLogs

beforeEach(() => {
  originalLogs = process.env.MICA_LOG_DIR
  const logDir = mkdtempSync(join(tmpdir(), 'mica-plugin-web-log-'))
  homes.push(logDir)
  process.env.MICA_LOG_DIR = logDir
})

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  flushLogs()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  if (originalLogs === undefined) delete process.env.MICA_LOG_DIR
  else process.env.MICA_LOG_DIR = originalLogs
})

function deferred() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(load, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mica-plugin-web-runtime-'))
  homes.push(home)
  const disabled = new Set()
  const runtime = createPluginWebRuntime({
    home,
    manifests: [{ id: 'demo', name: 'Demo', version: '1.2.3', web: true, settings: [] }],
    loaders: new Map([['demo', load]]),
    readDisabled: () => disabled,
    ...options
  })
  runtimes.push(runtime)
  return { runtime, disabled, home }
}

describe('bundled plugin read-only web runtime', () => {
  it('loads lazily and exposes only bound paths, read-only settings and a public catalog', async () => {
    let calls = 0
    let context
    const { runtime, home } = fixture(
      async () => ({
        default: (ctx) => {
          calls += 1
          context = ctx
          return { queries: { summary: () => ({ count: 1 }) } }
        }
      }),
      {
        manifests: [
          {
            id: 'demo',
            name: 'Demo',
            version: '1.2.3',
            web: true,
            settings: [{ key: 'sample', default: 'configured' }]
          },
          {
            id: 'other',
            name: 'Other',
            version: '2.0.0',
            settings: [{ key: 'secret', default: 'not-in-catalog' }]
          }
        ]
      }
    )
    expect(runtime.has('demo')).toBe(true)
    expect(runtime.has('other')).toBe(false)
    expect(calls).toBe(0)
    const handler = await runtime.load('demo')
    expect(await runtime.load('demo')).toBe(handler)
    expect(calls).toBe(1)
    expect(Object.keys(context).sort()).toEqual([
      'catalog',
      'paths',
      'pluginId',
      'pluginVersion',
      'settings'
    ])
    expect(context.paths).toEqual({ config: home, data: join(home, 'plugin-data', 'demo') })
    expect(context.pluginId).toBe('demo')
    expect(context.pluginVersion).toBe('1.2.3')
    expect(Object.keys(context.settings)).toEqual(['get'])
    expect(context.settings.get()).toEqual({ sample: 'configured' })
    expect(context.catalog).toEqual([
      { id: 'demo', name: 'Demo', version: '1.2.3' },
      { id: 'other', name: 'Other', version: '2.0.0' }
    ])
    expect(Object.isFrozen(context.catalog)).toBe(true)
    expect(Object.isFrozen(context.catalog[0])).toBe(true)
    expect(await runtime.read('demo', handler, 'summary', {})).toEqual({ count: 1 })
  })

  it('waits for retired readers to drain before constructing a re-enabled instance', async () => {
    const gate = deferred()
    let instances = 0
    let stopped = false
    const { runtime, disabled } = fixture(async () => ({
      default: () => {
        const number = ++instances
        return {
          queries: {},
          dispose: async () => {
            if (number === 1) {
              await gate.promise
              stopped = true
            }
          }
        }
      }
    }))
    await runtime.load('demo')
    disabled.add('demo')
    const retiring = runtime.sync()
    disabled.clear()
    const next = runtime.load('demo')
    await Promise.resolve()
    expect(instances).toBe(1)
    gate.resolve()
    await retiring
    await next
    expect(stopped).toBe(true)
    expect(instances).toBe(2)
  })

  it('merges concurrent module/factory initialization', async () => {
    const gate = deferred()
    let imports = 0
    let factories = 0
    const { runtime } = fixture(async () => {
      imports += 1
      await gate.promise
      return {
        default: () => {
          factories += 1
          return { queries: {} }
        }
      }
    })
    const a = runtime.load('demo')
    const b = runtime.load('demo')
    gate.resolve()
    expect(await a).toBe(await b)
    expect(imports).toBe(1)
    expect(factories).toBe(1)
  })

  it('retries initialization failures and disposes invalid factory results', async () => {
    let attempts = 0
    let disposed = 0
    const { runtime } = fixture(async () => ({
      default: () => {
        attempts += 1
        if (attempts === 1) throw new Error('INTERNAL_SECRET')
        if (attempts === 2)
          return {
            queries: { invalid: 'not-a-function' },
            dispose: () => {
              disposed += 1
            }
          }
        return { queries: { summary: () => 3 } }
      }
    }))
    await expect(runtime.load('demo')).rejects.toMatchObject({ code: 'initialization_failed' })
    await expect(runtime.load('demo')).rejects.toMatchObject({ code: 'initialization_failed' })
    const handler = await runtime.load('demo')
    expect(attempts).toBe(3)
    expect(disposed).toBe(1)
    expect(await runtime.read('demo', handler, 'summary', {})).toBe(3)
  })

  it('rechecks disable after await and never resurrects the retired instance on re-enable', async () => {
    const started = deferred()
    const gate = deferred()
    let attempts = 0
    let disposed = 0
    const { runtime, disabled } = fixture(async () => ({
      default: async () => {
        const attempt = ++attempts
        if (attempt === 1) {
          started.resolve()
          await gate.promise
        }
        return {
          queries: { summary: () => attempt },
          dispose: () => {
            disposed += 1
          }
        }
      }
    }))
    const old = runtime.load('demo').catch((error) => error)
    await started.promise
    disabled.add('demo')
    await runtime.sync()
    expect(runtime.has('demo')).toBe(false)
    await expect(runtime.load('demo')).rejects.toMatchObject({ code: 'unavailable' })
    disabled.clear()
    const current = await runtime.load('demo')
    gate.resolve()
    expect(await old).toMatchObject({ code: 'unavailable' })
    expect(await runtime.read('demo', current, 'summary', {})).toBe(2)
    expect(disposed).toBe(1)
    await runtime.close()
    await runtime.close()
    expect(disposed).toBe(2)
  })

  it('does not block close on a pending factory and disposes its late result once', async () => {
    const gate = deferred()
    const started = deferred()
    let disposed = 0
    const { runtime } = fixture(async () => ({
      default: async () => {
        started.resolve()
        await gate.promise
        return {
          queries: {},
          dispose: () => {
            disposed += 1
          }
        }
      }
    }))
    const pending = runtime.load('demo').catch((error) => error)
    await started.promise
    await runtime.close()
    expect(runtime.signal.aborted).toBe(true)
    gate.resolve()
    expect(await pending).toMatchObject({ code: 'unavailable' })
    expect(disposed).toBe(1)
  })

  it('snapshots only valid own query functions, not a prototype or later registrations', async () => {
    const queries = Object.assign(Object.create({ inherited: () => 'secret' }), {
      summary: () => 'safe'
    })
    const { runtime } = fixture(async () => ({ default: () => ({ queries }) }))
    const handler = await runtime.load('demo')
    queries.later = () => 'late'
    for (const query of ['inherited', 'toString', 'constructor', '__proto__', 'later']) {
      expect(() => runtime.read('demo', handler, query, {})).toThrow()
    }
    expect(await runtime.read('demo', handler, 'summary', {})).toBe('safe')
  })

  it('cancels a single read without disposing or cancelling another read of the shared handler', async () => {
    const signals = []
    const releases = []
    let disposed = 0
    const { runtime } = fixture(async () => ({
      default: () => ({
        queries: {
          summary: (_params, context) => {
            expect(Object.keys(context)).toEqual(['signal'])
            signals.push(context.signal)
            return new Promise((resolve, reject) => {
              releases.push(resolve)
              context.signal.addEventListener('abort', () => reject(context.signal.reason), {
                once: true
              })
            })
          }
        },
        dispose: () => {
          disposed += 1
        }
      })
    }))
    const handler = await runtime.load('demo')
    const controller = new AbortController()
    const first = runtime
      .read('demo', handler, 'summary', {}, { signal: controller.signal })
      .catch((error) => error)
    const second = runtime.read('demo', handler, 'summary', {})
    await Promise.resolve()
    controller.abort(new DOMException('cancel one', 'AbortError'))
    expect((await first).name).toBe('AbortError')
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
    expect(disposed).toBe(0)
    releases[1]('still alive')
    expect(await second).toBe('still alive')
    await runtime.close()
    expect(disposed).toBe(1)
  })

  it('keeps ignored-abort work within the real execution concurrency budget', async () => {
    const gate = deferred()
    const { runtime } = fixture(
      async () => ({ default: () => ({ queries: { summary: () => gate.promise } }) }),
      {
        maxConcurrent: 1,
        maxPluginConcurrent: 1
      }
    )
    const handler = await runtime.load('demo')
    const controller = new AbortController()
    const first = runtime
      .read('demo', handler, 'summary', {}, { signal: controller.signal })
      .catch((error) => error)
    await Promise.resolve()
    controller.abort(new DOMException('cancel', 'AbortError'))
    expect((await first).name).toBe('AbortError')
    expect(() => runtime.read('demo', handler, 'summary', {})).toThrow('繁忙')
    gate.resolve(1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(await runtime.read('demo', handler, 'summary', {})).toBe(1)
  })

  it('aborts in-flight reads and disposes the instance on disable', async () => {
    const started = deferred()
    let signal
    let disposed = 0
    const { runtime, disabled } = fixture(async () => ({
      default: () => ({
        queries: {
          summary: (_params, context) => {
            signal = context.signal
            started.resolve()
            return new Promise(() => {})
          }
        },
        dispose: () => {
          disposed += 1
        }
      })
    }))
    const handler = await runtime.load('demo')
    const read = runtime.read('demo', handler, 'summary', {}).catch((error) => error)
    await started.promise
    disabled.add('demo')
    await runtime.sync()
    expect(signal.aborted).toBe(true)
    expect((await read).name).toBe('AbortError')
    expect(disposed).toBe(1)
    expect(() => runtime.read('demo', handler, 'summary', {})).toThrow('停用')
  })
})
