import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  readPluginHealth,
  resolvePluginHealthPath,
  writePluginHealth
} from '@packages/mica-plugin/PluginHealth.js'
import { createPluginLauncherRuntime } from './plugin-launcher-runtime.js'

const cleanups = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

/** Launcher logs go to the real plugin log dir; tests keep them in memory. */
const silentLogger = () => ({ info() {}, warn() {}, error() {} })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(20)
  }
  throw new Error('condition was not met in time')
}

/**
 * `loaders` maps plugin id → the `createLauncher` factory; the fixture wraps each one
 * in the module shape the runtime imports.
 */
function fixture(loaders, { launcher = {}, manifests, control } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mica-plugin-launcher-runtime-'))
  const disabled = new Set()
  const runtime = createPluginLauncherRuntime({
    home,
    readDisabled: () => disabled,
    logger: silentLogger,
    ...(control ? { control } : {}),
    manifests: manifests ?? [
      {
        id: 'sample',
        version: '1.0.0',
        settings: [{ key: 'roots', type: 'text', default: '~/Desktop' }],
        desktopLauncher: { title: 'Sample', ...launcher }
      }
    ],
    loaders: new Map(
      Object.entries(loaders).map(([id, factory]) => [id, async () => ({ default: factory })])
    )
  })
  cleanups.push(async () => {
    await runtime.close()
    rmSync(home, { recursive: true, force: true })
  })
  return { runtime, disabled, home }
}

test('shares one backend across requests and supplies plugin-scoped settings and versioned data', async () => {
  let created = 0
  const { runtime } = fixture({
    sample: (context) => {
      created++
      return {
        request: async (action, input) => {
          if (action === 'read')
            return { settings: context.settings.get(), data: await context.readData() }
          const data = await context.readData()
          return context.writeData(input, { expectedVersion: data.version })
        }
      }
    }
  })
  const responses = await Promise.all([
    runtime.request('sample', 'read'),
    runtime.request('sample', 'read')
  ])
  expect(created).toBe(1)
  expect(responses[0]).toEqual({
    settings: { roots: '~/Desktop' },
    data: { value: null, version: null }
  })
  expect(await runtime.request('sample', 'write', { recent: ['abc'] })).toMatchObject({ ok: true })
  expect((await runtime.request('sample', 'read')).data.value).toEqual({ recent: ['abc'] })
})

test('disposes disabled backends and rejects further requests until reenabled', async () => {
  let disposed = 0
  let created = 0
  const { runtime, disabled } = fixture({
    sample: () => {
      created++
      return {
        request: () => 'ok',
        dispose: () => {
          disposed++
        }
      }
    }
  })
  await runtime.request('sample', 'read')
  disabled.add('sample')
  await runtime.sync()
  expect(disposed).toBe(1)
  await expect(runtime.request('sample', 'read')).rejects.toThrow('停用')
  disabled.clear()
  expect(await runtime.request('sample', 'read')).toBe('ok')
  expect(created).toBe(2)
  await expect(runtime.request('../other', 'read')).rejects.toThrow()
})

test('initializes background launchers on sync while plain launchers stay lazy', async () => {
  let eager = 0
  let lazy = 0
  const { runtime } = fixture(
    {
      eager: () => {
        eager++
        return { request: () => 'ok' }
      },
      lazy: () => {
        lazy++
        return { request: () => 'ok' }
      }
    },
    {
      manifests: [
        {
          id: 'eager',
          version: '1.0.0',
          settings: [],
          desktopLauncher: { title: 'Eager', background: true }
        },
        {
          id: 'lazy',
          version: '1.0.0',
          settings: [],
          desktopLauncher: { title: 'Lazy', background: false }
        }
      ]
    }
  )
  await runtime.sync()
  expect(eager).toBe(1)
  expect(lazy).toBe(0)
  expect(await runtime.request('lazy', 'ping')).toBe('ok')
  expect(lazy).toBe(1)
  expect(await runtime.request('eager', 'ping')).toBe('ok')
  expect(eager).toBe(1)
})

