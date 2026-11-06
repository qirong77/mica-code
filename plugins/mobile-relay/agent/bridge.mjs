/**
 * 公司机侧的桥。
 *
 * 三件事：
 * 1. 订阅本机运行时 `GET /api/events`（回环，不出网），事件攒在内存里随轮询带出；
 * 2. 把中转机下发的白名单调用打到 `POST /api/invoke`；
 * 3. 按允许时段开关自己，并对轮询间隔做随机化。
 *
 * 上行通道是应用层加密的：AES-256-GCM，密钥由口令经 HKDF 派生，
 * 因此链路上即便有 TLS 拦截代理也读不到内容。
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { createRequestLogger } from './request-log.mjs'

const CHANNEL_KEY_INFO = 'poll-channel'
const REPLAY_WINDOW_MS = 120_000

/* ---------------------------------------------------------------- 配置 */

const SETTINGS_PATH = join(
  process.env.MICA_HOME || join(homedir(), '.mica'),
  'plugin-settings',
  'mobile-relay.json'
)
let cachedSettings = null
let cachedMtime = 0

function readSettings() {
  let values = {}
  try {
    const info = statSync(SETTINGS_PATH)
    if (info.mtimeMs !== cachedMtime || !cachedSettings) {
      values = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
      cachedSettings = values
      cachedMtime = info.mtimeMs
    } else {
      values = cachedSettings
    }
  } catch {
    values = {}
  }
  const pick = (key, envKey) => {
    if (typeof values?.[key] === 'string' && values[key].length > 0) return values[key]
    if (values && Object.hasOwn(values, key) && values[key] === '') return ''
    return process.env[envKey] ?? ''
  }
  return {
    relayUrl: pick('relayUrl', 'RELAY_URL').replace(/\/+$/, ''),
    token: pick('token', 'RELAY_TOKEN'),
    // 默认严格校验证书：中转机给了真证书时，中间人拿不到那条 TLS 也伪造不了
    verifyTls: !(String(values?.verifyTls ?? 'true').toLowerCase() === 'false'),
    localUrl: String(process.env.LOCAL_URL || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    debug: Boolean(process.env.RELAY_DEBUG)
  }
}

let settings = readSettings()
if (!settings.relayUrl || !settings.token) {
  console.error(`缺少中转地址或口令。填 ${SETTINGS_PATH}，或设置 RELAY_URL / RELAY_TOKEN。`)
  process.exit(1)
}

let CHANNEL_KEY = deriveKey(settings.token)
/** 机器名只在启动后第一轮上报一次，之后以中转机上存的名字为准。 */
let labelPending = hostname()
const requestLog = createRequestLogger({ dir: process.env.MICA_RELAY_LOG_DIR })

function channelCounts(items) {
  const counts = Object.create(null)
  for (const item of items || []) {
    const channel = String(item?.channel || '')
    if (/^[a-zA-Z0-9:_-]{1,96}$/.test(channel)) counts[channel] = (counts[channel] || 0) + 1
  }
  return counts
}

async function sendRelay(endpoint, body) {
  const started = Date.now()
  const packed = seal({ ...body, ts: Date.now() })
  let response
  try {
    response = await postBinary(`${settings.relayUrl}${endpoint}`, packed)
    const result = response.status === 200 && endpoint === '/api/poll' ? open(response.body) : response
    if (wanted || body.events?.length || body.results?.length || result?.commands?.length || response.status !== 200) {
      requestLog.record({
        endpoint, status: response.status, outcome: response.status === 200 ? 'ok' : 'http-error',
        durationMs: Date.now() - started, requestBytes: packed.length, responseBytes: response.body.length,
        eventCount: body.events?.length || 0, resultCount: body.results?.length || 0,
        commandCount: result?.commands?.length || 0,
        channels: channelCounts([...(body.results || []), ...(result?.commands || [])])
      })
    }
    if (response.status === 401) throw new Error('口令不匹配，或被中间设备改写')
    if (response.status !== 200) throw new Error(`relay HTTP ${response.status}`)
    return result
  } catch (error) {
    if (!response || response.status === 200) requestLog.record({
      endpoint, outcome: 'network-error', durationMs: Date.now() - started,
      requestBytes: packed.length, responseBytes: response?.body?.length || 0,
      eventCount: body.events?.length || 0, resultCount: body.results?.length || 0
    })
    throw error
  }
}

function deriveKey(token) {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(token, 'utf8'), Buffer.from('mica-relay-v1'), Buffer.from(CHANNEL_KEY_INFO), 32)
  )
}

