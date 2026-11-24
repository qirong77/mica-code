import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createPluginHostApi } from './plugin-host.js'
import { readFileSync } from 'node:fs'

const originalWindow = globalThis.window
const originalFetch = globalThis.fetch
let calls
let snapshot
let result

beforeEach(() => {
  calls = []
  snapshot = { value: { text: '正文' }, version: 'current-version' }
  result = { ok: true }
  globalThis.window = {
    mica: {
      pluginHost: {
        readData: async (...args) => {
          calls.push(['read', ...args])
          return snapshot
        },
        dataVersion: async (...args) => {
          calls.push(['version', ...args])
          return snapshot
        },
        writeData: async (...args) => {
          calls.push(['write', ...args])
          return result
        }
      }
    }
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
})

describe('plugin host read-only web API', () => {
  test('uses a fixed same-origin credentialed GET and forwards the caller signal', async () => {
    const requests = []
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options })
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { count: 3 } }) }
    }
    const controller = new AbortController()
    const result = await createPluginHostApi('sample').web.read(
      'summary',
      { filter: 'a & b' },
      { signal: controller.signal, url: 'https://other.invalid' }
    )
    expect(result).toEqual({ count: 3 })
    expect(requests).toEqual([
      {
        url: '/plugins/sample/api/summary?filter=a+%26+b',
        options: {
          method: 'GET',
          credentials: 'same-origin',
          mode: 'same-origin',
          redirect: 'error',
          cache: 'no-store',
          headers: { accept: 'application/json' },
          signal: controller.signal
        }
      }
    ])
  })

  test('rejects arbitrary query URLs and invalid or unbounded params without fetching', async () => {
    let fetched = 0
    globalThis.fetch = async () => {
      fetched += 1
      throw new Error('must-not-fetch')
    }
    const api = createPluginHostApi('sample').web
    for (const query of [
      '',
      'https://other.invalid',
      '../secret',
      'summary?channel=x',
      '__proto__',
      'a'.repeat(65)
    ])
      await expect(api.read(query)).rejects.toThrow()
    for (const params of [
      null,
      [],
      { count: 3 },
      { text: 'x'.repeat(2049) },
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, '1']))
    ]) {
      await expect(api.read('summary', params)).rejects.toThrow()
    }
    expect(fetched).toBe(0)
  })

  test('rejects HTTP and structured server errors instead of returning successful-looking empty data', async () => {
    const api = createPluginHostApi('sample').web
    globalThis.fetch = async () => ({
      ok: false,
      status: 504,
      json: async () => ({ ok: false, code: 'timeout', error: '查询超时' })
    })
    await expect(api.read('summary')).rejects.toMatchObject({
      message: '查询超时',
      status: 504,
      code: 'timeout'
    })
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: '查询失败' })
    })
    await expect(api.read('summary')).rejects.toThrow('查询失败')
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
    await expect(api.read('summary')).rejects.toThrow('响应无效')
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('HTML')
      }
    })
    await expect(api.read('summary')).rejects.toThrow('响应无效')
  })

  test('preserves AbortError when cancellation happens while reading the JSON body', async () => {
    const controller = new AbortController()
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        controller.abort(new DOMException('cancelled', 'AbortError'))
        throw controller.signal.reason
      }
    })
    await expect(
      createPluginHostApi('sample').web.read('summary', {}, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  test('uses the manifest route for page URLs/search and checks exact standalone page declarations', () => {
    const page = readFileSync(new URL('./PluginPage.jsx', import.meta.url), 'utf8')
    const standalone = readFileSync(new URL('./PluginPageWindow.jsx', import.meta.url), 'utf8')
    expect(page).toContain('pluginPagePath(entry.id, entry.page.route)')
    expect(page).toContain('`${pagePath}${next}`')
    expect(standalone).toContain(
      'matchesPluginPagePath(window.location.pathname, pluginId, plugin.desktopPage?.route)'
    )
    expect(standalone).toContain("plugin?.state !== 'enabled'")
    expect(standalone).toContain('!(plugin.desktopPage || plugin.desktopLauncher)')
  })
})