test('disabling stops scheduled work and the backend; reenabling rebuilds both', async () => {
  let created = 0
  let disposed = 0
  let ticks = 0
  const { runtime, disabled } = fixture(
    {
      sample: (context) => {
        created++
        context.background.register({
          id: 'clipboard',
          every: () => 200,
          immediate: true,
          run: () => {
            ticks++
          }
        })
        return {
          request: () => 'ok',
          dispose: () => {
            disposed++
          }
        }
      }
    },
    { launcher: { background: true } }
  )
  await runtime.sync()
  await waitFor(() => ticks >= 1)
  disabled.add('sample')
  await runtime.sync()
  expect(disposed).toBe(1)
  const stopped = ticks
  await sleep(500)
  expect(ticks).toBe(stopped)
  disabled.clear()
  await runtime.sync()
  expect(created).toBe(2)
  await waitFor(() => ticks > stopped)
})

test('sync starts a background launcher that a request already registered', async () => {
  let clip = 0
  const { runtime } = fixture(
    {
      plain: () => ({ request: () => 'ok' }),
      clip: () => {
        clip++
        return { request: () => 'ok' }
      }
    },
    {
      manifests: [
        { id: 'plain', version: '1.0.0', settings: [], desktopLauncher: { title: 'Plain' } },
        {
          id: 'clip',
          version: '1.0.0',
          settings: [],
          desktopLauncher: { title: 'Clip', background: true }
        }
      ]
    }
  )
  // The request reconcile registers every launcher entry but starts none.
  expect(await runtime.request('plain', 'ping')).toBe('ok')
  expect(clip).toBe(0)
  await runtime.sync()
  expect(clip).toBe(1)
})

test('clears a recovered background issue once and keeps later successes off the disk', async () => {
  const { runtime, home } = fixture(
    {
      sample: (context) => {
        context.background.register({
          id: 'clipboard',
          every: () => 100,
          immediate: true,
          run: () => {}
        })
        return { request: () => 'ok' }
      }
    },
    { launcher: { background: true } }
  )
  const healthPath = resolvePluginHealthPath('sample', home)
  // A previous run left this issue behind; the launcher has to clear it exactly once.
  writePluginHealth(
    'sample',
    { issueKey: 'background:clipboard', level: 'error', message: '旧故障' },
    { configDir: home, version: '1.0.0' }
  )
  await runtime.sync()
  await waitFor(
    () => readPluginHealth('sample', { configDir: home, issueKey: 'background:clipboard' }) === null
  )
  await sleep(80)
  const { mtimeMs } = statSync(healthPath)
  await sleep(400)
  expect(statSync(healthPath).mtimeMs).toBe(mtimeMs)
})

test('runs a 500ms launcher task without the chat-host one-second floor', async () => {
  const times = []
  const { runtime } = fixture(
    {
      sample: (context) => {
        context.background.register({
          id: 'clipboard',
          every: () => 500,
          immediate: true,
          run: () => {
            times.push(Date.now())
          }
        })
        return { request: () => 'ok' }
      }
    },
    { launcher: { background: true } }
  )
  await runtime.sync()
  await waitFor(() => times.length >= 3, 4000)
  expect(times[1] - times[0]).toBeLessThan(950)
})

test('close during a slow initialization waits and releases the late backend and its tasks', async () => {
  const gate = deferred()
  const state = { created: 0, disposed: 0, ticks: 0, signal: null, finish: null }
  const { runtime } = fixture(
    {
      sample: async (context) => {
        state.created++
        context.background.register({
          id: 'clipboard',
          every: () => 100,
          immediate: true,
          run: ({ signal }) => {
            state.ticks++
            state.signal = signal
            return new Promise((resolve) => {
              state.finish = resolve
            })
          }
        })
        await gate.promise
        return {
          request: () => 'ok',
          dispose: () => {
            state.disposed++
          }
        }
      }
    },
    { launcher: { background: true } }
  )
  const syncing = runtime.sync()
  await waitFor(() => state.created === 1)
  let closed = false
  const closing = runtime.close().then(() => {
    closed = true
  })
  await sleep(50)
  expect(closed).toBe(false)
  expect(state.signal?.aborted).toBe(true)
  gate.resolve()
  await closing
  await syncing
  state.finish?.()
  expect(state.disposed).toBe(1)
  const stopped = state.ticks
  await sleep(250)
  expect(state.ticks).toBe(stopped)
  await expect(runtime.request('sample', 'ping')).rejects.toThrow('已关闭')
})

