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
  it('uses running while terminal work is active without creating an unread reminder on completion', async () => {
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
      unread: false,
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
    expect(state).toMatchObject({ running: true, unread: false, agentRunning: true })
  })

  it('lights the session row while a By The Way thread is answering', async () => {
    const server = await createNotifyServer()
    servers.push(server)
    const terminalId = 'node:mica'

    // btw 是一个隔离子代理，没有 turn/started，所以运行态必须单独写一份：
    // 抽屉里字在流、侧栏却是静的那就是这个信号丢了。
    expect(server.setBtwRunning(terminalId, true)).toMatchObject({
      running: true,
      btwRunning: true,
      // 不是这个会话的一轮：不产生未读，也不改红点判据
      unread: false,
      lastType: null
    })
    // 主 turn 没在跑时，btw 结束就熄灭
    expect(server.setBtwRunning(terminalId, false)).toMatchObject({ running: false, btwRunning: false })

    // 反过来：主 turn 还在跑时，btw 结束不能把灯关掉
    await postEvent(server, terminalId, 'turn.started')
    server.setBtwRunning(terminalId, true)
    expect(server.setBtwRunning(terminalId, false)).toMatchObject({
      running: true,
      agentRunning: true,
      btwRunning: false
    })
    // 上一次 turn 的错误不是 btw 造成的：红点判据原样保留
    await postEvent(server, terminalId, 'turn.error')
    server.setBtwRunning(terminalId, true)
    expect(server.setBtwRunning(terminalId, false)).toMatchObject({ lastType: 'turn.error' })
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