describe('plugin host local data API', () => {
  test('forwards only the explicit document key and cached read version', async () => {
    const api = createPluginHostApi('sample')
    snapshot = { unchanged: true, version: 'existing' }
    expect(await api.documents.read('page', { ifVersion: 'existing', key: 'other', pluginId: 'other' })).toEqual(snapshot)
    expect(calls).toEqual([['read', 'sample', { key: 'page', ifVersion: 'existing' }]])
  })

  test('binds version requests to the plugin and document key, returning only the version', async () => {
    const api = createPluginHostApi('sample')
    expect(await api.documents.version('page')).toEqual({ version: 'current-version' })
    snapshot = { version: null, value: 'must not leak' }
    expect(await api.documents.version('missing')).toEqual({ version: null })
    expect(calls).toEqual([
      ['version', 'sample', { key: 'page' }],
      ['version', 'sample', { key: 'missing' }]
    ])
  })

  test('propagates version query errors and rejects malformed responses instead of assuming unchanged', async () => {
    const api = createPluginHostApi('sample')
    for (const invalid of [null, {}, { version: undefined }, { version: 42 }, { ok: false, error: 'read failed' }]) {
      snapshot = invalid
      await expect(api.documents.version('page')).rejects.toThrow('版本响应无效')
    }
    window.mica.pluginHost.dataVersion = async () => {
      throw new Error('插件文档 JSON 损坏')
    }
    await expect(api.documents.version('page')).rejects.toThrow('JSON 损坏')
  })

  test('preserves config reads and writes without a document key', async () => {
    const api = createPluginHostApi('sample')
    const value = { tree: [] }
    const options = { expectedVersion: 'config-version' }
    expect(await api.readData()).toBe(snapshot)
    expect(await api.writeData(value, options)).toBe(result)
    expect(await api.writeData(value)).toBe(result)
    expect(calls).toEqual([
      ['read', 'sample'],
      ['write', 'sample', value, options],
      ['write', 'sample', value, undefined]
    ])
  })

  test('routes document reads and writes through existing host channels with an explicit key', async () => {
    const api = createPluginHostApi('sample')
    const key = '92de9c14-5a20-4a55-9c4f-3910d941057a'
    const value = { text: 'new body' }
    const options = { expectedVersion: null }
    expect(await api.documents.read(key)).toBe(snapshot)
    expect(await api.documents.write(key, value, options)).toBe(result)
    expect(options).toEqual({ expectedVersion: null })
    expect(await api.documents.write(key, value)).toBe(result)
    expect(calls).toEqual([
      ['read', 'sample', { key }],
      ['write', 'sample', value, { expectedVersion: null, key }],
      ['write', 'sample', value, { key }]
    ])
  })

  test('binds document requests to this plugin and keeps the explicit key over options', async () => {
    const api = createPluginHostApi('sample')
    await api.documents.write('page', 'body', {
      key: 'other',
      pluginId: 'other-plugin',
      value: 'other-body',
      expectedVersion: 'version'
    })
    expect(calls).toEqual([
      ['write', 'sample', 'body', { key: 'page', expectedVersion: 'version' }]
    ])
  })

  test('rejects keys that JSON would omit rather than targeting the config file', async () => {
    const api = createPluginHostApi('sample')
    for (const key of ['', undefined, null, 42, () => {}]) {
      await expect(api.documents.read(key)).rejects.toThrow('key')
      await expect(api.documents.version(key)).rejects.toThrow('key')
      await expect(api.documents.write(key, 'body')).rejects.toThrow('key')
    }
    expect(calls).toEqual([])
  })

  test('passes CAS conflicts through and propagates document read failures', async () => {
    const api = createPluginHostApi('sample')
    result = { ok: false, conflict: true, error: '插件数据已更新' }
    expect(await api.documents.write('page', 'body', { expectedVersion: 'stale' })).toBe(result)
    window.mica.pluginHost.readData = async () => {
      throw new Error('插件文档 JSON 损坏')
    }
    await expect(api.documents.read('page')).rejects.toThrow('JSON 损坏')
  })
})