test('disabling while a backend initializes does not leak its background tasks', async () => {
  const gate = deferred()
  const state = { created: 0, disposed: 0, ticks: 0 }
  const { runtime, disabled } = fixture(
    {
      sample: async (context) => {
        state.created++
        context.background.register({
          id: 'clipboard',
          every: () => 100,
          immediate: true,
          run: () => {
            state.ticks++
          }
        })
        await gate.promise
        return {
          request: () => 'ok',
          dispose: () => {
            state.disposed++
          }
        }
      }
    },
    { launcher: { background: true } }
  )
  const syncing = runtime.sync()
  await waitFor(() => state.created === 1)
  disabled.add('sample')
  const disposing = runtime.sync()
  gate.resolve()
  await disposing
  await syncing
  expect(state.disposed).toBe(1)
  const stopped = state.ticks
  await sleep(300)
  expect(state.ticks).toBe(stopped)
})

test('a failed initialization releases the tasks it registered and can be retried', async () => {
  let attempts = 0
  let ticks = 0
  const { runtime } = fixture({
    sample: (context) => {
      attempts++
      context.background.register({
        id: 'clipboard',
        every: () => 100,
        immediate: true,
        run: () => {
          ticks++
        }
      })
      if (attempts === 1) throw new Error('boom')
      return { request: () => 'ok' }
    }
  })
  await expect(runtime.request('sample', 'ping')).rejects.toThrow('boom')
  const stopped = ticks
  await sleep(300)
  expect(ticks).toBe(stopped)
  expect(await runtime.request('sample', 'ping')).toBe('ok')
  expect(attempts).toBe(2)
})

test('exposes a private data directory, writable settings and plugin-bound native control', async () => {
  const calls = []
  const { runtime, home } = fixture(
    {
      sample: (context) => ({
        request: async (action, input) => {
          if (action === 'keys') return Object.keys(context).sort()
          if (action === 'settings') {
            context.settings.set({ roots: input.roots })
            return context.settings.get()
          }
          if (action === 'control') return context.control(input.action, input)
          return context.dataDirectory
        }
      })
    },
    {
      control: async (payload) => {
        calls.push(payload)
        return { ok: true }
      }
    }
  )
  const dataDirectory = await runtime.request('sample', 'data-directory')
  expect(dataDirectory).toBe(join(home, 'plugin-data', 'sample'))
  expect(statSync(dataDirectory).mode & 0o777).toBe(0o700)
  expect(await runtime.request('sample', 'keys')).toEqual([
    'background',
    'control',
    'dataDirectory',
    'health',
    'pluginId',
    'readData',
    'settings',
    'writeData'
  ])
  expect(await runtime.request('sample', 'settings', { roots: '/tmp/a' })).toMatchObject({
    roots: '/tmp/a'
  })
  expect(await runtime.request('sample', 'control', { action: 'show', pluginId: 'other' })).toEqual(
    {
      ok: true
    }
  )
  expect(calls).toEqual([{ pluginId: 'sample', action: 'show' }])
})

test('loads the backend without a native adapter and fails only the control call', async () => {
  // A manifest without a settings list still gets a usable context.
  const { runtime } = fixture(
    {
      sample: (context) => ({
        request: async (action) => {
          if (action === 'control') return context.control('show')
          if (action === 'settings') return context.settings.get()
          return 'ok'
        }
      })
    },
    { manifests: [{ id: 'sample', version: '1.0.0', desktopLauncher: { title: 'Sample' } }] }
  )
  expect(await runtime.request('sample', 'ping')).toBe('ok')
  expect(await runtime.request('sample', 'settings')).toEqual({})
  await expect(runtime.request('sample', 'control')).rejects.toThrow('不支持')
})

test('reports background failures under background:<task> and clears only that key', async () => {
  let fail = true
  const { runtime, home } = fixture(
    {
      sample: (context) => {
        context.health.report({ issueKey: 'clipboard', level: 'warn', message: '原生能力不可用' })
        context.background.register({
          id: 'clipboard',
          every: () => 100,
          immediate: true,
          run: () => {
            if (fail) throw new Error('boom')
          }
        })
        return { request: () => 'ok' }
      }
    },
    { launcher: { background: true } }
  )
  await runtime.sync()
  const health = (issueKey) => readPluginHealth('sample', { configDir: home, issueKey })
  await waitFor(() => health('background:clipboard')?.level === 'error')
  expect(health('background:clipboard')?.message).toContain('boom')
  expect(health('clipboard')).toMatchObject({ level: 'warn', message: '原生能力不可用' })
  fail = false
  await waitFor(() => health('background:clipboard') === null)
  expect(health('clipboard')).toMatchObject({ level: 'warn', message: '原生能力不可用' })
})