/* ---------------------------------------------------------------- 加密 */

function seal(value) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', CHANNEL_KEY, iv)
  const body = gzipSync(Buffer.from(JSON.stringify(value)))
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

function open(buffer) {
  if (buffer.length < 29) throw new Error('envelope too short')
  const iv = buffer.subarray(0, 12)
  const tag = buffer.subarray(12, 28)
  const decipher = createDecipheriv('aes-256-gcm', CHANNEL_KEY, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()])
  return JSON.parse(gunzipSync(plain).toString('utf8'))
}


/* ---------------------------------------------------------------- 传输 */

/**
 * 二进制 POST。自签证书时不做链校验——内容本身由 AES-GCM 保证完整性，
 * 证书只影响「连的是不是那台机器」，而口令派生密钥已经覆盖了这一点。
 *
 * 连接要能复用：这条链路的 RTT 常在 150ms 量级，每次重建 TLS 要再花两三个往返，
 * 比任何调度优化都贵。所以不做「打断挂起中的请求」这种需要换连接的事。
 */
function postBinary(target, body) {
  const url = new URL(target)
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const req = send(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': body.length
        },
        rejectUnauthorized: settings.verifyTls,
        timeout: 30_000
      },
      (res) => {
        const chunks = []
        let bytes = 0
        res.on('data', (chunk) => {
          bytes += chunk.length
          if (bytes > MAX_POLL_RESPONSE_BYTES) req.destroy(new Error('relay response too large'))
          else chunks.push(chunk)
        })
        res.on('error', reject)
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }))
      }
    )
    // socket timeout 只管空闲；持续滴流的响应也必须在总预算内结束。
    const deadline = setTimeout(() => req.destroy(new Error('relay request deadline exceeded')), 30_000)
    deadline.unref?.()
    req.once('close', () => clearTimeout(deadline))
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(body)
  })
}

/**
 * 一轮轮询的响应上限。默认按「一串命令」的量级给（4MB），手机上贴一张截图时那张图
 * 会作为命令载荷经过这里，3x 屏的 PNG base64 后常有 5–8MB，因此留到 24MB。
 */
const MAX_POLL_RESPONSE_BYTES = 24 * 1024 * 1024

async function relayPoll(body) {
  return sendRelay('/api/poll', body)
}

/**
 * 事件的即时上行。
 *
 * 早先事件只能捎带在**下一次轮询的请求体**里，于是回显延迟等于「上一次挂起还剩多久」：
 * 无人看时 15 秒一档，有人在看也是 1–3 秒一档，终端里每敲一个字都要等这么久才看到它。
 * 想靠打断挂起中的轮询来催它，代价是那条连接被销毁、下一轮要重做 TLS 握手——实测单次
 * 握手就要 290ms，比等一轮还贵，打字反而更卡。
 *
 * 所以改成单独一条上行：事件一有就发，轮询继续挂着等命令，两边互不干扰。
 */
async function relayPush(body) {
  return sendRelay('/api/push', body)
}

/* ---------------------------------------------------------------- 通道 */

/**
 * 手机端不做通道过滤：页面能打开（口令对得上）就等于有人坐在这台机器前，凡是运行时
 * 支持的通道一律照送。
 *
 * 这里曾经维护一份放行清单，代价是运行时每加一个通道都会在手机上静默消失
 * （`chat:commit`、`chat:save-pasted-image`、`terminal:open-file` 都是这么丢的），
 * 报错还长得像权限问题。能力归属本来就该由运行时回答——它才知道每条通道要什么，
 * 桥只负责搬运。要限制就限制在运行时那边，别再维护第二份名单。
 */

const MAX_EVENT_FRAMES = 4000
const MAX_EVENT_BYTES = 1_500_000

