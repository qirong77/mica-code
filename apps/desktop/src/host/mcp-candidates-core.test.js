import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createControlMcpHandler } from './control-mcp.js'
import { listMcpCandidates } from './mcp-candidates-core.js'
import { clearMcpProbeCache, probeMcpServers } from './mcp-probe.js'

const previousHome = process.env.MICA_HOME
let base
let home

function writeConfig(mcpServers) {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ mcpServers }, null, 2), 'utf-8')
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mica-mcp-candidates-'))
  home = join(base, 'home')
  mkdirSync(home, { recursive: true })
  process.env.MICA_HOME = home
})

afterEach(() => {
  clearMcpProbeCache()
  if (previousHome === undefined) delete process.env.MICA_HOME
  else process.env.MICA_HOME = previousHome
  if (base && existsSync(base)) rmSync(base, { recursive: true, force: true })
})

describe('composer MCP candidates', () => {
  it('lists every configured server by name without connecting', () => {
    writeConfig({
      'mica-terminal': { type: 'http', url: 'http://127.0.0.1:1/mcp/terminal' },
      'sequential-thinking': { command: 'npx', args: ['-y', 'server'] }
    })

    expect(listMcpCandidates()).toEqual([
      { name: 'mica-terminal', type: 'http', tools: [] },
      { name: 'sequential-thinking', type: 'stdio', tools: [] }
    ])
  })

  it('returns nothing when the config file is missing or broken', () => {
    expect(listMcpCandidates()).toEqual([])

    writeFileSync(join(home, 'config.json'), '{ not json', 'utf-8')
    expect(listMcpCandidates()).toEqual([])
  })

  it('carries the cached tool names once the same config has been probed', async () => {
    const handler = createControlMcpHandler({
      kind: 'mica-browser',
      title: '受控浏览器',
      usage: '驱动浏览器',
      socketPath: '/nonexistent.sock',
      label: '受控浏览器服务',
      loadCatalog: async () => ({
        endpoints: [
          {
            id: 'health',
            method: 'GET',
            path: '/browser/health',
            summary: '探活',
            params: [],
            returns: '{}'
          }
        ],
        guide: ''
      })
    })
    const server = createServer((req, res) => {
      if (req.url === '/mcp/browser') return void handler(req, res)
      res.writeHead(404).end()
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    const config = { type: 'http', url: `http://127.0.0.1:${port}/mcp/browser` }
    writeConfig({ 'mica-browser': config })

    try {
      // 未探过：只有名字
      expect(listMcpCandidates()[0].tools).toEqual([])

      await probeMcpServers({ 'mica-browser': config })

      // 探过之后候选里带上真实工具名（输入框插入文本会用到）
      expect(listMcpCandidates()[0].tools).toEqual(['control'])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
