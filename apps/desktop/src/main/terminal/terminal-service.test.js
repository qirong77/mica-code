import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { notFoundError } from './terminal-core.js'
import { TERMINAL_ENDPOINTS } from './terminal-docs.js'
import { createTerminalService } from './terminal-service.js'

/** 假会话层：只记账，不启动真实 pty（真实 pty 需要 Electron 的 native binding） */
function createFakeSessions() {
  const sessions = new Map()
  const calls = []

  const summary = (session) => ({
    id: session.id,
    owner: session.owner || null,
    label: session.label || '终端',
    cwd: session.cwd || '/tmp',
    shell: session.shell || '/bin/zsh',
    cols: session.cols || 120,
    rows: session.rows || 32,
    createdAt: session.createdAt || '2026-01-01T00:00:00.000Z',
    updatedAt: session.updatedAt || '2026-01-01T00:00:00.000Z',
    running: !session.exited,
    exitCode: session.exitCode ?? null,
    signal: session.signal ?? null,
    windowVisible: Boolean(session.windowVisible),
    outputSeq: session.output?.seq || 0,
    truncated: Boolean(session.output?.truncated)
  })

  return {
    calls,
    summary,
    async create(options = {}) {
      const session = {
        id: 'term-1',
        owner: options.owner || null,
        label: options.label || '终端',
        cwd: options.cwd || '/tmp',
        shell: options.shell || '/bin/zsh',
        cols: options.cols || 120,
        rows: options.rows || 32,
        exited: false,
        output: { seq: 5, data: '$ ls', truncated: false }
      }
      sessions.set(session.id, session)
      calls.push(['create', options])
      return session
    },
    list: ({ owner } = {}) =>
      [...sessions.values()].filter((session) => !owner || session.owner === owner).map(summary),
    get(id) {
      const session = sessions.get(String(id || ''))
      if (!session) throw notFoundError(`没有这个终端会话：${id}`)
      return session
    },
    async detail(id) {
      const session = this.get(id)
      return {
        ...summary(session),
        screen: {
          text: '$ ',
          lines: ['$ '],
          cursor: { x: 2, y: 0, absoluteY: 0 },
          inputLine: '$ ',
          cols: session.cols,
          rows: session.rows
        }
      }
    },
    write(id, body) {
      const session = this.get(id)
      if (session.exited) throw new Error('终端进程已退出')
      calls.push(['write', id, body])
      return { seq: session.output.seq }
    },
    keys(id, keys) {
      this.get(id)
      calls.push(['keys', id, keys])
      return { seq: 5 }
    },
    async resize(id, body) {
      const session = this.get(id)
      calls.push(['resize', id, body])
      return { ...summary(session), screen: { text: '$ ' } }
    },
    readOutput(id, { since } = {}) {
      const session = this.get(id)
      return { seq: session.output.seq, data: session.output.data, truncated: false, since }
    },
    async waitFor(id, body) {
      this.get(id)
      calls.push(['wait', id, body])
      return { matched: true, reason: 'idle', elapsedMs: 12, screen: { text: '$ ' } }
    },
    setWindowVisible() {},
    close(id) {
      this.get(id)
      sessions.delete(id)
      calls.push(['close', id])
      return { closed: id }
    }
  }
}

function createFakeWindows() {
  const calls = []
  return {
    calls,
    ensure(session, options) {
      calls.push(['ensure', session.id, options])
      return { sessionId: session.id }
    },
    show(id) {
      calls.push(['show', id])
    },
    hide(id) {
      calls.push(['hide', id])
    },
    destroy(id) {
      calls.push(['destroy', id])
    }
  }
}

let sessions = null
let windows = null
let service = null
let base = ''

beforeAll(async () => {
  sessions = createFakeSessions()
  windows = createFakeWindows()
  service = createTerminalService({
    sessions,
    windows,
    address: () => ({ url: 'http://127.0.0.1:18767' })
  })
  const port = await service.listen(0)
  base = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await service.close()
})

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

