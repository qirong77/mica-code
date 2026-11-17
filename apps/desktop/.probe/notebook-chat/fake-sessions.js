/** In-memory sessions contract only; no fetch interception or runtime access. */
export function createFakeSessions() {
  const sent = []
  const calls = []
  const pending = new Map()
  const policies = new Map()
  const listeners = new Map()
  const histories = new Map()
  const runs = new Map()
  let serial = 0
  let scenario = 'immediate-text'
  let rows = []
  const clone = (value) => structuredClone(value)
  const emit = (channel, ...args) => {
    for (const callback of [...(listeners.get(channel) || [])]) callback(...args)
  }
  const subscribe = (channel, callback) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel).add(callback)
    return () => listeners.get(channel).delete(callback)
  }
  const request = (method, sessionId, value) => {
    const policy = {
      ...(policies.get(method) || {}),
      ...(policies.get(`${method}:${sessionId}`) || {})
    }
    const call = { id: ++serial, method, sessionId, state: 'pending' }
    calls.push(call)
    return new Promise((resolve, reject) => {
      let timer
      const settle = (error, result = value) => {
        clearTimeout(timer)
        pending.delete(call.id)
        call.state = error ? 'rejected' : 'resolved'
        if (error) reject(new Error(String(error)))
        else resolve(clone(result))
      }
      pending.set(call.id, {
        ...call,
        resolve: (result) => settle(null, result === undefined ? value : result),
        reject: (message = `${method} controlled failure`) => settle(message)
      })
      if (policy.hold) return
      const complete = () =>
        settle(policy.fail ? policy.error || `${method} controlled failure` : null)
      if (policy.delayMs > 0) timer = setTimeout(complete, policy.delayMs)
      else complete()
    })
  }
  const event = (id, value) => {
    const run = runs.get(id)
    if (run) {
      if (value.type === 'text') run.text += String(value.part?.text || value.text || '')
      if (value.type === 'text_rollback' && Number(value.length) > 0)
        run.text = run.text.slice(0, -Math.max(0, Number(value.length) || 0))
      run.events.push({ event: clone(value), sequence: run.events.length + 1 })
    }
    emit('event', id, value, { id, sessionId: id, sequence: run?.events.length || 0 })
  }
  const text = (id, delta) => {
    event(id, { type: 'text', part: { text: delta } })
  }
  const finish = (id = sent.at(-1)?.sessionId || rows[0]?.id, error = null) => {
    const run = runs.get(id)
    if (run?.text) histories.get(id)?.push({ role: 'assistant', text: run.text })
    runs.delete(id)
    emit('exit', { id, sessionId: id, code: error ? 1 : 0, ...(error ? { error } : {}) })
  }
  const queueError = (id = sent.at(-1)?.sessionId, message = '模拟异步队列拒绝：请重试') => {
    const item = [...sent].reverse().find((entry) => entry.sessionId === id)
    runs.delete(id)
    emit('queue-error', {
      id,
      sessionId: id,
      error: message,
      message,
      clientMessageId: item?.clientMessageId,
      prompt: item?.prompt
    })
    emit('queue-state', { id, sessionId: id, count: 0, queuedItems: [] })
  }
  const api = {
    list: (options = {}) => request('list', '', rows.slice(0, options.limit || 80)),
    history: (id) => request('history', id, clone(histories.get(id) || [])),
    isRunning: (id) => {
      const run = runs.get(id)
      return request('isRunning', id, {
        running: !!run,
        prompt: run?.prompt || '',
        events: clone(run?.events || []),
        queuedItems: [],
        remoteRunning: false,
        sessionId: id
      })
    },
    send: (input) => {
      const item = clone(input)
      sent.push(item)
      if (policies.get('send')?.fail || policies.get(`send:${input.sessionId}`)?.fail)
        return request('send', input.sessionId, { ok: true })
      if (scenario === 'send-error')
        return request('send', input.sessionId, { ok: false, error: '模拟发送失败' })
      if (scenario === 'queue-error') {
        // Acceptance is not completion. Explicit queueError() rejects this later,
        // after the caller has observed the successful acknowledgement.
        return request('send', input.sessionId, { ok: true, queued: true })
      }
      const id = input.sessionId
      histories.get(id)?.push({ role: 'user', text: input.prompt })
      runs.set(id, {
        prompt: input.prompt,
        text: '',
        events: [],
        clientMessageId: input.clientMessageId
      })
      // Deliberately synchronous, BEFORE send resolves: detects subscription gaps.
      event(id, { type: 'step_start' })
      if (scenario === 'immediate-text') text(id, '即时首帧：**原样发送**已收到。\n')
      return request('send', id, { ok: true })
    },
    abort: (id) => request('abort', id, { ok: true }),
    onEvent: (callback) => subscribe('event', callback),
    onExit: (callback) => subscribe('exit', callback),
    onQueueError: (callback) => subscribe('queue-error', callback),
    onQueueState: (callback) => subscribe('queue-state', callback),
    onRunStarted: (callback) => subscribe('run-started', callback)
  }
  api.status = api.isRunning

  const setScenario = (next = 'immediate-text') => {
    for (const call of [...pending.values()]) call.reject('probe scenario reset')
    scenario = next
    policies.clear()
    runs.clear()
    sent.length = 0
    calls.length = 0
    histories.clear()
    rows =
      next === 'empty'
        ? []
        : [
            {
              id: 'probe-session-a',
              title: 'Notebook 布局与交互验证',
              cwd: '/example/projects/notebook',
              updatedAt: new Date().toISOString()
            },
            {
              id: 'probe-session-b',
              title: '第二条会话 · 独立草稿与历史',
              cwd: '/example/projects/another-workspace',
              updatedAt: new Date(Date.now() - 3600000).toISOString()
            },
            {
              id: 'probe-session-c',
              title: '一个很长很长的会话标题，用于验证标题省略与搜索结果布局不会溢出',
              cwd: '/example/projects/a-very-long-workspace-directory-name',
              updatedAt: '2026-01-02T12:00:00Z'
            }
          ]
    histories.set('probe-session-a', [
      { role: 'user', text: '请检查笔记右侧对话布局。' },
      {
        role: 'assistant',
        text: '这里是真实 **NotebookChatDock**，不是编辑器测试。\n\n- 标题与路径\n- `Enter` 发送\n- 消息内容原样透传\n\n```js\nconst message = "你好，Mica"\n```'
      }
    ])
    histories.set('probe-session-b', [
      { role: 'assistant', text: '这是第二条会话的历史，不应混入第一条会话。' }
    ])
    histories.set('probe-session-c', [])
    if (next === 'long-history')
      histories.set(
        'probe-session-a',
        Array.from({ length: 50 }, (_, index) => ({
          role: index % 2 ? 'assistant' : 'user',
          text: `消息 ${index + 1}\n用于滚动、复制与回到底部验证。\nhttps://example.com/${'long-path-'.repeat(12)}`
        }))
      )
    if (next === 'history-error') policies.set('history', { fail: true, error: '模拟历史读取失败' })
    if (next === 'list-error') policies.set('list', { fail: true, error: '模拟会话列表失败' })
    if (next === 'abort-error') policies.set('abort', { fail: true, error: '模拟停止失败' })
    return next
  }
  setScenario()
  return {
    api,
    sent,
    calls,
    pending,
    setScenario,
    event,
    text,
    finish,
    queueError,
    configure: (method, policy = {}) => policies.set(method, { ...policy }),
    clearPolicy: (method) => policies.delete(method),
    release: (callId, result) => pending.get(callId)?.resolve(result),
    reject: (callId, message) => pending.get(callId)?.reject(message),
    setHistory: (id, value) => histories.set(id, clone(value)),
    setRows: (value) => {
      rows = clone(value)
    },
    startExternal: (id, prompt = '来自其他页面的消息') => {
      histories.get(id)?.push({ role: 'user', text: prompt })
      runs.set(id, { prompt, text: '', events: [] })
      emit('run-started', { id, sessionId: id, prompt })
      event(id, { type: 'step_start' })
    },
    inspect: () => ({
      scenario,
      pending: [...pending.values()].map(({ id, method, sessionId }) => ({
        id,
        method,
        sessionId
      })),
      subscriptions: Object.fromEntries([...listeners].map(([key, value]) => [key, value.size])),
      running: [...runs.keys()]
    })
  }
}
