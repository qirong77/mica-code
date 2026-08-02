import { afterEach, describe, expect, it } from 'bun:test'
import { createNotifyServer } from './notifyServer'

const servers = []

async function postEvent(server, terminalId, type) {
  const response = await fetch(`${server.baseUrl}/v1/terminals/${terminalId}/events`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${server.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ type })
  })
  expect(response.ok).toBe(true)
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

describe('terminal process activity notifications', () => {
  it('uses running while work is active and unread after it completes', async () => {
    const server = await createNotifyServer()
    servers.push(server)

    const running = server.setProcessRunning('node:terminal', true)
    expect(running).toMatchObject({
      running: true,
      unread: false,
      processRunning: true,
      lastType: 'terminal.started'
    })

    const completed = server.setProcessRunning('node:terminal', false)
    expect(completed).toMatchObject({
      running: false,
      unread: true,
      processRunning: false,
      lastType: 'terminal.completed'
    })

    expect(server.markRead('node:terminal')).toMatchObject({ running: false, unread: false })
  })

  it('keeps the green running state when a Mica turn outlives the terminal process', async () => {
    const server = await createNotifyServer()
    servers.push(server)
    const terminalId = 'node:terminal'

    server.setProcessRunning(terminalId, true)
    await postEvent(server, terminalId, 'turn.started')

    const state = server.setProcessRunning(terminalId, false)
    expect(state).toMatchObject({ running: true, unread: true, agentRunning: true })
  })

  it('moves a Mica turn from green running to blue unread semantics', async () => {
    const server = await createNotifyServer()
    servers.push(server)
    const terminalId = 'node:mica'

    await postEvent(server, terminalId, 'turn.started')
    expect(server.get(terminalId)).toMatchObject({ running: true, unread: false })

    await postEvent(server, terminalId, 'turn.completed')
    expect(server.get(terminalId)).toMatchObject({ running: false, unread: true })
  })
})
