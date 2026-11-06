import { readFile as nodeReadFile, stat as nodeStat } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'

const LARGE_FILE_BYTES = 4 * 1024 * 1024

// 只做字段投影；统计、来源与旧 usage 的身份仍由 stats-core 计算。usage 记录不能裁字段：
// 没有 usageId 的旧记录用整条 JSON 的摘要去重，改动形状就会让 fork 的副本重新计入。
function projectSession(raw, mode) {
  if (!raw || typeof raw !== 'object') return raw
  const snapshot = raw.snapshot
  if (mode === 'text') {
    const content = (value) => {
      if (typeof value === 'string') return value
      if (!Array.isArray(value)) return null
      return value
        .filter((block) => block && typeof block === 'object')
        .map((block) => ({
          type: block.type,
          text: typeof block.text === 'string' ? block.text : undefined
        }))
    }
    return {
      id: raw.id,
      snapshot: {
        conversationMessages: Array.isArray(snapshot?.conversationMessages)
          ? snapshot.conversationMessages
              .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
              .map((message) => ({
                role: message.role,
                content: content(message.content),
                displayContent: content(message.displayContent)
              }))
          : null
      }
    }
  }

  const result = {}
  for (const key of [
    'version',
    'id',
    'title',
    'cwd',
    'parentSessionId',
    'awaitingInput',
    'createdAt',
    'updatedAt',
    'turnState'
  ]) {
    if (Object.hasOwn(raw, key)) result[key] = raw[key]
  }
  if (!snapshot || typeof snapshot !== 'object') {
    result.snapshot = snapshot
    return result
  }
  result.snapshot = {}
  for (const key of [
    'providerId',
    'model',
    'effort',
    'role',
    'contextWindowSize',
    'usageHistory',
    'subagentUsageHistory',
    'lastUsage',
    'displayUsage'
  ]) {
    if (Object.hasOwn(snapshot, key)) result.snapshot[key] = snapshot[key]
  }
  result.snapshot.messages = Array.isArray(snapshot.messages)
    ? snapshot.messages.map((message) => ({ role: message?.role }))
    : null
  // parseSessionMeta 只验证这是数组，不需要正文；统计轮数只看 messages 的 role。
  result.snapshot.conversationMessages = Array.isArray(snapshot.conversationMessages) ? [] : null
  return result
}

// 内联源码沿用 session-reader 的方式，同时支持 Electron / Web bundle，不依赖额外产物。
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads')
const { readFileSync } = require('node:fs')
const projectSession = ${projectSession.toString()}
try {
  const raw = JSON.parse(readFileSync(workerData.file, 'utf8'))
  parentPort.postMessage({ ok: true, value: projectSession(raw, workerData.mode) })
} catch (error) {
  parentPort.postMessage({ ok: false, error: {
    name: error.name, message: error.message, code: error.code
  } })
}
`

/**
 * 大文件的读取、解析和裁剪在 worker 内完成，只回传统计或搜索要用的字段。
 * 扫描器维护签名缓存；这里仅合并正在读取的同文件请求，并限制并行读盘 / worker 数。
 */
export function createSessionUsageReader({
  readFile = nodeReadFile,
  stat = nodeStat,
  startWorker = (file, mode) =>
    new Worker(WORKER_SOURCE, { eval: true, workerData: { file, mode }, execArgv: [] }),
  largeFileBytes = LARGE_FILE_BYTES,
  maxConcurrentReads = 2,
  workerTimeoutMs = 30_000
} = {}) {
  if (!Number.isInteger(maxConcurrentReads) || maxConcurrentReads < 1)
    throw new TypeError('maxConcurrentReads must be a positive integer')
  if (!Number.isFinite(largeFileBytes) || largeFileBytes < 0)
    throw new TypeError('largeFileBytes must be non-negative')
  if (!Number.isFinite(workerTimeoutMs) || workerTimeoutMs <= 0)
    throw new TypeError('workerTimeoutMs must be positive')

  const pending = new Map()
  const queue = []
  let active = 0

  async function readInProcess(file, mode, checkSize = false) {
    let data = await readFile(file)
    // stat 之后文件可能长大；不要在主线程解析刚刚超过阈值的内容。
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
    if (checkSize && bytes >= largeFileBytes) {
      data = null
      return readInWorker(file, mode)
    }
    return projectSession(JSON.parse(data.toString('utf8')), mode)
  }

  async function readInWorker(file, mode) {
    let worker
    let reply
    let failure
    let cleanup = () => {}
    try {
      worker = startWorker(file, mode)
      reply = await new Promise((resolve, reject) => {
        let timer
        let settled = false
        const finish = (error, value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) reject(error)
          else resolve(value)
        }
        const onMessage = (value) => {
          if (!value || typeof value.ok !== 'boolean') {
            finish(new Error('Worker returned an invalid session projection'))
          } else finish(null, value)
        }
        const onError = (error) => finish(error)
        const onExit = (code) =>
          finish(new Error(`Worker exited before returning a session (code ${code})`))
        cleanup = () => {
          clearTimeout(timer)
          worker.removeListener('message', onMessage)
          worker.removeListener('error', onError)
          worker.removeListener('exit', onExit)
        }
        worker.once('message', onMessage)
        worker.once('error', onError)
        worker.once('exit', onExit)
        timer = setTimeout(() => finish(new Error('Session reader worker timed out')), workerTimeoutMs)
      })
    } catch (error) {
      failure = error
    } finally {
      // 先终止再释放并发名额，失败降级也不能和失控的 worker 同时占着大会话内存。
      if (worker) {
        try {
          await worker.terminate()
        } catch {
          // 已退出的 worker 无需再清理。
        }
      }
      cleanup()
    }
    if (failure) {
      console.warn('[session-usage-reader] Worker failed; reading session in process:', failure.message)
      return readInProcess(file, mode)
    }
    if (!reply.ok) {
      const error = new Error(reply.error?.message || 'Unable to read session')
      error.name = reply.error?.name || 'Error'
      if (reply.error?.code) error.code = reply.error.code
      throw error
    }
    return reply.value
  }

  async function run(job) {
    try {
      const info = await stat(job.file)
      job.resolve(
        await (info.size >= largeFileBytes
          ? readInWorker(job.file, job.mode)
          : readInProcess(job.file, job.mode, true))
      )
    } catch (error) {
      job.reject(error)
    } finally {
      active -= 1
      drain()
    }
  }

  function drain() {
    while (active < maxConcurrentReads && queue.length) {
      active += 1
      void run(queue.shift())
    }
  }

  return function readSessionJson(file, { mode = 'usage' } = {}) {
    if (mode !== 'usage' && mode !== 'text')
      return Promise.reject(new TypeError('Invalid session projection mode'))
    const key = `${mode}\0${file}`
    if (pending.has(key)) return pending.get(key)
    const task = new Promise((resolve, reject) => queue.push({ file, mode, resolve, reject }))
    pending.set(key, task)
    const clear = () => {
      if (pending.get(key) === task) pending.delete(key)
    }
    void task.then(clear, clear)
    drain()
    return task
  }
}

// 扫描、用量详情和正文搜索共用上限，避免几个入口各自启动一批 worker。
export const readSessionUsageJson = createSessionUsageReader()
