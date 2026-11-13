import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPluginMcpRuntime } from './plugin-mcp-runtime.js'

const homes = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('plugin MCP runtime', () => {
  it('loads a bundled module lazily, supplies plugin-owned data, and disposes on disable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mica-plugin-mcp-runtime-'))
    homes.push(home)
    let disabled = new Set()
    let loaded = 0
    let disposed = 0
    const runtime = createPluginMcpRuntime({
      home,
      manifests: [{ id: 'demo', version: '1.0.0', settings: [], mcp: true }],
      loaders: new Map([['demo', async () => ({
        default: async ({ pluginId, data }) => {
          loaded += 1
          expect(pluginId).toBe('demo')
          expect(data.read().version).toBeNull()
          return { tools: [], dispose: () => { disposed += 1 } }
        }
      })]]),
      readDisabled: () => disabled
    })

    expect(runtime.has('demo')).toBe(true)
    await runtime.load('demo')
    await runtime.load('demo')
    expect(loaded).toBe(1)
    disabled = new Set(['demo'])
    await runtime.sync()
    expect(runtime.has('demo')).toBe(false)
    expect(disposed).toBe(1)
    await runtime.close()
  })
})
