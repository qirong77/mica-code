import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  availableControlKinds,
  buildControlMcpServers,
  controlMcpConfigPath,
  controlMcpUrl,
  legacySkillPath,
  removeLegacyControlSkills,
  writeControlMcpConfig
} from './control-mcp-config.js'

describe('controlMcpUrl', () => {
  it('hangs the mcp endpoint off the runtime origin', () => {
    expect(controlMcpUrl('http://127.0.0.1:8787', 'browser')).toBe(
      'http://127.0.0.1:8787/mcp/browser'
    )
    expect(controlMcpUrl('http://127.0.0.1:8787///', 'terminal')).toBe(
      'http://127.0.0.1:8787/mcp/terminal'
    )
    expect(controlMcpUrl('', 'browser')).toBe('')
  })
})

describe('buildControlMcpServers', () => {
  it('registers one http server per available capability with the owner header', () => {
    const servers = buildControlMcpServers({
      origin: 'http://127.0.0.1:8787',
      owner: 'sess-1',
      kinds: ['browser', 'terminal']
    })
    expect(Object.keys(servers)).toEqual(['mica-browser', 'mica-terminal'])
    expect(servers['mica-browser']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:8787/mcp/browser',
      headers: { 'x-mica-owner': 'sess-1' }
    })
  })

  it('omits the header when there is no owner and skips unknown kinds', () => {
    const servers = buildControlMcpServers({
      origin: 'http://127.0.0.1:8787',
      owner: '',
      kinds: ['browser', 'nope']
    })
    expect(servers['mica-browser'].headers).toBeUndefined()
    expect(servers.nope).toBeUndefined()
  })
})

describe('availableControlKinds', () => {
  it('follows the sockets the Electron main process handed to the runtime', () => {
    expect(availableControlKinds({ MICA_BROWSER_SOCKET: '/tmp/a.sock' })).toEqual(['browser'])
    expect(
      availableControlKinds({
        MICA_BROWSER_SOCKET: '/tmp/a.sock',
        MICA_TERMINAL_SOCKET: '/tmp/b.sock'
      })
    ).toEqual(['browser', 'terminal'])
    // 纯 Web 宿主两个都没有：调用方因此不会传 --mcp-config
    expect(availableControlKinds({})).toEqual([])
  })
})

describe('writeControlMcpConfig', () => {
  it('writes one file per owner and returns its path', () => {
    const home = mkdtempSync(join(tmpdir(), 'mica-home-'))
    const path = writeControlMcpConfig({
      homeDir: home,
      origin: 'http://127.0.0.1:8787',
      owner: 'sess-1',
      kinds: ['browser']
    })
    expect(path).toBe(controlMcpConfigPath(home, 'sess-1'))
    expect(path.startsWith(home)).toBe(true)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.mcpServers['mica-browser'].headers).toEqual({ 'x-mica-owner': 'sess-1' })
  })

  // owner 里可能带 `/`（页签 id）：文件名必须安全，内容里仍是原值
  it('hashes unsafe owner ids but keeps the raw value in the header', () => {
    const home = mkdtempSync(join(tmpdir(), 'mica-home-'))
    const path = writeControlMcpConfig({
      homeDir: home,
      origin: 'http://127.0.0.1:8787',
      owner: 'draft/1 2',
      kinds: ['terminal']
    })
    expect(path.includes('draft')).toBe(false)
    const written = JSON.parse(readFileSync(path, 'utf8'))
    expect(written.mcpServers['mica-terminal'].headers['x-mica-owner']).toBe('draft/1 2')
  })

  it('writes nothing without an owner, an origin or any capability', () => {
    const home = mkdtempSync(join(tmpdir(), 'mica-home-'))
    expect(
      writeControlMcpConfig({
        homeDir: home,
        origin: 'http://127.0.0.1:8787',
        owner: '',
        kinds: ['browser']
      })
    ).toBe(null)
    expect(
      writeControlMcpConfig({ homeDir: home, origin: '', owner: 'sess-1', kinds: ['browser'] })
    ).toBe(null)
    expect(
      writeControlMcpConfig({
        homeDir: home,
        origin: 'http://127.0.0.1:8787',
        owner: 'sess-1',
        kinds: []
      })
    ).toBe(null)
  })
})

describe('removeLegacyControlSkills', () => {
  function writeSkill(home, name, text) {
    const path = legacySkillPath(home, name)
    mkdirSync(join(home, 'skills', name), { recursive: true })
    writeFileSync(path, text, 'utf8')
    return path
  }

  it('removes the generated skill documents now that the capability is an MCP server', () => {
    const home = mkdtempSync(join(tmpdir(), 'mica-home-'))
    const browser = writeSkill(
      home,
      'mica-browser',
      '---\nname: mica-browser\n---\n\nhttp://127.0.0.1:8787/remote/control\n'
    )
    const terminal = writeSkill(
      home,
      'mica-terminal',
      '---\nname: mica-terminal\n---\n\n$MICA_TERMINAL_URL\n'
    )

    const removed = removeLegacyControlSkills({ homeDir: home })
    expect(removed.sort()).toEqual([browser, terminal].sort())
    expect(existsSync(browser)).toBe(false)
    expect(existsSync(join(home, 'skills', 'mica-browser'))).toBe(false)
  })

  // 用户自己改过的技能不是我们写的，删掉等于删人家的内容
  it('leaves a hand-edited skill document alone', () => {
    const home = mkdtempSync(join(tmpdir(), 'mica-home-'))
    const path = writeSkill(
      home,
      'mica-browser',
      '---\nname: mica-browser\n---\n\n# 我自己的笔记\n先打开登录页。\n'
    )
    expect(removeLegacyControlSkills({ homeDir: home })).toEqual([])
    expect(existsSync(path)).toBe(true)
  })

  it('tolerates a home directory with no skills at all', () => {
    const home = mkdtempSync(join(tmpdir(), 'mica-home-'))
    expect(removeLegacyControlSkills({ homeDir: home })).toEqual([])
  })
})
