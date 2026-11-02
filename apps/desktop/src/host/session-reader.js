import { Worker } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'

// Inline worker source survives both Electron's packaged bundle and the web server
// bundle without relying on a separately emitted worker file or an asar path.
function projectSession(raw) {
  const snapshot = raw?.snapshot
  const messages = snapshot?.conversationMessages
  const text = (content) => typeof content === 'string' ? content : Array.isArray(content)
    ? content.map((block) => block?.type === 'text' ? block.text : block?.type === 'image' ? '[图片]' : '').join('')
    : ''
  let history = []
  try { history = Array.isArray(messages) ? messages.map((message) => ({
    role: message.role, text: text(message.displayContent ?? message.content),
    variant: message.variant ?? null, command: message.command ?? null,
    status: message.status ?? null, usage: message.usage ?? null,
    stop_reason: message.stop_reason ?? null
  })) : [] } catch {}
  let meta = null
  try { if (snapshot && typeof snapshot === 'object') {
    // Provider history contains tool calls omitted from conversationMessages.
    // A text user message starts a new plan scope; a media message after a tool
    // result is the rest of the same turn's tool output.
    const calls = new Map()
    let todoInput = null
    const failed = (result, output) => {
      if (result?.is_error === true || result?.isError === true) return true
      const value = Array.isArray(output)
        ? output.map((block) => block?.text || '').join('\n')
        : output
      if (typeof value !== 'string' || !value.trim()) return false
      if (/^(?:工具执行失败[:：]|未知工具[:：]|工具\s+todo_write\s+(?:输入校验失败|不在当前 agent 的允许工具范围内))/i.test(value.trim())) return true
      try {
        const parsed = JSON.parse(value)
        return parsed?.ok === false || parsed?.success === false || parsed?.is_error === true ||
          ['error', 'failed', 'interrupted', 'aborted'].includes(parsed?.status)
      } catch { return false }
    }
    for (const message of Array.isArray(snapshot.messages) ? snapshot.messages : []) {
      const blocks = Array.isArray(message?.content) ? message.content : []
      const user = message?.role === 'user' && !blocks.some((block) => block?.type === 'tool_result')
      const media = blocks.some((block) => block?.type && block.type !== 'text')
      if (user && !media) {
        calls.clear()
        todoInput = null
      }
      const remember = (id, name, input) => {
        if (!id || name !== 'todo_write') return
        try {
          const value = typeof input === 'string' ? JSON.parse(input) : input
          if (value && Array.isArray(value.todos)) calls.set(id, value)
        } catch {}
      }
      for (const call of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
        remember(call.id, call.function?.name, call.function?.arguments)
      }
      if (message?.type === 'function_call') remember(message.call_id, message.name, message.arguments)
      for (const block of blocks) {
        if (block?.type === 'tool_use') remember(block.id, block.name, block.input)
      }
      const finish = (id, result, output) => { if (calls.has(id) && !failed(result, output)) todoInput = calls.get(id) }
      if (message?.role === 'tool') finish(message.tool_call_id, message, message.content)
      if (message?.type === 'function_call_output') finish(message.call_id, message, message.output)
      for (const block of blocks) if (block?.type === 'tool_result') finish(block.tool_use_id, block, block.content)
    }
    const usages = Array.isArray(snapshot.usageHistory) ? snapshot.usageHistory : []
    const input = usages.reduce((sum, usage) => sum + Math.max(0, Number(usage?.inputTokens) || 0), 0)
    const cached = usages.reduce((sum, usage) => sum + Math.max(0, Number(usage?.cachedInputTokens) || 0), 0)
    const display = Number(snapshot.displayUsage?.totalTokens) || 0
    meta = {
      providerId: snapshot.providerId || null, model: snapshot.model || null,
      effort: snapshot.effort || null, role: snapshot.role || 'default',
      cwd: typeof raw.cwd === 'string' && raw.cwd.trim() ? raw.cwd.trim() : null,
      contextWindowSize: Number(snapshot.contextWindowSize) || null,
      lastUsage: display > 0 ? { totalTokens: display, inputTokens: display, outputTokens: 0, cachedInputTokens: 0 }
        : snapshot.lastUsage || usages.at(-1) || null,
      cachedRate: input > 0 ? cached / input : 0,
      turnState: raw.turnState || 'completed', updatedAt: raw.updatedAt || null, todoInput
    }
  }
  } catch {}
  return { history, meta }
}

const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { readFileSync } = require('node:fs')
const projectSession = ${projectSession.toString()}
try {
  parentPort.postMessage(projectSession(JSON.parse(readFileSync(workerData, 'utf8'))))
} catch {
  parentPort.postMessage({ history: [], meta: null })
}
`

const empty = () => ({ history: [], meta: null })

export function createSessionReader({
  startWorker = (file) => new Worker(WORKER_SOURCE, { eval: true, workerData: file, execArgv: [] })
} = {}) {
  const pending = new Map()
  return function readSession(file) {
    if (!file) return Promise.resolve(empty())
    if (pending.has(file)) return pending.get(file)
    const fallback = async (error) => {
      console.warn('[session-reader] Worker failed; reading session in process:', error?.message || error)
      try {
        return projectSession(JSON.parse(await readFile(file, 'utf8')))
      } catch {
        return empty()
      }
    }
    const task = new Promise((resolve, reject) => {
      try {
        const worker = startWorker(file)
        worker.once('message', resolve)
        worker.once('error', reject)
        worker.once('exit', (code) => reject(new Error(`Worker exited before returning a session (code ${code})`)))
      } catch (error) {
        reject(error)
      }
    }).catch(fallback)
    pending.set(file, task)
    task.finally(() => {
      if (pending.get(file) === task) pending.delete(file)
    })
    return task
  }
}
