#!/usr/bin/env node
// 一次性探针：把一个会话拉起来、投一句话、等这一轮结束再收进程。
// 用法：node .probe-session-turn.mjs <sessionId> <cwd> <promptFile>
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'

const [sessionId, cwd, promptFile] = process.argv.slice(2)
if (!sessionId || !cwd || !promptFile) {
  console.error('usage: probe-session-turn.mjs <sessionId> <cwd> <promptFile>')
  process.exit(2)
}
const text = readFileSync(promptFile, 'utf8').trim()

const child = spawn(`${process.env.HOME}/.local/bin/mica`, ['app-server', '--session', sessionId], {
  cwd,
  env: { ...process.env, MICA_PLUGIN_DESKTOP_HOST: '1' },
  stdio: ['pipe', 'pipe', 'pipe']
})

let nextId = 1
const pending = new Map()
const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => reject(new Error(`${method} 超时`)), 120000)
    pending.set(id, { resolve, reject, timer })
    write({ id, method, params })
  })

let finished = false
const finish = (reason, code = 0) => {
  if (finished) return
  finished = true
  console.log(`RESULT ${reason}`)
  try {
    child.stdin.end()
  } catch {
    // 已经关了
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // 已退出
    }
    process.exit(code)
  }, 1500)
}

child.stderr.on('data', (chunk) => process.stderr.write(chunk))
createInterface({ input: child.stdout }).on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    return
  }
  if (typeof message.id === 'number' && !message.method) {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error).slice(0, 300)))
    else entry.resolve(message.result || {})
    return
  }
  if (message.method === 'turn/completed') {
    const status = message.params?.turn?.status || message.params?.status || 'completed'
    finish(`turn ${status}`)
  }
  if (message.method === 'error') {
    console.error('EVENT error', JSON.stringify(message.params).slice(0, 400))
  }
})

const main = async () => {
  await request('initialize', { clientInfo: { name: 'probe-turn', version: '1.0.0' } })
  write({ method: 'initialized', params: {} })
  const started = await request('thread/start', { cwd })
  const threadId = started?.thread?.id || sessionId
  await request('turn/start', { threadId, input: [{ type: 'text', text }] })
  console.log(`STARTED ${threadId}`)
}

setTimeout(() => finish('timeout', 1), 9 * 60 * 1000)
main().catch((error) => {
  console.error('FAILED', error?.message || error)
  finish('failed', 1)
})