describe('service surface', () => {
  it('answers health, capabilities and docs from the same endpoint catalog', async () => {
    expect((await call('/health')).body).toMatchObject({
      ok: true,
      app: 'mica-code-terminal'
    })
    const capabilities = await call('/capabilities')
    expect(capabilities.body.endpoints).toHaveLength(TERMINAL_ENDPOINTS.length)
    const docs = await call('/docs')
    expect(docs.body.endpoints).toHaveLength(TERMINAL_ENDPOINTS.length)
    expect(docs.body.markdown).toContain('http://127.0.0.1:18767')
    expect(docs.body.markdown).toContain('x-mica-owner')
    // 技能只给占位符，运行时写盘前才换成真实地址（terminal-control.js）
    expect(docs.body.skillMarkdown).toContain('$MICA_TERMINAL_URL')
  })

  it('creates a session with owner from the header and opens the window', async () => {
    const created = await call('/sessions', {
      method: 'POST',
      headers: { 'x-mica-owner': 'sess-1' },
      body: { cwd: '/tmp', label: '构建', show: true }
    })
    expect(created.status).toBe(200)
    expect(created.body.session).toMatchObject({ id: 'term-1', owner: 'sess-1', label: '构建' })
    expect(windows.calls.at(-1)).toEqual(['ensure', 'term-1', { show: true, focus: true }])
    expect(sessions.calls.find((item) => item[0] === 'create')[1]).toMatchObject({
      owner: 'sess-1',
      cwd: '/tmp',
      label: '构建'
    })
  })

  it('lists, reads the screen and forwards input', async () => {
    const list = await call('/sessions?owner=sess-1')
    expect(list.body.sessions).toHaveLength(1)
    expect(list.body.sessions[0]).toMatchObject({ id: 'term-1', cwd: '/tmp', running: true })

    const detail = await call('/sessions/term-1?maxLines=50')
    expect(detail.body.session.screen.text).toBe('$ ')

    const input = await call('/sessions/term-1/input', {
      method: 'POST',
      body: { text: 'git status', submit: true }
    })
    expect(input.body.seq).toBe(5)
    expect(sessions.calls.at(-1)).toEqual(['write', 'term-1', { text: 'git status', submit: true }])

    const keys = await call('/sessions/term-1/keys', {
      method: 'POST',
      body: { keys: ['ctrl+c'] }
    })
    expect(keys.body.ok).toBe(true)
    expect(sessions.calls.at(-1)).toEqual(['keys', 'term-1', ['ctrl+c']])
  })

  it('waits with the requested condition', async () => {
    const waited = await call('/sessions/term-1/wait', {
      method: 'POST',
      body: { idleMs: 400 }
    })
    expect(waited.body).toMatchObject({ ok: true, matched: true, reason: 'idle' })
    expect(sessions.calls.at(-1)).toEqual(['wait', 'term-1', { idleMs: 400 }])
  })

  it('hides, shows and closes a session through the window layer', async () => {
    await call('/sessions/term-1/hide', { method: 'POST', body: {} })
    expect(windows.calls.at(-1)).toEqual(['hide', 'term-1'])
    await call('/sessions/term-1/show', { method: 'POST', body: {} })
    expect(windows.calls.at(-1)).toEqual(['ensure', 'term-1', { show: true, focus: true }])
    const closed = await call('/sessions/term-1/close', { method: 'POST', body: {} })
    expect(closed.body).toEqual({ ok: true, closed: 'term-1' })
    expect(windows.calls.at(-1)).toEqual(['destroy', 'term-1'])
    expect((await call('/sessions/term-1')).status).toBe(404)
  })

  it('returns every session-shaped response under the same envelope', async () => {
    const created = await call('/sessions', { method: 'POST', body: { cwd: '/tmp' } })
    for (const [path, body] of [
      ['/sessions', { cwd: '/tmp' }],
      ['/sessions/term-1/resize', { cols: 90, rows: 30 }],
      ['/sessions/term-1/show', {}],
      ['/sessions/term-1/hide', {}]
    ]) {
      const response = await call(path, { method: 'POST', body })
      expect(response.status).toBe(200)
      expect(response.body.session?.id).toBe('term-1')
    }
    expect(created.body.session?.id).toBe('term-1')
    expect((await call('/sessions/term-1')).body.session?.id).toBe('term-1')
  })

  it('rejects unknown endpoints, non-JSON bodies and unsafe methods', async () => {
    expect((await call('/nope')).status).toBe(404)
    expect((await call('/sessions', { method: 'DELETE' })).status).toBe(404)
    const wrongType = await call('/sessions', {
      method: 'POST',
      body: 'cwd=/tmp',
      headers: { 'content-type': 'text/plain' }
    })
    expect(wrongType.status).toBe(415)
  })

  it('replays buffered output when an SSE client connects', async () => {
    // 重新建一个会话，供 SSE 读取
    await call('/sessions', { method: 'POST', body: { cwd: '/tmp' } })
    const response = await fetch(`${base}/events?session=term-1&since=0`)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body.getReader()
    const { value } = await reader.read()
    const first = new TextDecoder().decode(value)
    expect(first).toContain('terminal:output')
    expect(first).toContain('$ ls')
    await reader.cancel()
  })

  it('does not push state changes of one session to a page watching another', async () => {
    await call('/sessions', { method: 'POST', body: { cwd: '/tmp' } })
    await call('/sessions', { method: 'POST', body: { cwd: '/tmp' } })

    // 只订阅 term-2 的页面：term-1 的状态变化不该打扰它
    const response = await fetch(`${base}/events?session=term-2&since=0`)
    const reader = response.body.getReader()
    await reader.read()

    service.onSessionEvent({
      type: 'changed',
      session: { id: 'term-1' },
      summary: { id: 'term-1', cols: 200, rows: 50 }
    })
    service.onSessionEvent({
      type: 'changed',
      session: { id: 'term-2' },
      summary: { id: 'term-2', cols: 120, rows: 32 }
    })

    const { value } = await reader.read()
    const frames = new TextDecoder()
      .decode(value)
      .split('\n\n')
      .filter((chunk) => chunk.includes('terminal:changed'))
    expect(frames).toHaveLength(1)
    expect(frames[0]).toContain('term-2')
    expect(frames[0]).not.toContain('term-1')
    await reader.cancel()
  })

  it('destroys the window when a session is closed outside the endpoint', () => {
    // 空闲回收直接调 sessions.close：不在这里销毁会留下指向已删除会话的孤儿窗口
    service.onSessionEvent({
      type: 'closed',
      session: { id: 'term-9' },
      summary: { id: 'term-9' }
    })
    expect(windows.calls).toContainEqual(['destroy', 'term-9'])
  })
})

