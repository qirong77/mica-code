import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushLogs } from '@packages/mica-diagnostics/index.js'
import { PluginApiError } from '@packages/mica-plugin/PluginApi.js'
import { createPluginApiRuntime } from './plugin-api-runtime.js'

const runtimes = []
const homes = []
let originalLogs

beforeEach(() => {
  originalLogs = process.env.MICA_LOG_DIR
  const logDir = mkdtempSync(join(tmpdir(), 'mica-plugin-api-log-'))
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

function endpoints() {
  return [{ method: 'GET', path: '/notes/:id', summary: '读一条笔记', returns: '{ note }' }]
}

function fixture(load, options = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mica-plugin-api-runtime-'))
  homes.push(home)
  const disabled = new Set()
  const runtime = createPluginApiRuntime({
    home,
    manifests: [{ id: 'demo', name: 'Demo', version: '1.2.3', api: true, settings: [] }],
    loaders: new Map([['demo', load]]),
    readDisabled: () => disabled,
    ...options
  })
  runtimes.push(runtime)
  return { runtime, disabled, home }
}

const read = { method: 'GET', path: ['notes', '1'], query: Object.freeze({}), body: undefined }

describe('bundled plugin API runtime', () => {
  it('loads lazily, reuses one handler and hands over identity plus bound data', async () => {
    let calls = 0
    let context
    const { runtime } = fixture(
      async () => ({
        default: (ctx) => {
          calls += 1
          context = ctx
          return { endpoints: endpoints(), handle: ({ path }) => ({ body: { id: path[1] } }) }
        }
      }),
      {
        manifests: [
          { id: 'demo', name: 'Demo', version: '1.2.3', api: true, settings: [{ key: 'sample', default: 'configured' }] },
          { id: 'other', name: 'Other', version: '2.0.0', settings: [{ key: 'secret', default: 'not-exposed' }] }
        ]
      }
    )
    // 清单没有 `api: true` 的插件即使有模块也不算接口插件。
    expect(runtime.has('demo')).toBe(true)
    expect(runtime.has('other')).toBe(false)
    expect(calls).toBe(0)
    const handler = await runtime.load('demo')
    expect(await runtime.load('demo')).toBe(handler)
    expect(calls).toBe(1)
    expect(Object.keys(context).sort()).toEqual(['data', 'pluginId', 'pluginVersion', 'settings'])
    expect(context.pluginId).toBe('demo')
    expect(context.pluginVersion).toBe('1.2.3')
    expect(Object.keys(context.settings)).toEqual(['get'])
    expect(context.settings.get()).toEqual({ sample: 'configured' })
    expect(Object.keys(context.data).sort()).toEqual(['documents', 'read', 'write'])
    expect(await runtime.invoke('demo', read, {})).toEqual({ body: { id: '1' } })
  })

  it('freezes the request object handed to the plugin', async () => {
    const seen = []
    const { runtime } = fixture(async () => ({
      default: () => ({
        endpoints: endpoints(),
        handle: (request) => {
          seen.push(request)
          return { body: null }
        }
      })
    }))
    await runtime.load('demo')
    const query = Object.freeze(Object.assign(Object.create(null), { sample: '1' }))
    await runtime.invoke('demo', { method: 'POST', path: ['notes'], query, body: { title: 't' } }, {})
    expect(Object.isFrozen(seen[0])).toBe(true)
    expect(Object.isFrozen(seen[0].path)).toBe(true)
    expect(seen[0].query).toBe(query)
    expect(seen[0].signal.aborted).toBe(false)
    expect(seen[0].body).toEqual({ title: 't' })
  })

  it('disposes the instance and refuses later requests once the plugin is disabled', async () => {
    let disposed = 0
    const { runtime, disabled } = fixture(async () => ({
      default: () => ({ endpoints: endpoints(), handle: () => ({ body: 1 }), dispose: () => { disposed += 1 } })
    }))
    await runtime.load('demo')
    disabled.add('demo')
    await runtime.sync()
    expect(runtime.has('demo')).toBe(false)
    await expect(runtime.invoke('demo', read, {})).rejects.toMatchObject({ code: 'unavailable' })
    await expect(runtime.load('demo')).rejects.toMatchObject({ code: 'unavailable' })
    expect(disposed).toBe(1)
    await runtime.close()
    await runtime.close()
    expect(disposed).toBe(1)
  })

  it('waits for the retired instance to finish disposing before a re-enabled load', async () => {
    const gate = deferred()
    let instances = 0
    let stopped = false
    const { runtime, disabled } = fixture(async () => ({
      default: () => {
        const number = ++instances
        return {
          endpoints: endpoints(),
          handle: () => ({ body: number }),
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

  it('retries initialization failures and never leaks the internal exception', async () => {
    let attempts = 0
    const { runtime } = fixture(async () => ({
      default: () => {
        attempts += 1
        if (attempts === 1) throw new Error('INTERNAL_SECRET')
        if (attempts === 2) return { endpoints: [], handle: () => ({ body: null }) }
        return { endpoints: endpoints(), handle: () => ({ body: 'ok' }) }
      }
    }))
    const first = await runtime.load('demo').catch((error) => error)
    expect(first).toMatchObject({ code: 'initialization_failed', status: 503 })
    expect(first.message).not.toContain('INTERNAL_SECRET')
    await expect(runtime.load('demo')).rejects.toMatchObject({ code: 'initialization_failed' })
    const handler = await runtime.load('demo')
    expect(attempts).toBe(3)
    expect(await runtime.invoke('demo', read, {})).toEqual({ body: 'ok' })
    expect(handler.endpoints).toHaveLength(1)
  })

  it('rejects handler shapes that cannot describe an endpoint table', async () => {
    const shapes = [
      null,
      {},
      { endpoints: endpoints() },
      { endpoints: endpoints(), handle: 'not-a-function' },
      { endpoints: [], handle: () => ({ body: null }) },
      { endpoints: 'nope', handle: () => ({ body: null }) },
      { endpoints: [{ method: 'OPTIONS', path: '/x', summary: 's', returns: 'r' }], handle: () => ({ body: null }) },
      { endpoints: [{ method: 'GET', path: 'x', summary: 's', returns: 'r' }], handle: () => ({ body: null }) },
      { endpoints: [{ method: 'GET', path: '/x', summary: ' ', returns: 'r' }], handle: () => ({ body: null }) },
      { endpoints: [{ method: 'GET', path: '/x', summary: 's', returns: '' }], handle: () => ({ body: null }) },
      { endpoints: endpoints(), handle: () => ({ body: null }), description: 1 },
      { endpoints: endpoints(), handle: () => ({ body: null }), guide: {} },
      { endpoints: endpoints(), handle: () => ({ body: null }), dispose: 'later' }
    ]
    for (const shape of shapes) {
      const { runtime } = fixture(async () => ({ default: () => shape }))
      await expect(runtime.load('demo')).rejects.toMatchObject({ code: 'initialization_failed' })
    }
  })

  it('normalizes a trailing slash in documented paths and rejects a relative one', async () => {
    const { runtime } = fixture(async () => ({
      default: () => ({
        endpoints: [{ method: 'POST', path: '/notes/', summary: 'x', returns: 'y' }],
        handle: () => ({ body: null })
      })
    }))
    // 文档里的路径相对 `/plugin/<id>/api`，尾斜杠去掉，免得同一个端点出现两次。
    expect((await runtime.load('demo')).endpoints).toEqual([
      { method: 'POST', path: '/notes', summary: 'x', returns: 'y' }
    ])
    const relative = fixture(async () => ({
      default: () => ({
        endpoints: [{ method: 'POST', path: 'notes', summary: 'x', returns: 'y' }],
        handle: () => ({ body: null })
      })
    }))
    await expect(relative.runtime.load('demo')).rejects.toMatchObject({ code: 'initialization_failed' })
  })

  it('keeps ignored-abort work inside the real concurrency budget', async () => {
    const gate = deferred()
    const { runtime } = fixture(
      async () => ({ default: () => ({ endpoints: endpoints(), handle: () => gate.promise.then((value) => ({ body: value })) }) }),
      { maxConcurrent: 2, maxPluginConcurrent: 1 }
    )
    await runtime.load('demo')
    const first = runtime.invoke('demo', read, {}).catch((error) => error)
    await Promise.resolve()
    await expect(runtime.invoke('demo', read, {})).rejects.toMatchObject({ code: 'busy', status: 429 })
    gate.resolve('done')
    expect(await first).toEqual({ body: 'done' })
    expect(await runtime.invoke('demo', read, {})).toEqual({ body: 'done' })
  })

  it('cancels one call without disposing or cancelling the shared instance', async () => {
    const signals = []
    const releases = []
    const bothStarted = deferred()
    let disposed = 0
    const { runtime } = fixture(async () => ({
      default: () => ({
        endpoints: endpoints(),
        handle: (request) => {
          signals.push(request.signal)
          if (signals.length === 2) bothStarted.resolve()
          return new Promise((resolve, reject) => {
            releases.push(resolve)
            request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
          })
        },
        dispose: () => { disposed += 1 }
      })
    }))
    await runtime.load('demo')
    const controller = new AbortController()
    const first = runtime.invoke('demo', read, { signal: controller.signal }).catch((error) => error)
    const second = runtime.invoke('demo', read, {})
    // 等两个调用真的进了 handler 再取消：否则它可能连 handler 都没跑到就被 abort。
    await bothStarted.promise
    controller.abort(new DOMException('cancel one', 'AbortError'))
    expect((await first).name).toBe('AbortError')
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
    expect(disposed).toBe(0)
    releases[1]({ body: 'still alive' })
    expect(await second).toEqual({ body: 'still alive' })
  })

  it('passes PluginApiError through and normalizes every other exception', async () => {
    const { runtime } = fixture(async () => ({
      default: () => ({
        endpoints: endpoints(),
        handle: ({ path }) => {
          if (path[0] === 'conflict') throw new PluginApiError(409, 'note_conflict', '笔记已被改动')
          if (path[0] === 'invalid') return { status: 'ok', body: null }
          if (path[0] === 'missing-body') return {}
          if (path[0] === 'bad-status') return { status: 42, body: null }
          if (path[0] === 'cycle') {
            const cycle = {}
            cycle.self = cycle
            return { body: cycle }
          }
          throw new Error('INTERNAL_SECRET')
        }
      })
    }))
    await runtime.load('demo')
    await expect(runtime.invoke('demo', { ...read, path: ['conflict'] }, {})).rejects.toMatchObject({
      status: 409,
      code: 'note_conflict',
      message: '笔记已被改动'
    })
    for (const path of [['invalid'], ['missing-body'], ['bad-status']]) {
      await expect(runtime.invoke('demo', { ...read, path }, {})).rejects.toMatchObject({ code: 'invalid_result' })
    }
    const failed = await runtime.invoke('demo', { ...read, path: ['boom'] }, {}).catch((error) => error)
    expect(failed).toMatchObject({ code: 'request_failed', status: 500 })
    expect(failed.message).not.toContain('INTERNAL_SECRET')
    // 返回值的可序列化由路由负责（它才拼信封），运行时只校验形状。
    expect(await runtime.invoke('demo', { ...read, path: ['cycle'] }, {})).toHaveProperty('body')
  })

  it('aborts in-flight work, refuses new requests and disposes once on close', async () => {
    const started = deferred()
    let signal
    let disposed = 0
    const { runtime } = fixture(async () => ({
      default: () => ({
        endpoints: endpoints(),
        handle: (request) => {
          signal = request.signal
          started.resolve()
          return new Promise(() => {})
        },
        dispose: () => { disposed += 1 }
      })
    }))
    await runtime.load('demo')
    const pending = runtime.invoke('demo', read, {}).catch((error) => error)
    await started.promise
    await runtime.close()
    expect(runtime.signal.aborted).toBe(true)
    expect(signal.aborted).toBe(true)
    expect((await pending).name).toBe('AbortError')
    expect(disposed).toBe(1)
    expect(runtime.has('demo')).toBe(false)
    await expect(runtime.load('demo')).rejects.toMatchObject({ code: 'unavailable' })
  })
})