let eventBuffer = []
let eventBytes = 0
const eventBatchPrefix = randomBytes(12).toString('hex')
let eventBatchSeq = 0
let pendingEventBatch = null
let eventBatchFlight = null
let eventBatchPollOnly = false
let relayParams = { intervalMs: 15_000, watch: null }
/** 中转机是否有人在看。没人看时不攒事件、不催轮询。 */
let wanted = false
const resultHashes = { entries: new Map(), bytes: 0 }
// 与中转机 resultCache 的上限一致：对方淘汰后必须重新传完整结果。
const RESULT_CACHE_LIMIT = 200
const RESULT_CACHE_BYTES = 4 * 1024 * 1024
const RESULT_BATCH_BYTES = 18 * 1024 * 1024
let pendingResults = []
const MAX_ACTIVE_COMMANDS = 32
const activeCommands = new Set()
let generation = 0
let pendingWake = false
let envPayload = null
let stopping = false
let pollFailures = 0

function retryDelay(failures) {
  const base = Math.min(60_000, 5000 * 2 ** Math.min(failures - 1, 4))
  return Math.min(60_000, Math.round(base * (0.8 + Math.random() * 0.4)))
}

function log(...args) {
  if (settings.debug) console.error(...args)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/* ---------------------------------------------------------------- 本机 */

async function localInvoke(channel, payload) {
  const res = await fetch(`${settings.localUrl}/api/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, payload }),
    signal: AbortSignal.timeout(60_000)
  })
  const body = await res.json().catch(() => null)
  if (body && body.ok === true) return { ok: true, result: body.result }
  return { ok: false, error: body?.error || `HTTP ${res.status}` }
}

async function readImage(path) {
  const res = await fetch(`${settings.localUrl}/api/image?path=${encodeURIComponent(path)}`, {
    signal: AbortSignal.timeout(20_000)
  })
  if (!res.ok) return { ok: false, error: `图片不可读（HTTP ${res.status}）` }
  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length > 16 * 1024 * 1024) return { ok: false, error: '图片太大' }
  return { ok: true, result: { type: res.headers.get('content-type') || 'image/png', data: buffer.toString('base64') } }
}

/**
 * 手机贴上来的截图写进本机的图片目录：怎么存、引用长什么样都交给运行时的
 * `/api/paste-image`，桥只把这段 base64 递过去。
 */
async function pasteImage(dataUrl) {
  const res = await fetch(`${settings.localUrl}/api/paste-image`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
    signal: AbortSignal.timeout(60_000)
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.ok !== true) return { ok: false, error: body?.error || `图片保存失败（HTTP ${res.status}）` }
  return { ok: true, result: { ref: String(body.ref || '') } }
}

async function saveAttachment(payload) {
  const res = await fetch(`${settings.localUrl}/api/attachment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataUrl: payload?.dataUrl, name: payload?.name }),
    signal: AbortSignal.timeout(60_000)
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.ok !== true) return { ok: false, error: body?.error || `附件保存失败（HTTP ${res.status}）` }
  return { ok: true, result: { path: body.path, name: body.name } }
}

