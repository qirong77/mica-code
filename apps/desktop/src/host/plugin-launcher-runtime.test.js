import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPluginLauncherRuntime } from './plugin-launcher-runtime.js'

const cleanups = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

function fixture(factory) {
  const home = mkdtempSync(join(tmpdir(), 'mica-plugin-launcher-runtime-'))
  const disabled = new Set()
  const runtime = createPluginLauncherRuntime({
    home,
    readDisabled: () => disabled,
    manifests: [
      {
        id: 'sample',
        settings: [{ key: 'roots', type: 'text', default: '~/Desktop' }],
        desktopLauncher: { title: 'Sample' }
      }
    ],
    loaders: new Map([['sample', async () => ({ default: factory })]])
  })
  cleanups.push(async () => {
    await runtime.close()
    rmSync(home, { recursive: true, force: true })
  })
  return { runtime, disabled }
}

test('shares one backend across requests and supplies plugin-scoped settings and versioned data', async () => {
  let created = 0
  const { runtime } = fixture((context) => {
    created++
    return {
      request: async (action, input) => {
        if (action === 'read')
          return { settings: context.settings.get(), data: await context.readData() }
        const data = await context.readData()
        return context.writeData(input, { expectedVersion: data.version })
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
  const { runtime, disabled } = fixture(() => {
    created++
    return {
      request: () => 'ok',
      dispose: () => {
        disposed++
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
