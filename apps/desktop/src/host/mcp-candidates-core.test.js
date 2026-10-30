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

    // 纯 Web 宿主没有浏览器 / 终端 socket，所以这里只有配置里那两个
    expect(listMcpCandidates()).toEqual([
      {
        name: 'mica-terminal',
        type: 'http',
        tools: [],
        source: { kind: 'config', label: 'config.json', detail: join(home, 'config.json') }
      },
      {
        name: 'sequential-thinking',
        type: 'stdio',
        tools: [],
        source: { kind: 'config', label: 'config.json', detail: join(home, 'config.json') }
      }
    ])
  })

  it('lists the built-in control servers without any user config', () => {
    const previous = {
      browser: process.env.MICA_BROWSER_SOCKET,
      terminal: process.env.MICA_TERMINAL_SOCKET,
      origin: process.env.MICA_DESKTOP_ORIGIN
    }
    process.env.MICA_BROWSER_SOCKET = '/tmp/mica-browser.sock'
    process.env.MICA_TERMINAL_SOCKET = '/tmp/mica-terminal.sock'
    process.env.MICA_DESKTOP_ORIGIN = 'http://127.0.0.1:8787'
    try {
      // 没有 config.json 也要列出来：内置能力不该要求用户抄一份配置
      expect(listMcpCandidates()).toEqual([
        {
          name: 'mica-browser',
          type: 'http',
          tools: ['control'],
          source: { kind: 'builtin', label: '内置' },
          url: 'http://127.0.0.1:8787/mcp/browser'
        },
        {
          name: 'mica-terminal',
          type: 'http',
          tools: ['control'],
          source: { kind: 'builtin', label: '内置' },
          url: 'http://127.0.0.1:8787/mcp/terminal'
        }
      ])

      // 用户自己抄一份同名的：内置的那份带 owner 头，仍然以它为准
      writeConfig({ 'mica-browser': { type: 'http', url: 'http://127.0.0.1:1/mcp/x' } })
      expect(listMcpCandidates().filter((server) => server.name === 'mica-browser')).toHaveLength(1)
      expect(listMcpCandidates()[0].url).toBe('http://127.0.0.1:8787/mcp/browser')
    } finally {
      for (const [key, value] of [
        ['MICA_BROWSER_SOCKET', previous.browser],
        ['MICA_TERMINAL_SOCKET', previous.terminal],
        ['MICA_DESKTOP_ORIGIN', previous.origin]
      ]) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
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
