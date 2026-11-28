import { expect, it, mock } from 'bun:test'
import { registerChatHostIpc } from './chat-host-ipc.js'

function fixture() {
  const handlers = new Map()
  const event = { sender: {} }
  const run = { child: { stdin: { writable: true } } }
  const request = mock(async (target, method, params) =>
    target ? { ok: true, result: { method, params } } : { ok: false, error: 'offline' }
  )
  const ensureBtwRun = mock(() => ({ run }))
  const ensureCapabilityRun = mock(() => ({ run }))
  registerChatHostIpc(
    { handle: (key, fn) => handlers.set(key, fn) },
    {
      runs: new Map([['node', run]]),
      request,
      ensureBtwRun,
      ensureCapabilityRun
    }
  )
  const invoke = (name, payload) => handlers.get(`chat:${name}`)(event, payload)
  return { invoke, request, ensureBtwRun, ensureCapabilityRun, run, event }
}

it('only forwards input signals to a writable host', async () => {
  const { invoke, request, run, event, ensureCapabilityRun } = fixture()
  expect(await invoke('input-activity', { id: 'missing' })).toEqual({ ok: true, forwarded: false })
  expect(await invoke('input-focus', { id: 'node' })).toEqual({ ok: true, forwarded: true })
  expect(request).toHaveBeenCalledTimes(1)
  expect(request).toHaveBeenCalledWith(run, 'mica/input/focus', {})
  expect(run.sender).toBe(event.sender)
  expect(ensureCapabilityRun).not.toHaveBeenCalled()
})

it('keeps task replies wrapped and forwards only the fields allowed by each method', async () => {
  const { invoke, run, event } = fixture()
  expect(await invoke('subagent-detail', { id: 'node' })).toEqual({ ok: false, error: '参数缺失' })
  expect(await invoke('kill-subagent', { id: 'missing', taskId: 't' })).toEqual({
    ok: false,
    error: 'offline'
  })
  for (const [channel, method, extra] of [
    ['kill-background-task', 'mica/backgroundTasks/kill', { forceAfterMs: 0 }],
    ['background-task-output', 'mica/backgroundTasks/output', {}],
    ['restart-subagent', 'mica/subagentTasks/restart', {}]
  ]) {
    const payload = { id: 'node', taskId: 't', forceAfterMs: 0, tailBytes: 0, extra: 'ignored' }
    expect(await invoke(channel, payload)).toEqual({
      ok: true,
      result: { method, params: { taskId: 't', ...extra } }
    })
  }
  expect(run.sender).toBe(event.sender)
})

it('opens a session host after validation and only uses the requested role for capabilities', async () => {
  const { invoke, ensureCapabilityRun } = fixture()
  expect(await invoke('set-session-state', {})).toMatchObject({ error: 'chat id 缺失' })
  expect(await invoke('set-plugin-settings', { id: 'node' })).toMatchObject({
    error: 'pluginId 缺失'
  })
  expect(ensureCapabilityRun).not.toHaveBeenCalled()
  const payload = {
    id: 'node',
    sessionId: 's',
    cwd: '/work',
    role: 'reviewer',
    pluginId: 'p',
    selection: {}
  }
  expect(await invoke('set-session-state', payload)).toEqual({
    method: 'mica/sessionState/set',
    params: { pluginId: 'p', value: null }
  })
  expect(ensureCapabilityRun.mock.lastCall[2]).toEqual({
    sessionId: 's',
    cwd: '/work',
    role: undefined
  })
  expect(await invoke('set-capabilities', payload)).toEqual({
    method: 'mica/capabilities/set',
    params: { selection: {} }
  })
  expect(ensureCapabilityRun.mock.lastCall[2].role).toBe('reviewer')
})

it('lists and closes offline BTW threads without starting a host and preserves command failures', async () => {
  const { invoke, ensureBtwRun } = fixture()
  expect(await invoke('btw-threads', { id: 'missing' })).toEqual({ ok: true, threads: [] })
  expect(await invoke('btw-close', { id: 'missing' })).toEqual({ ok: true })
  expect(ensureBtwRun).not.toHaveBeenCalled()
  expect(await invoke('btw-recall', { id: 'node', threadId: 42 })).toEqual({
    ok: true,
    result: { method: 'mica/btw/recall', params: { threadId: '' } }
  })
  ensureBtwRun.mockReturnValue({ error: 'busy' })
  expect(await invoke('btw-interrupt', { id: 'node' })).toEqual({ ok: false, error: 'busy' })
})