describe('plugin host cross-session chat API', () => {
  const hostWith = ({ sessions = [], history = [], start } = {}) => {
    globalThis.window.mica.stats = { listSessions: async () => ({ sessions }) }
    globalThis.window.mica.chat = {
      history: async () => history,
      start: start || (async () => ({ ok: true }))
    }
    return createPluginHostApi('sample')
  }

  test('is unavailable when the host has no session channels', () => {
    expect(createPluginHostApi('sample').sessions).toBeNull()
  })

  test('lists sessions with only the fields a picker needs', async () => {
    const api = hostWith({
      sessions: [
        {
          id: 'a',
          title: '会话 A',
          cwd: '/repo',
          updatedAt: '2026-11-01T00:00:00.000Z',
          tokens: 999
        },
        { id: 'b', title: null, cwd: null }
      ]
    })
    expect(await api.sessions.list({ limit: 1 })).toEqual([
      { id: 'a', title: '会话 A', cwd: '/repo', updatedAt: '2026-11-01T00:00:00.000Z' }
    ])
    expect(await api.sessions.list()).toEqual([
      { id: 'a', title: '会话 A', cwd: '/repo', updatedAt: '2026-11-01T00:00:00.000Z' },
      { id: 'b', title: '未命名会话', cwd: null, updatedAt: null }
    ])
  })

  test('keeps only dialogue rows and drops empty bodies', async () => {
    const api = hostWith({
      history: [
        { role: 'user', text: '你好' },
        { role: 'assistant', text: '在' },
        { role: 'notice', text: '已压缩' },
        { role: 'assistant', kind: 'reasoning', text: '思考过程' },
        { role: 'assistant', text: '' }
      ]
    })
    expect(await api.sessions.history('s1')).toEqual([
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '在' }
    ])
    expect(await api.sessions.history('')).toEqual([])
  })

  test('sends the prompt verbatim into that session', async () => {
    const starts = []
    const api = hostWith({
      start: async (payload) => {
        starts.push(payload)
        return { ok: true }
      }
    })
    const prompt = '# 标题\n\n正文，不改一个字。'
    expect(await api.sessions.send({ sessionId: 's1', cwd: '/repo', prompt })).toEqual({ ok: true })
    expect(starts).toEqual([{ id: 's1', sessionId: 's1', cwd: '/repo', prompt, maxTurns: 9999 }])
    await expect(api.sessions.send({ prompt })).rejects.toThrow('请先选择一条会话')
    await expect(api.sessions.send({ sessionId: 's1', prompt: '   ' })).rejects.toThrow(
      '消息内容为空'
    )
  })

  test('creates a fresh draft and routes its first message through the draft node', async () => {
    const starts = []
    hostWith({
      start: async (payload) => {
        starts.push(payload)
        return { ok: true }
      }
    })
    const api = createPluginHostApi('sample', null, {
      createSession: async () => ({ id: 'draft-1', cwd: null })
    })
    expect(await api.sessions.create()).toMatchObject({ id: 'draft-1', title: '新对话' })
    expect(await api.sessions.history('draft-1')).toEqual([])
    await api.sessions.send({ sessionId: 'draft-1', prompt: '直接发送' })
    expect(starts).toEqual([
      {
        id: 'draft-1',
        sessionId: null,
        cwd: null,
        prompt: '直接发送',
        maxTurns: 9999
      }
    ])
  })

  test('creates standalone drafts and exposes explicit node/session binding helpers', async () => {
    hostWith()
    const api = createPluginHostApi('sample')
    const draft = await api.sessions.create({ cwd: '/standalone' })
    expect(draft.id).toMatch(/^plugin-sample-/)
    expect(draft.cwd).toBe('/standalone')
    expect(api.sessions.bind({ nodeId: draft.id, sessionId: 'real-1' })).toEqual({
      nodeId: draft.id,
      sessionId: 'real-1'
    })
    expect(await api.sessions.resolve('real-1')).toEqual({ sessionId: 'real-1', nodeId: draft.id })
    expect(await api.sessions.attach({ sessionId: 'real-1' })).toEqual({
      nodeId: draft.id,
      sessionId: 'real-1'
    })
  })

  test('binding updates draft reads and notifies the workspace owner', async () => {
    hostWith()
    const bindings = []
    const api = createPluginHostApi('sample', null, {
      createSession: async () => ({ id: 'draft-bound' }),
      bindSession: (...args) => bindings.push(args)
    })
    await api.sessions.create()
    const reads = []
    window.mica.chat.history = async (id) => {
      reads.push(id)
      return []
    }
    api.sessions.bind({ nodeId: 'draft-bound', sessionId: 'real-bound' })
    await api.sessions.history('draft-bound')
    expect(bindings).toEqual([['draft-bound', 'real-bound']])
    expect(reads).toEqual(['real-bound'])
  })

  test('resolves a draft handle through a workspace binding learned by another view', async () => {
    const api = hostWith()
    window.mica.uiState = {
      get: async () => ({
        workspace: { nodes: [{ id: 'draft', sessionId: 'real', cwd: '/repo' }] }
      })
    }
    expect(await api.sessions.resolve('draft')).toEqual({
      nodeId: 'draft',
      sessionId: 'real',
      cwd: '/repo'
    })
  })

  test('a standalone refresh preserves the live node and its draft key from the persisted pointer', async () => {
    hostWith()
    window.mica.uiState = { get: async () => ({ workspace: { nodes: [] } }) }
    const before = createPluginHostApi('sample')
    const created = await before.sessions.create()
    before.sessions.bind({ nodeId: created.id, sessionId: 'real-live' })
    const after = createPluginHostApi('sample')
    expect(await after.sessions.resolve('real-live', { nodeId: created.id })).toEqual({
      nodeId: created.id,
      sessionId: 'real-live'
    })
    expect((await after.sessions.attach({ sessionId: 'real-live' })).nodeId).toBe(created.id)
  })

  test('sorts before limiting without mutating the host list and rejects malformed rows', async () => {
    const sessions = [
      { id: 'old', updatedAt: '2026-10-01T00:00:00Z' },
      null,
      { id: 'invalid', updatedAt: 'not-a-date' },
      { id: 'new', updatedAt: '2026-11-01T00:00:00Z' },
      { title: 'missing id' }
    ]
    const api = hostWith({ sessions })
    expect((await api.sessions.list({ limit: 1.9 })).map((row) => row.id)).toEqual(['new'])
    expect((await api.sessions.list({ limit: 0.5 })).map((row) => row.id)).toEqual(['new'])
    for (const limit of [0, -1, NaN, Infinity, 'bad']) {
      expect((await api.sessions.list({ limit })).map((row) => row.id)).toEqual([
        'new',
        'old',
        'invalid'
      ])
    }
    expect(sessions[0].id).toBe('old')
    expect(sessions[1]).toBeNull()
  })

  test('does not disguise list/history/status failures as empty or idle', async () => {
    const api = hostWith()
    window.mica.stats.listSessions = async () => {
      throw new Error('list offline')
    }
    window.mica.chat.history = async () => {
      throw new Error('history offline')
    }
    window.mica.chat.isRunning = async () => {
      throw new Error('status offline')
    }
    await expect(api.sessions.list()).rejects.toThrow('list offline')
    await expect(api.sessions.history('s')).rejects.toThrow('history offline')
    await expect(api.sessions.status('s')).rejects.toThrow('status offline')
    await expect(api.sessions.isRunning('s')).rejects.toThrow('status offline')
    window.mica.stats.listSessions = async () => ({ error: 'failed' })
    window.mica.chat.history = async () => ({ error: 'failed' })
    window.mica.chat.isRunning = async () => ({ error: 'failed' })
    await expect(api.sessions.list()).rejects.toThrow('会话列表响应无效')
    await expect(api.sessions.history('s')).rejects.toThrow('会话历史响应无效')
    await expect(api.sessions.status('s')).rejects.toThrow('会话状态响应无效')
    expect(await api.sessions.status(null)).toBeNull()
  })

  test('uses a finite default limit and floors positive limits', async () => {
    const api = hostWith({
      sessions: Array.from({ length: 80 }, (_, index) => ({ id: `s${index}` }))
    })
    expect(await api.sessions.list()).toHaveLength(60)
    expect(await api.sessions.list({ limit: Infinity })).toHaveLength(60)
    expect(await api.sessions.list({ limit: '2.9' })).toHaveLength(2)
  })

  test('routes send, abort and recovery to the shared workspace node, not sessionId', async () => {
    const api = hostWith()
    let nodeId = 'term-main'
    const events = [{ sequence: 7, event: { type: 'text', part: { text: 'partial' } } }]
    const state = {
      running: true,
      remoteRunning: false,
      sessionId: 's1',
      prompt: 'original',
      events,
      queuedItems: []
    }
    window.mica.uiState = {
      get: async () => ({
        workspace: { nodes: [{ id: nodeId, type: 'terminal', sessionId: 's1' }] }
      })
    }
    window.mica.chat.isRunning = async (...args) => {
      calls.push(['status', ...args])
      return state
    }
    window.mica.chat.start = async (payload) => {
      calls.push(['start', payload])
      return { ok: true, queued: true }
    }
    window.mica.chat.abort = async (id) => {
      calls.push(['abort', id])
      return { ok: true }
    }
    const prompt = '  不追加笔记\n\n'
    expect(await api.sessions.status('s1')).toEqual({ ...state, nodeId: 'term-main' })
    expect(await api.sessions.send({ sessionId: 's1', prompt, clientMessageId: 'm1' })).toEqual({
      ok: true,
      queued: true
    })
    await api.sessions.abort('s1')
    expect(calls).toEqual([
      ['status', 'term-main', 's1'],
      [
        'start',
        {
          id: 'term-main',
          sessionId: 's1',
          cwd: null,
          prompt,
          clientMessageId: 'm1',
          maxTurns: 9999
        }
      ],
      ['abort', 'term-main']
    ])
    // 工作区变更后不能一直向旧节点发送，也不能写回工作区来伪造绑定。
    nodeId = 'term-reopened'
    expect((await api.sessions.isRunning('s1')).nodeId).toBe('term-reopened')
    expect(calls.at(-1)).toEqual(['status', 'term-reopened', 's1'])
    expect(await api.sessions.abort(null)).toBeNull()
  })

  test('propagates workspace lookup failure rather than spawning a second host', async () => {
    const api = hostWith()
    window.mica.uiState = {
      get: async () => {
        throw new Error('workspace offline')
      }
    }
    window.mica.chat.start = async () => {
      throw new Error('must not start')
    }
    await expect(api.sessions.send({ sessionId: 's', prompt: 'hello' })).rejects.toThrow(
      'workspace offline'
    )
  })

  test('normalizes event ownership and preserves rollback/retry/sequence and unsubscribes', async () => {
    const api = hostWith()
    const handlers = {}
    let disposed = 0
    for (const name of ['onEvent', 'onExit', 'onQueueError', 'onQueueState', 'onRunStarted']) {
      window.mica.chat[name] = (callback) => {
        handlers[name] = callback
        return () => {
          disposed += 1
        }
      }
    }
    const received = []
    const off = [
      api.sessions.onEvent((...args) => received.push(['event', ...args])),
      api.sessions.onExit((payload) => received.push(['exit', payload])),
      api.sessions.onQueueError((payload) => received.push(['queue-error', payload])),
      api.sessions.onQueueState((payload) => received.push(['queue-state', payload])),
      api.sessions.onRunStarted((payload) => received.push(['run-started', payload]))
    ]
    let sequence = 0
    for (const event of [
      { type: 'text', attemptId: 'a', part: { text: 'failed prefix' } },
      { type: 'text_rollback', attemptId: 'a', length: 3 },
      { type: 'reasoning_rollback', attemptId: 'a', length: 0 },
      { type: 'retrying', attempt: 2, maxAttempts: 5, delayMs: 1000 },
      { type: 'step_finish', part: { reason: 'completed' } }
    ]) {
      const payload = { id: 'term-main', sessionId: 's1', sequence: ++sequence, event }
      handlers.onEvent(payload)
      expect(received.at(-1)).toEqual(['event', 's1', event, { ...payload, nodeId: 'term-main' }])
    }
    const rejection = {
      id: 'term-main',
      clientMessageId: 'm1',
      text: 'unsent',
      error: 'busy',
      silent: true
    }
    handlers.onQueueError(rejection) // host 的真实契约：这一帧没有 sessionId。
    expect(received.at(-1)).toEqual([
      'queue-error',
      { ...rejection, id: 's1', nodeId: 'term-main' }
    ])
    const queued = { id: 'term-main', sessionId: 's1', queuedItems: [{ id: 'm1' }] }
    handlers.onQueueState(queued)
    expect(received.at(-1)).toEqual(['queue-state', { ...queued, id: 's1', nodeId: 'term-main' }])
    const started = {
      id: 'term-main',
      sessionId: 's1',
      prompt: 'other window',
      clientMessageId: 'm2'
    }
    handlers.onRunStarted(started)
    expect(received.at(-1)).toEqual(['run-started', { ...started, id: 's1', nodeId: 'term-main' }])
    const exit = { id: 'term-main', sessionId: 's1', exitCode: 1 }
    handlers.onExit(exit)
    expect(received.at(-1)).toEqual(['exit', { ...exit, id: 's1', nodeId: 'term-main' }])
    for (const unsubscribe of off) unsubscribe()
    expect(disposed).toBe(5)
    expect(exit.id).toBe('term-main')
  })

  test('claims immediate queue errors using the node resolved before start, even without text events', async () => {
    const api = hostWith()
    window.mica.uiState = {
      get: async () => ({ workspace: { nodes: [{ id: 'n', sessionId: 's' }] } })
    }
    let onError
    window.mica.chat.onQueueError = (callback) => {
      onError = callback
      return () => {}
    }
    const errors = []
    api.sessions.onQueueError((payload) => errors.push(payload))
    window.mica.chat.start = async () => {
      onError({ id: 'n', clientMessageId: 'rejected', error: 'host exited' })
      return { ok: true }
    }
    await api.sessions.send({ sessionId: 's', prompt: 'try', clientMessageId: 'rejected' })
    expect(errors).toEqual([
      { id: 's', nodeId: 'n', clientMessageId: 'rejected', error: 'host exited' }
    ])
  })

  test('learns node ownership from stream events without workspace and forgets rebound nodes', async () => {
    const api = hostWith()
    let onEvent
    window.mica.chat.onEvent = (callback) => {
      onEvent = callback
      return () => {}
    }
    window.mica.chat.abort = async (id) => {
      calls.push(id)
      return { ok: true }
    }
    api.sessions.onEvent(() => {})
    onEvent({ id: 'n', event: { type: 'text', sessionID: 'old' } })
    await api.sessions.abort('old')
    onEvent({ id: 'n', sessionId: 'new', event: { type: 'step_start' } })
    await api.sessions.abort('old')
    await api.sessions.abort('new')
    expect(calls).toEqual(['n', 'old', 'n'])
  })
})