describe('owner guard', () => {
  let ownedSessions = null
  let ownedWindows = null
  let ownedService = null
  let ownedBase = ''

  beforeAll(async () => {
    ownedSessions = createFakeSessions()
    ownedWindows = createFakeWindows()
    ownedService = createTerminalService({
      sessions: ownedSessions,
      windows: ownedWindows,
      address: () => ({ url: 'http://127.0.0.1:18768' })
    })
    const port = await ownedService.listen(0)
    ownedBase = `http://127.0.0.1:${port}`
    await fetch(`${ownedBase}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mica-owner': 'chat-a' },
      body: JSON.stringify({ cwd: '/tmp' })
    })
  })

  afterAll(async () => {
    await ownedService.close()
  })

  async function post(path, body, headers = {}) {
    const response = await fetch(`${ownedBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body)
    })
    return { status: response.status, body: JSON.parse(await response.text()) }
  }

  it('refuses writes from another chat session', async () => {
    const before = ownedSessions.calls.length
    const payloads = [
      ['/input', { text: 'rm -rf /tmp/x' }],
      ['/keys', { keys: ['Enter'] }],
      ['/resize', { cols: 90 }]
    ]
    for (const [path, body] of payloads) {
      const denied = await post(`/sessions/term-1${path}`, body, {
        'x-mica-owner': 'chat-b'
      })
      expect(denied.status).toBe(403)
      expect(denied.body.ok).toBe(false)
    }
    const deniedClose = await post('/sessions/term-1/close', {}, { 'x-mica-owner': 'chat-b' })
    expect(deniedClose.status).toBe(403)
    // 被拒的请求一次都没有落到会话层
    expect(ownedSessions.calls.length).toBe(before)
    expect(ownedWindows.calls.filter((item) => item[0] === 'destroy')).toHaveLength(0)
  })

  it('allows the owner and the human (no owner header) to type', async () => {
    const own = await post(
      '/sessions/term-1/input',
      { text: 'ls' },
      {
        'x-mica-owner': 'chat-a'
      }
    )
    expect(own.status).toBe(200)
    const human = await post('/sessions/term-1/input', { text: 'ls' })
    expect(human.status).toBe(200)
    const list = await fetch(`${ownedBase}/sessions?owner=chat-b`)
    expect((await list.json()).sessions).toHaveLength(0)
  })

  it('keeps the window lazy when show is not requested', async () => {
    const opened = ownedWindows.calls.filter((item) => item[0] === 'ensure').length
    await post('/sessions', { cwd: '/tmp', label: '后台任务' })
    // 只跑 PTY、不建渲染进程：一个窗口上百 MB，AI 起的终端大多只用来跑命令
    expect(ownedWindows.calls.filter((item) => item[0] === 'ensure').length).toBe(opened)
    await post('/sessions/term-1/show', {})
    expect(ownedWindows.calls.at(-1)).toEqual(['ensure', 'term-1', { show: true, focus: true }])
  })
})
