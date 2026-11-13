import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPluginMcpServers, pluginMcpCandidates, setPluginMcpCatalog } from './plugin-mcp-config.js'
import { listMcpCandidates } from './mcp-candidates-core.js'
import { writeControlMcpConfig } from './control-mcp-config.js'

const manifests = [
  { id: 'demo', name: 'Demo', description: '示例插件', mcp: true },
  { id: 'page-only', name: 'Page', mcp: false }
]
const directories = []
const previous = { MICA_HOME: process.env.MICA_HOME, MICA_DESKTOP_ORIGIN: process.env.MICA_DESKTOP_ORIGIN }

afterEach(() => {
  setPluginMcpCatalog()
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('plugin MCP session configuration', () => {
  it('uses the real runtime origin and only explicitly declared modules', () => {
    expect(buildPluginMcpServers({ origin: 'http://127.0.0.1:9099///', manifests })).toEqual({
      'mica-plugin-demo': { type: 'http', url: 'http://127.0.0.1:9099/plugin/demo/mcp' }
    })
    expect(buildPluginMcpServers({ origin: '', manifests })).toEqual({})
  })

  it('writes plugin servers even when the Web runtime has no native control sockets', () => {
    const home = mkdtempSync(join(tmpdir(), 'mica-plugin-mcp-config-'))
    directories.push(home)
    const path = writeControlMcpConfig({
      homeDir: home, origin: 'http://127.0.0.1:9099', owner: 'session-1', kinds: [],
      extraServers: buildPluginMcpServers({ origin: 'http://127.0.0.1:9099', manifests })
    })
    expect(JSON.parse(readFileSync(path, 'utf8')).mcpServers).toEqual({
      'mica-plugin-demo': { type: 'http', url: 'http://127.0.0.1:9099/plugin/demo/mcp' }
    })
  })

  it('publishes candidates without loading modules, and removes disabled ones from both paths', () => {
    let enabled = true
    setPluginMcpCatalog(() => enabled ? manifests : [])
    process.env.MICA_HOME = mkdtempSync(join(tmpdir(), 'mica-plugin-mcp-candidates-'))
    directories.push(process.env.MICA_HOME)
    process.env.MICA_DESKTOP_ORIGIN = 'http://127.0.0.1:9099'
    expect(listMcpCandidates().find((candidate) => candidate.name === 'mica-plugin-demo')).toEqual({
      name: 'mica-plugin-demo', type: 'http', url: 'http://127.0.0.1:9099/plugin/demo/mcp',
      description: '示例插件', tools: [], source: { kind: 'plugin', label: '插件 demo', detail: 'demo' }
    })
    enabled = false
    expect(pluginMcpCandidates(process.env.MICA_DESKTOP_ORIGIN)).toEqual([])
    expect(buildPluginMcpServers({ origin: process.env.MICA_DESKTOP_ORIGIN })).toEqual({})
  })
})
