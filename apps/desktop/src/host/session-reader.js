import { Worker } from 'node:worker_threads'

// Inline worker source survives both Electron's packaged bundle and the web server
// bundle without relying on a separately emitted worker file or an asar path.
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { readFileSync } = require('node:fs')
try {
  const raw = JSON.parse(readFileSync(workerData, 'utf8'))
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
      turnState: raw.turnState || 'completed', updatedAt: raw.updatedAt || null
    }
  }
  } catch {}
  parentPort.postMessage({ history, meta })
} catch {
  parentPort.postMessage({ history: [], meta: null })
}
`

const empty = () => ({ history: [], meta: null })

export function createSessionReader({
  startWorker = (file) => new Worker(WORKER_SOURCE, { eval: true, workerData: file })
} = {}) {
  const pending = new Map()
  return function readSession(file) {
    if (!file) return Promise.resolve(empty())
    if (pending.has(file)) return pending.get(file)
    const task = new Promise((resolve) => {
      try {
        const worker = startWorker(file)
        worker.once('message', resolve)
        worker.once('error', () => resolve(empty()))
        worker.once('exit', () => resolve(empty()))
      } catch {
        resolve(empty())
      }
    })
    pending.set(file, task)
    task.finally(() => {
      if (pending.get(file) === task) pending.delete(file)
    })
    return task
  }
}
