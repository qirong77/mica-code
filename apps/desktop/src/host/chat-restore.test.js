import { afterAll, afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as electron from '../server/electron-shim.js'
import * as sessionReader from './session-reader.js'
import * as sessionLease from './session-lease.js'

const actualReader = { ...sessionReader }
const actualLease = { ...sessionLease }
const readSession = mock()
const hasLiveTurnLease = mock()
mock.module('electron', () => electron)
mock.module('./session-reader.js', () => ({ ...actualReader, createSessionReader: () => readSession }))
mock.module('./session-lease.js', () => ({ ...actualLease, createTurnLeaseProbe: () => hasLiveTurnLease }))
const { registerChatIpc, disposeAllChatRuns } = await import('./chat.js')
registerChatIpc()

const invoke = electron.invokeChannel
const target = { id: 'node', sessionId: 'session' }
const provider = { id: 'provider', protocol: 'openai_responses', api_base: 'https://example.test/v1' }
const meta = { providerId: provider.id, model: 'model', turnState: 'completed' }
const rows = [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'world' }]
const idle = { running: false, remoteRunning: false, sessionId: null, events: [], snapshots: [], ask: null, queuedCount: 0, queuedItems: [] }

let home
const previousHome = process.env.MICA_HOME
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mica-chat-restore-'))
  process.env.MICA_HOME = home
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    providers: [provider], defaultModel: { provider: provider.id, model: meta.model }
  }))
  readSession.mockReset().mockResolvedValue({ history: rows, meta })
  hasLiveTurnLease.mockReset().mockReturnValue(false)
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.MICA_HOME
  else process.env.MICA_HOME = previousHome
  rmSync(home, { recursive: true, force: true })
})

afterAll(() => {
  disposeAllChatRuns()
  for (const name of ['restore', 'history-page', 'meta', 'is-running']) {
    electron.ipcMain.removeHandler(`chat:${name}`)
  }
  mock.module('./session-reader.js', () => actualReader)
  mock.module('./session-lease.js', () => actualLease)
})

it('projects one session snapshot with the same cursor and provider filter, then samples state', async () => {
  const initial = await invoke('chat:history-page', target)
  const payload = { ...target, from: initial.startCursor }
  const order = []
  let finishRead
  readSession.mockClear().mockImplementation(() => new Promise((resolve) => { finishRead = resolve }))
  hasLiveTurnLease.mockImplementation((sessionId) => {
    order.push('state')
    return sessionId === target.sessionId
  })
  const pending = invoke('chat:restore', payload)
  await Promise.resolve()
  expect(readSession.mock.calls).toEqual([[join(home, 'sessions', 'session.json')]])
  expect(hasLiveTurnLease).not.toHaveBeenCalled()

  const snapshot = {
    get history() {
      order.push('page')
      return [...rows, { role: 'assistant', kind: 'reasoning', providerId: provider.id,
        protocol: provider.protocol, apiBase: 'https://previous.example.test', text: 'old checkpoint' }]
    },
    meta: { ...meta, get model() { order.push('meta'); return meta.model } }
  }
  finishRead(snapshot)
  const result = await pending
  expect(order.slice(0, 2).sort()).toEqual(['meta', 'page'])
  expect(order.at(-1)).toBe('state')
  readSession.mockResolvedValue(snapshot)
  expect(result).toEqual({
    page: await invoke('chat:history-page', payload),
    meta: await invoke('chat:meta', target),
    state: await invoke('chat:is-running', target)
  })
  expect(result.page).toMatchObject({ rows, startCursor: initial.startCursor, reset: false })
  expect(result.meta).toMatchObject({ ...meta, protocol: provider.protocol, apiBase: provider.api_base })
  expect(result.state.remoteRunning).toBe(true)
})

it.each(['page', 'meta', 'state'])('keeps successful projections when %s fails', async (field) => {
  const fail = () => { throw new Error(`${field} failed`) }
  readSession.mockResolvedValue({
    get history() { return field === 'page' ? fail() : rows },
    meta: { ...meta, get model() { return field === 'meta' ? fail() : meta.model } }
  })
  if (field === 'state') hasLiveTurnLease.mockImplementation(fail)
  const result = await invoke('chat:restore', target)
  expect(result.errors).toEqual({ [field]: `${field} failed` })
  expect(result[field]).toBeNull()
  if (field !== 'page') expect(result.page.rows).toEqual(rows)
  if (field !== 'meta') expect(result.meta).toMatchObject(meta)
  if (field !== 'state') expect(result.state).toEqual(idle)
})

it('still samples state if the shared session read fails', async () => {
  readSession.mockRejectedValue(new Error('read failed'))
  expect(await invoke('chat:restore', target)).toEqual({
    page: null, meta: null, state: idle, errors: { page: 'read failed', meta: 'read failed' }
  })
  expect(readSession).toHaveBeenCalledTimes(1)
})

it('keeps draft defaults without reading history', async () => {
  expect(await invoke('chat:restore', { id: 'draft', sessionId: null })).toEqual({
    page: null,
    meta: await invoke('chat:meta', { sessionId: null }),
    state: idle
  })
  expect(readSession).not.toHaveBeenCalled()
})