async function readLocalEnv() {
  try {
    const res = await fetch(`${settings.localUrl}/api/env`, { signal: AbortSignal.timeout(5_000) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

async function subscribeLocalEvents() {
  while (!stopping) {
    try {
      const res = await fetch(`${settings.localUrl}/api/events`, {
        headers: { accept: 'text/event-stream' },
        signal: AbortSignal.timeout(24 * 60 * 60 * 1000)
      })
      if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`)
      log('[events] connected')

      const decoder = new TextDecoder()
      let buffer = ''
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true })
        let index
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue
            try {
              pushEvent(JSON.parse(line.slice(6)))
            } catch {
              /* 坏帧忽略 */
            }
          }
        }
        if (stopping) return
      }
    } catch (error) {
      if (stopping) return
      log('[events] reconnect:', String(error?.message || error))
    }
    await sleep(1500)
  }
}

function pushEvent(frame) {
  if (stopping) return
  if (!frame || typeof frame.channel !== 'string') return
  if (!wanted) return
  eventBuffer.push(frame)
  eventBytes += Buffer.byteLength(JSON.stringify(frame))
  while (eventBuffer.length > MAX_EVENT_FRAMES || eventBytes > MAX_EVENT_BYTES) {
    const dropped = eventBuffer.shift()
    if (!dropped) break
    eventBytes -= Buffer.byteLength(JSON.stringify(dropped))
  }
  // 任何上行事件都该尽快送到手机：终端回显、文件树、Git 状态都不是 chat:event，
  // 让它们等下一轮轮询就是把延迟押在那次挂起超时上。
  schedulePush()
}

/** 一批事件攒多久发一次：够把连续输出合成一个请求，又不至于让人看得出延迟。 */
const PUSH_DEBOUNCE_MS = 15
let pushTimer = null
let pushRunning = false

function schedulePush() {
  if (stopping || pushTimer || pushRunning) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    void flushPush()
  }, PUSH_DEBOUNCE_MS)
  pushTimer.unref?.()
}

async function flushPush() {
  if (stopping || pushRunning) return
  const flight = claimEventBatch('push')
  const events = flight?.batch.events || []
  const wake = pendingWake
  pendingWake = false
  if (!events.length && !wake) return
  const startedGeneration = generation
  pushRunning = true
  let failed = false
  try {
    await relayPush({ events, ...(flight ? { eventBatchId: flight.batch.id } : {}), ...(wake ? { wake: true } : {}) })
    if (startedGeneration === generation) finishEventBatch(flight, true)
  } catch (error) {
    failed = true
    if (startedGeneration === generation) {
      finishEventBatch(flight, false)
      pendingWake ||= wake && pendingResults.length > 0
    }
    log('[push] failed:', String(error?.message || error))
  } finally {
    if (startedGeneration === generation) {
      pushRunning = false
      // 失败后不立刻重排：那会变成没有退避的紧循环，交给下一轮轮询或下一条事件。
      if (!failed && (canPushEvents() || pendingWake)) schedulePush()
    }
  }
}

function canPushEvents() {
  return !eventBatchFlight && !eventBatchPollOnly && (pendingEventBatch || eventBuffer.length)
}

function claimEventBatch(transport) {
  if (eventBatchFlight || (transport === 'push' && eventBatchPollOnly)) return null
  if (!pendingEventBatch && eventBuffer.length) {
    pendingEventBatch = Object.freeze({
      id: `${eventBatchPrefix}-${++eventBatchSeq}`,
      events: Object.freeze(takeEvents())
    })
  }
  if (!pendingEventBatch) return null
  eventBatchFlight = { batch: pendingEventBatch }
  return eventBatchFlight
}

function finishEventBatch(flight, acknowledged) {
  if (!flight || eventBatchFlight !== flight) return
  eventBatchFlight = null
  if (acknowledged) pendingEventBatch = null
  eventBatchPollOnly = !acknowledged
}

function takeEvents() {
  if (!eventBuffer.length) return []
  const frames = eventBuffer
  const size = eventBytes
  eventBuffer = []
  eventBytes = 0
  if (settings.debug) {
    const histogram = new Map()
    for (const frame of frames) {
      const key = `${frame.channel}:${frame.payload?.event?.type || ''}`
      histogram.set(key, (histogram.get(key) || 0) + 1)
    }
    const top = [...histogram.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([key, count]) => `${key}×${count}`)
      .join(' ')
    log(`[events] flush ${frames.length} frames / ${size}B  ${top}`)
  }
  return frames
}

/* ---------------------------------------------------------------- 命令 */

function queueResult(result, startedGeneration) {
  if (stopping || startedGeneration !== generation) return
  pendingResults.push(result)
  pendingWake = true
  schedulePush()
}

function startCommand(command) {
  const startedGeneration = generation
  if (activeCommands.size >= MAX_ACTIVE_COMMANDS) {
    queueResult({ id: command?.id, ok: false, status: 429, error: 'Bridge busy: too many active commands; retry later' }, startedGeneration)
    return
  }
  const task = runCommand(command).then((result) => {
    activeCommands.delete(task)
    queueResult(result, startedGeneration)
  })
  activeCommands.add(task)
}

async function runCommand(command) {
  const channel = String(command?.channel || '')
  const payload = command?.payload ?? {}
  try {
    if (channel === '__image') {
      const result = await readImage(String(payload?.path || ''))
      return { id: command.id, ...result }
    }
    if (channel === '__paste-image') {
      const result = await pasteImage(String(payload?.dataUrl || ''))
      return { id: command.id, ...result }
    }
    if (channel === '__attachment') {
      return { id: command.id, ...await saveAttachment(payload) }
    }
    const result = await localInvoke(channel, payload)
    if (!result.ok) {
      return { id: command.id, channel, payload, ok: false, error: explainError(channel, result.error) }
    }

    const json = JSON.stringify(result.result ?? null)
    const hash = createHashOf(json)
    return { id: command.id, channel, payload, ok: true, hash, result: result.result }
  } catch (error) {
    return { id: command?.id, ok: false, error: String(error?.message || error) }
  }
}

/**
 * 运行时不认识某条通道时，它报的是 `No handler registered for 'x'`。手机端看到这句话
 * 只会以为是权限问题（之前正是如此），所以说清楚：这台机器的运行时没有它。
 */
function explainError(channel, error) {
  const text = String(error || '')
  if (!/no handler|not registered|unknown channel/i.test(text)) return text
  return `这台机器的运行时不提供 ${channel}（${text}）。它通常属于桌面外壳的窗口能力，手机端没有。`
}

/** 只为去重，不需要密码学强度。 */
function createHashOf(text) {
  return createHash('sha1').update(text).digest('hex')
}

function resultKey(item) {
  return `${item.channel}\u0000${JSON.stringify(item.payload ?? {})}`
}

function clearResultCache(cache) {
  cache.entries.clear()
  cache.bytes = 0
}

function rememberResult(cache, item) {
  if (item.ok !== true || typeof item.hash !== 'string' || item.unchanged) return
  const key = resultKey(item)
  const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(item.result ?? null))
  const previous = cache.entries.get(key)
  if (previous) cache.bytes -= previous.bytes
  cache.entries.delete(key)
  if (bytes > RESULT_CACHE_BYTES) return
  cache.entries.set(key, { hash: item.hash, bytes })
  cache.bytes += bytes
  while (cache.entries.size > RESULT_CACHE_LIMIT || cache.bytes > RESULT_CACHE_BYTES) {
    const oldest = cache.entries.keys().next().value
    cache.bytes -= cache.entries.get(oldest).bytes
    cache.entries.delete(oldest)
  }
}

/** 按回传顺序去重，不能让先完成的后一个请求被前一个请求引用。 */
function resultsForPoll(results) {
  const known = { entries: new Map(resultHashes.entries), bytes: resultHashes.bytes }
  return results.map((item) => {
    if (item.ok === true && typeof item.hash === 'string' && known.entries.get(resultKey(item))?.hash === item.hash) {
      const { result, ...rest } = item
      return { ...rest, unchanged: true }
    }
    rememberResult(known, item)
    return item
  })
}

/* ---------------------------------------------------------------- 主循环 */

async function tick() {
  if (stopping) return
  const nextSettings = readSettings()
  if (nextSettings.relayUrl !== settings.relayUrl || nextSettings.token !== settings.token) {
    // 切换机器身份时，旧调用的结果、缓存和事件都只属于原来的中转机。
    generation++
    CHANNEL_KEY = deriveKey(nextSettings.token)
    pendingResults = []
    pendingWake = false
    clearResultCache(resultHashes)
    eventBuffer = []
    eventBytes = 0
    pendingEventBatch = null
    eventBatchFlight = null
    eventBatchPollOnly = false
    clearTimeout(pushTimer)
    pushTimer = null
    pushRunning = false
    wanted = false
    relayParams = { intervalMs: 15_000, watch: null }
    labelPending = hostname()
    pollFailures = 0
  }
  settings = nextSettings

  let intervalMs = relayParams.intervalMs
  const startedGeneration = generation
  const flight = claimEventBatch('poll')
  const events = flight?.batch.events || []
  let resultBytes = 2
  let resultCount = 0
  for (let index = 0; index < pendingResults.length; index++) {
    let item = pendingResults[index]
    let bytes = Buffer.byteLength(JSON.stringify(item))
    if (bytes + 2 > RESULT_BATCH_BYTES) {
      item = { id: item.id, ok: false, status: 413, error: 'Bridge result too large: exceeds 18 MiB JSON limit' }
      pendingResults[index] = item
      bytes = Buffer.byteLength(JSON.stringify(item))
    }
    if (resultBytes + bytes + (resultCount ? 1 : 0) > RESULT_BATCH_BYTES) break
    resultBytes += bytes + (resultCount ? 1 : 0)
    resultCount++
  }
  const results = pendingResults.splice(0, resultCount)
  pendingWake = false
  const env = envPayload

  try {
    const sentResults = resultsForPoll(results)
    const body = { events, ...(flight ? { eventBatchId: flight.batch.id } : {}), results: sentResults, watch: relayParams.watch }
    if (env) body.env = env
    if (labelPending) body.label = labelPending
    const started = Date.now()
    const rawBytes = Buffer.byteLength(JSON.stringify(body))
    const response = await relayPoll(body)
    if (stopping || startedGeneration !== generation) return
    finishEventBatch(flight, true)
    if (canPushEvents() || pendingWake) schedulePush()
    pollFailures = 0
    if (envPayload === env) envPayload = null
    labelPending = ''
    const nextInterval = Number(response?.intervalMs)
    if (Number.isFinite(nextInterval) && nextInterval >= 0) relayParams.intervalMs = nextInterval
    intervalMs = relayParams.intervalMs

    wanted = response?.wanted === true
    const retryResultIds = new Set(Array.isArray(response?.retryResultIds) ? response.retryResultIds : [])
    if (response?.resetCache || retryResultIds.size) clearResultCache(resultHashes)
    else for (const item of sentResults) rememberResult(resultHashes, item)
    if (retryResultIds.size) pendingResults.unshift(...results.filter((item) => retryResultIds.has(item.id)))
    if (!wanted) {
      eventBuffer = []
      eventBytes = 0
    }

    log(
      `[poll] ${Date.now() - started}ms raw=${rawBytes}B ` +
        `ev=${events.length} cmd=${response?.commands?.length || 0}`
    )

    const commands = Array.isArray(response?.commands) ? response.commands : []
    if (commands.length) {
      for (const command of commands) startCommand(command)
      intervalMs = 0
    }
    if (pendingResults.length) intervalMs = 0
  } catch (error) {
    if (stopping || startedGeneration !== generation) return
    finishEventBatch(flight, false)
    // 结果按 id 结算，重复回传是幂等的；丢掉它们会让已经执行完的操作等到超时。
    pendingResults.unshift(...results)
    clearResultCache(resultHashes)
    log('[poll] failed:', String(error?.message || error))
    intervalMs = retryDelay(++pollFailures)
  }

  if (stopping) return
  // main() 已经负责下一轮；额外调 tick 会在每次执行命令后多出一条并行轮询。
  if (intervalMs <= 0) return
  await sleep(intervalMs)
}

async function main() {
  envPayload = await readLocalEnv()
  if (stopping) return
  if (state_ok()) void subscribeLocalEvents()
  log(`[relay-agent] ${settings.localUrl} -> ${settings.relayUrl}`)
  while (!stopping) {
    if (!parentAlive()) {
      log('[relay-agent] 父进程已退出，桥自行结束')
      await stopBridge()
      return
    }
    await tick()
  }
}

// 宿主被杀（SIGKILL / 崩溃）时 onDispose 跑不到，桥要自己退出，否则会留下一直轮询的孤儿进程
function parentAlive() {
  const pid = Number(process.env.MICA_RELAY_PARENT_PID || 0)
  if (!pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function state_ok() {
  // 事件订阅始终建立：它是回环流量，不出网；真正的出网开关在 tick 的时段门禁里
  return true
}

async function stopBridge() {
  if (stopping) return
  stopping = true
  clearTimeout(pushTimer)
  const deadline = setTimeout(() => process.exit(0), 1000)
  try {
    await requestLog.close()
  } finally {
    clearTimeout(deadline)
    process.exit(0)
  }
}

process.on('SIGTERM', () => { void stopBridge() })
process.on('SIGINT', () => { void stopBridge() })

void main()
