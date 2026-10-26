import { describe, expect, it } from 'bun:test'
import {
  TERMINAL_OWNER_ENV,
  TERMINAL_URL_ENV,
  normalizeTerminalSummaries,
  parseTerminalSseData,
  sameTerminalSessions,
  terminalDetailsFrom,
  terminalOwnerEnv
} from './terminal-control-core.js'

describe('normalizeTerminalSummaries', () => {
  it('keeps the fields the UI uses and defaults the rest', () => {
    const [session] = normalizeTerminalSummaries([
      {
        id: 'term-1',
        owner: 'sess-1',
        label: '构建',
        cwd: '/tmp',
        shell: '/bin/zsh',
        cols: 120,
        rows: 32,
        running: false,
        exitCode: 0,
        windowVisible: true
      },
      { id: '' },
      null
    ])
    expect(session).toMatchObject({
      id: 'term-1',
      owner: 'sess-1',
      label: '构建',
      cwd: '/tmp',
      cols: 120,
      rows: 32,
      running: false,
      exitCode: 0,
      windowVisible: true,
      truncated: false
    })
  })

  it('treats a missing running flag as running', () => {
    const [session] = normalizeTerminalSummaries([{ id: 'term-2' }])
    expect(session.running).toBe(true)
    expect(session.exitCode).toBe(null)
  })
})

describe('sse and owner', () => {
  it('parses the shared frame shape', () => {
    expect(
      parseTerminalSseData('data: {"channel":"terminal:output","payload":{"session":"term-1"}}')
    ).toEqual({ channel: 'terminal:output', payload: { session: 'term-1' } })
    expect(parseTerminalSseData('data: not json')).toBe(null)
    expect(parseTerminalSseData(': ping')).toBe(null)
  })

  it('injects the owner env only when there is an owner', () => {
    expect(terminalOwnerEnv('sess-1')).toEqual({ [TERMINAL_OWNER_ENV]: 'sess-1' })
    expect(terminalOwnerEnv('')).toEqual({})
    expect(terminalOwnerEnv(null)).toEqual({})
  })

  it('compares session snapshots structurally', () => {
    expect(sameTerminalSessions([{ id: 'a' }], [{ id: 'a' }])).toBe(true)
    expect(sameTerminalSessions([{ id: 'a' }], [{ id: 'b' }])).toBe(false)
  })
})

describe('terminalDetailsFrom', () => {
  it('marks availability from the service url', () => {
    const details = terminalDetailsFrom({
      docs: { version: 1, endpoints: [{ id: 'health' }], markdown: '# docs' },
      sessions: [{ id: 'term-1' }],
      serviceUrl: 'http://127.0.0.1:8787/remote/terminal',
      mcpUrl: 'http://127.0.0.1:8787/mcp/terminal'
    })
    expect(details).toMatchObject({
      available: true,
      version: 1,
      mcpUrl: 'http://127.0.0.1:8787/mcp/terminal',
      toolName: 'control',
      envVars: { url: TERMINAL_URL_ENV, owner: TERMINAL_OWNER_ENV }
    })
    expect(details.sessions).toHaveLength(1)
    expect(details.markdown).toBe('# docs')
    expect(
      terminalDetailsFrom({ docs: null, sessions: [], serviceUrl: '', mcpUrl: '' }).available
    ).toBe(false)
  })
})
