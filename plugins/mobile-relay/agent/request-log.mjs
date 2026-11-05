import { constants } from 'node:fs'
import { mkdir, open, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const FLUSH_MS = 2_000
const MAINTENANCE_MS = 60_000
const DAY_MS = 86_400_000
const FILE_BYTES = 2 * 1024 * 1024
const TOTAL_BYTES = 32 * 1024 * 1024
const QUEUE_BYTES = 256 * 1024
const QUEUE_ENTRIES = 1_024
const FILE_NAME = /^relay-requests-(\d{8})(?:-([1-9]\d{0,8}))?\.jsonl$/
const CHANNEL_NAME = /^[A-Za-z_][A-Za-z0-9:_-]{0,79}$/
const COUNTERS = ['durationMs', 'requestBytes', 'responseBytes', 'resultCount', 'eventCount', 'commandCount']

function dayOf(time) {
  return new Date(time).toISOString().slice(0, 10).replaceAll('-', '')
}

function counter(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
    : undefined
}

function project(entry) {
  if (!entry) return null
  const { endpoint, outcome, status, channels: inputChannels } = entry
  if (!['/api/poll', '/api/push'].includes(endpoint)) return null
  if (!['ok', 'http-error', 'network-error'].includes(outcome)) return null
  const result = { ts: new Date().toISOString(), endpoint, outcome }
  if (Number.isInteger(status) && status >= 0 && status <= 599) result.status = status
  for (const key of COUNTERS) {
    const value = counter(entry[key])
    if (value !== undefined) result[key] = value
  }
  if (inputChannels && typeof inputChannels === 'object' && !Array.isArray(inputChannels)) {
    const channels = Object.create(null)
    let inspected = 0
    let accepted = 0
    for (const key in inputChannels) {
      if (++inspected > 256 || accepted >= 32) break
      if (!Object.hasOwn(inputChannels, key) || !CHANNEL_NAME.test(key)) continue
      const value = counter(inputChannels[key])
      if (value === undefined) continue
      channels[key] = value
      accepted++
    }
    result.channels = channels
  }
  return `${JSON.stringify(result)}\n`
}

/** @param {{ dir?: string }} options */
export function createRequestLogger({ dir } = {}) {
  let queue = []
  let queueBytes = 0
  let timer = null
  let writing = null
  let closing = null
  let closed = false
  let ready = false
  let lastMaintenance = -Infinity
  let files = new Map()
  let totalBytes = 0
  let active = null

  async function closeFile() {
    const current = active
    active = null
    try {
      await current?.handle.close()
    } catch {
      // Diagnostics must never interrupt the bridge.
    }
  }

  async function maintain() {
    const now = Date.now()
    if (now - lastMaintenance < MAINTENANCE_MS) return ready
    lastMaintenance = now
    ready = false
    await closeFile()
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const found = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const match = FILE_NAME.exec(entry.name)
      if (!match || !entry.isFile()) continue
      const info = await stat(join(dir, entry.name))
      found.push({ name: entry.name, day: match[1], index: Number(match[2] || 0), size: info.size })
    }
    found.sort((a, b) => a.day.localeCompare(b.day) || a.index - b.index)
    files = new Map(found.map((file) => [file.name, file]))
    totalBytes = found.reduce((sum, file) => sum + file.size, 0)
    const oldestDay = dayOf(now - 6 * DAY_MS)
    for (const file of found) {
      if (file.day >= oldestDay && totalBytes <= TOTAL_BYTES - FILE_BYTES) continue
      await unlink(join(dir, file.name))
      files.delete(file.name)
      totalBytes -= file.size
    }
    ready = true
    return true
  }

  async function selectFile(day, bytes) {
    if (active?.file.day === day && active.file.size + bytes <= FILE_BYTES) return
    await closeFile()
    const sameDay = [...files.values()].filter((file) => file.day === day)
    const latest = sameDay.at(-1)
    const index = latest ? latest.index + (latest.size + bytes > FILE_BYTES ? 1 : 0) : 0
    const name = `relay-requests-${day}${index ? `-${index}` : ''}.jsonl`
    const handle = await open(join(dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW || 0), 0o600)
    try {
      await handle.chmod(0o600)
      const file = files.get(name) || { name, day, index, size: 0 }
      files.set(name, file)
      active = { handle, file }
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  async function writeBatch(batch) {
    if (!(await maintain())) return
    const day = dayOf(Date.now())
    let offset = 0
    while (offset < batch.length) {
      const firstBytes = Buffer.byteLength(batch[offset])
      if (totalBytes + firstBytes > TOTAL_BYTES) return
      await selectFile(day, firstBytes)
      let bytes = 0
      const start = offset
      while (offset < batch.length) {
        const nextBytes = Buffer.byteLength(batch[offset])
        if (active.file.size + bytes + nextBytes > FILE_BYTES || totalBytes + bytes + nextBytes > TOTAL_BYTES) break
        bytes += nextBytes
        offset++
      }
      await active.handle.appendFile(batch.slice(start, offset).join(''), 'utf8')
      active.file.size += bytes
      totalBytes += bytes
    }
  }

  function flush() {
    if (timer) clearTimeout(timer)
    timer = null
    if (writing) return writing.then(() => queue.length ? flush() : undefined)
    if (!queue.length) return Promise.resolve()
    writing = (async () => {
      while (queue.length) {
        const batch = queue
        queue = []
        queueBytes = 0
        try {
          await writeBatch(batch)
        } catch {
          ready = false
          await closeFile()
        }
      }
    })().finally(() => {
      writing = null
      if (queue.length && !closed) schedule()
    })
    return writing
  }

  function schedule() {
    if (timer || writing) return
    timer = setTimeout(() => { void flush() }, FLUSH_MS)
    timer.unref?.()
  }

  function record(entry) {
    if (closed || typeof dir !== 'string' || !dir || queue.length >= QUEUE_ENTRIES) return
    try {
      const line = project(entry)
      if (!line) return
      const bytes = Buffer.byteLength(line)
      if (queueBytes + bytes > QUEUE_BYTES) return
      queue.push(line)
      queueBytes += bytes
      schedule()
    } catch {
      // Only the allowlisted projection may enter the queue, even for malformed input.
    }
  }

  function close() {
    if (!closing) {
      closed = true
      closing = flush().then(closeFile)
    }
    return closing
  }

  return { record, flush, close }
}
