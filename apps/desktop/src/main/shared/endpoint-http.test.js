import { afterEach, describe, expect, it } from 'bun:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listenLocalSocket, probeLocalSocket } from './endpoint-http.js'

const dirs = []
const servers = []

async function tempSocket() {
  const dir = await mkdtemp(join(tmpdir(), 'mica-sock-'))
  dirs.push(dir)
  return join(dir, 'control.sock')
}

function track(server) {
  servers.push(server)
  return server
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve))
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

describe('listenLocalSocket', () => {
  it('binds a fresh path and is probeable afterwards', async () => {
    const path = await tempSocket()
    const server = track(createServer((_req, res) => res.end('ok')))
    await listenLocalSocket(server, path)
    expect(await probeLocalSocket(path)).toBe(true)
  })

  // 上一次被取消的退出会留下死文件：这种残留该清掉重新绑定
  it('replaces a stale socket file nothing is listening on', async () => {
    const path = await tempSocket()
    const stale = track(createServer())
    await new Promise((resolve) => stale.listen(path, resolve))
    await new Promise((resolve) => stale.close(resolve))
    servers.pop()

    const server = track(createServer((_req, res) => res.end('ok')))
    await listenLocalSocket(server, path)
    expect(await probeLocalSocket(path)).toBe(true)
  })

  // 关键回归：第二个实例不能删掉还活着的第一个实例的 socket 文件
  it('refuses to clobber a socket another instance is listening on', async () => {
    const path = await tempSocket()
    const first = track(createServer((_req, res) => res.end('first')))
    await listenLocalSocket(first, path)

    const second = createServer((_req, res) => res.end('second'))
    await expect(listenLocalSocket(second, path)).rejects.toThrow(/另一个实例/)
    await new Promise((resolve) => second.close(resolve))

    // 第一个实例仍然可达，文件也还在
    expect(await probeLocalSocket(path)).toBe(true)
  })
})
