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
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'

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
    activeHours: pick('activeHours', 'RELAY_ACTIVE_HOURS'),
    activeDays: pick('activeDays', 'RELAY_ACTIVE_DAYS'),
    jitter: Number(pick('jitter', 'RELAY_JITTER') || 35),
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

/* ---------------------------------------------------------------- 时段 */

/** `08:30-12:00,13:30-18:30`；空串表示不限。`end < start` 视为跨午夜。 */
function parseWindows(spec) {
  const text = String(spec || '').trim()
  if (!text) return null
  const windows = []
  for (const part of text.split(',')) {
    const match = part.trim().match(/^(\d{1,2}):(\d{2})\s*[-~]\s*(\d{1,2}):(\d{2})$/)
    if (!match) continue
    windows.push({ start: Number(match[1]) * 60 + Number(match[2]), end: Number(match[3]) * 60 + Number(match[4]) })
  }
  return windows.length ? windows : null
}

/** `1-5` 表示周一到周五（0 是周日）；空串表示每天。 */
function parseDays(spec) {
  const text = String(spec || '').trim()
  if (!text) return null
  const days = new Set()
  for (const part of text.split(',')) {
    const range = part.trim().match(/^(\d)\s*-\s*(\d)$/)
    if (range) {
      for (let day = Number(range[1]); day <= Number(range[2]); day += 1) days.add(day)
      continue
    }
    if (/^\d$/.test(part.trim())) days.add(Number(part.trim()))
  }
  return days.size ? days : null
}

function nextOpen(now, windows, days) {
  const list = windows || [{ start: 0, end: 1440 }]
  for (let offset = 0; offset <= 7; offset += 1) {
    const probe = new Date(now.getTime() + offset * 86_400_000)
    if (days && !days.has(probe.getDay())) continue
    for (const window of list) {
      const at = new Date(
        probe.getFullYear(),
        probe.getMonth(),
        probe.getDate(),
        Math.floor(window.start / 60),
        window.start % 60,
        0,
        0
      )
      if (at.getTime() > now.getTime()) return at.getTime()
    }
  }
  return now.getTime() + 3_600_000
}

function gate(now = new Date()) {
  const windows = parseWindows(settings.activeHours)
  const days = parseDays(settings.activeDays)
  if (!windows && !days) return { allowed: true }

  const minutes = now.getHours() * 60 + now.getMinutes()
  const dayOk = !days || days.has(now.getDay())
  if (dayOk) {
    for (const window of windows || [{ start: 0, end: 1440 }]) {
      const inside =
        window.end >= window.start
          ? minutes >= window.start && minutes < window.end
          : minutes >= window.start || minutes < window.end
      if (inside) return { allowed: true }
    }
  }
  return { allowed: false, nextOpenAt: nextOpen(now, windows, days) }
}

function scheduleLabel() {
  const windows = String(settings.activeHours || '').trim()
  const days = String(settings.activeDays || '').trim()
  if (!windows) return ''
  return days ? `${windows} 周${days}` : windows
}

/* ---------------------------------------------------------------- 传输 */

/**
 * 二进制 POST。自签证书时不做链校验——内容本身由 AES-GCM 保证完整性，
 * 证书只影响「连的是不是那台机器」，而口令派生密钥已经覆盖了这一点。
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
        headers: { 'content-type': 'application/octet-stream', 'content-length': body.length },
        rejectUnauthorized: settings.verifyTls,
        timeout: 30_000
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }))
      }
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(body)
  })
}

async function relayPoll(body) {
  const response = await postBinary(`${settings.relayUrl}/api/poll`, seal({ ...body, ts: Date.now() }))
  if (response.status === 401) throw new Error('口令不匹配，或被中间设备改写')
  if (response.status !== 200) throw new Error(`relay HTTP ${response.status}`)
  return open(response.body)
}

/* ---------------------------------------------------------------- 事件 */

const ALLOWED = new Set([
  // 对话本身
  'chat:start',
  'chat:abort',
  'chat:is-running',
  'chat:history',
  'chat:meta',
  'chat:models',
  'chat:roles',
  'chat:edit-message',
  'chat:fork',
  'chat:compact',
  'chat:rename-session',
  'chat:check-cwd',
  'chat:update-cwd',
  'chat:dispose',
  'chat:hold-queued',
  'chat:recall-queued',
  'chat:input-history:read',
  'chat:input-history:append',
  // 会话级设置：能力开关、笔记、插件设置
  'chat:capabilities',
  'chat:set-capabilities',
  'chat:notes',
  'chat:set-notes',
  'chat:plugin-settings',
  // 后台任务与子代理：只看、只停
  'chat:background-task-output',
  'chat:kill-background-task',
  'chat:subagent-detail',
  'chat:kill-subagent',
  // 旁问
  'chat:btw-threads',
  'chat:btw-compact',
  'chat:btw-interrupt',
  'chat:btw-recall',
  'chat:btw-close',
  // 会话清单 / 统计 / 搜索
  'stats:list-sessions',
  'stats:list-pins',
  'stats:list-projects',
  'stats:list-sort',
  'stats:list-annotations',
  'stats:read',
  'stats:session-detail',
  'stats:session-title',
  'stats:search-sessions',
  'stats:set-annotation',
  'stats:set-sort',
  'stats:move-session',
  'stats:delete-session',
  'stats:create-project-group',
  'stats:delete-project-group',
  'stats:move-project-group',
  'stats:rename-project-group',
  // 共享 UI 状态：页签、工作区、布局、草稿
  'ui-state:get',
  'ui-state:patch',
  // 只读文件视图：手机上不改文件，写操作刻意不放行
  'files:list',
  'files:read',
  'files:stat',
  'files:search',
  'files:mention',
  'files:find',
  'files:order-get',
  // Git 只读
  'git:status',
  'git:summary',
  'git:branch-summary',
  'git:file',
  'git:refs',
  'git:resolve-ref',
  // 技能索引、MCP 候选、通知、访问信息
  'skills:list',
  'mcp:candidates',
  'notify:list',
  'notify:mark-read',
  'access:info',
  // 插件卡片的前端能力：探活、数据、访问策略
  'plugin-host:probe',
  'plugin-host:read-data',
  'plugin-host:write-data',
  'plugin-host:access-get',
  'plugin-host:access-set',
  // 定时循环
  'loops:list',
  'loops:start',
  'loops:stop',
  'loops:set-interval',
  'loops:set-task',
  'loops:set-status',
  'loops:fire-now'
])

/**
 * 刻意不放行的通道，写在这里是为了让「为什么没有它」有据可查：
 *
 * - `terminal:*` / `dialog:*` / `clipboard:*` / `browser-control:*`：依赖这台机器的
 *   GUI 与会话，手机端做不了，放行也只是报错；
 * - `files:write|create|delete|move|rename|duplicate|copy-*`：手机上不改文件；
 * - `git:stage|unstage|discard|checkout|create-branch`：会改工作区；
 * - `config-web:invoke`：配置页能改 provider 与密钥，等于把整台机器交出去；
 * - `chat:save-pasted-image`：往磁盘写文件。
 */

const MAX_EVENT_FRAMES = 4000
const MAX_EVENT_BYTES = 1_500_000

let eventBuffer = []
let eventBytes = 0
let relayParams = { intervalMs: 6000, watch: null }
/** 中转机是否有人在看。没人看时不攒事件、不催轮询。 */
let wanted = false
const resultHashes = new Map()
let pendingResults = []
let envPayload = null
let offlineReported = false
let stopping = false

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
  if (!frame || typeof frame.channel !== 'string') return
  if (!wanted) return
  eventBuffer.push(frame)
  eventBytes += JSON.stringify(frame).length
  while (eventBuffer.length > MAX_EVENT_FRAMES || eventBytes > MAX_EVENT_BYTES) {
    const dropped = eventBuffer.shift()
    if (!dropped) break
    eventBytes -= JSON.stringify(dropped).length
  }
  if (frame.channel === 'chat:event') wakeUp()
}

let wakeTimer = null
let wakeResolve = null
function wakeUp() {
  if (!wakeResolve) return
  const resolve = wakeResolve
  wakeResolve = null
  if (wakeTimer) clearTimeout(wakeTimer)
  wakeTimer = null
  resolve()
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

async function runCommand(command) {
  const channel = String(command?.channel || '')
  const payload = command?.payload ?? {}
  try {
    if (channel === '__image') {
      const result = await readImage(String(payload?.path || ''))
      return { id: command.id, ...result }
    }
    if (!ALLOWED.has(channel)) return { id: command.id, ok: false, error: `远程不支持 ${channel}` }

    const result = await localInvoke(channel, payload)
    if (!result.ok) return { id: command.id, channel, payload, ok: false, error: result.error }

    const json = JSON.stringify(result.result ?? null)
    const hash = createHashOf(json)
    const key = `${channel}\u0000${JSON.stringify(payload)}`
    if (resultHashes.get(key) === hash) return { id: command.id, channel, payload, ok: true, unchanged: true, hash }
    resultHashes.set(key, hash)
    return { id: command.id, channel, payload, ok: true, hash, result: result.result }
  } catch (error) {
    return { id: command.id, ok: false, error: String(error?.message || error) }
  }
}

/** 只为去重，不需要密码学强度。 */
function createHashOf(text) {
  return createHash('sha1').update(text).digest('hex')
}

/* ---------------------------------------------------------------- 主循环 */

function jitter(ms) {
  const percent = Math.max(0, Math.min(80, settings.jitter))
  const factor = 1 + ((Math.random() * 2 - 1) * percent) / 100
  return Math.max(200, Math.round(ms * factor))
}

async function reportOffline(nextOpenAt) {
  try {
    await relayPoll({
      // 由这台机器按本地时区格式化：中转机可能在别的时区，它算出来的钟点会差几个小时
      offline: { until: nextOpenAt, label: formatClock(nextOpenAt), windows: scheduleLabel() },
      events: [],
      results: [],
      watch: relayParams.watch
    })
    log(`[schedule] 已通知中转机下线，${new Date(nextOpenAt).toLocaleString()} 恢复`)
  } catch (error) {
    log('[schedule] 通知失败:', String(error?.message || error))
  }
}

function formatClock(timestamp) {
  const when = new Date(timestamp)
  const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
  const today = new Date()
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate()
  return sameDay ? time : `${when.getMonth() + 1}/${when.getDate()} ${time}`
}

/** 睡到允许时段开始；分段睡，顺带让配置改动能在 1 分钟内生效。 */
async function sleepUntil(target) {
  let until = target
  while (!stopping && Date.now() < until) {
    await sleep(Math.min(60_000, until - Date.now()))
    settings = readSettings()
    CHANNEL_KEY = deriveKey(settings.token)
    const state = gate()
    if (state.allowed) return
    // 配置可能被改过，按新的下次开启时间重算，两个方向都能在 1 分钟内生效
    until = state.nextOpenAt
  }
}

async function tick() {
  settings = readSettings()

  const state = gate()
  if (!state.allowed) {
    if (!offlineReported) {
      await reportOffline(state.nextOpenAt)
      offlineReported = true
    }
    await sleepUntil(state.nextOpenAt)
    offlineReported = false
    return
  }

  let intervalMs = relayParams.intervalMs
  const events = takeEvents()
  const results = pendingResults
  pendingResults = []

  try {
    const body = { events, results, watch: relayParams.watch }
    if (envPayload) {
      body.env = envPayload
      envPayload = null
    }
    const started = Date.now()
    const rawBytes = Buffer.byteLength(JSON.stringify(body))
    const response = await relayPoll(body)
    relayParams.intervalMs = Number(response?.intervalMs) || intervalMs
    intervalMs = relayParams.intervalMs

    wanted = response?.wanted === true
    if (response?.resetCache) resultHashes.clear()
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
      const finished = await Promise.all(commands.map((command) => runCommand(command)))
      pendingResults.push(...finished)
      intervalMs = 0
    }
  } catch (error) {
    log('[poll] failed:', String(error?.message || error))
    intervalMs = 5000
  }

  if (stopping) return
  if (intervalMs <= 0) return void setImmediate(tick)
  await new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      wakeResolve = null
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, jitter(intervalMs))
    wakeResolve = finish
  })
}

async function main() {
  envPayload = await readLocalEnv()
  if (state_ok()) void subscribeLocalEvents()
  log(`[relay-agent] ${settings.localUrl} -> ${settings.relayUrl}  时段=${scheduleLabel() || '不限'}  抖动=${settings.jitter}%`)
  while (!stopping) await tick()
}

function state_ok() {
  // 事件订阅始终建立：它是回环流量，不出网；真正的出网开关在 tick 的时段门禁里
  return true
}

process.on('SIGTERM', () => {
  stopping = true
  process.exit(0)
})
process.on('SIGINT', () => {
  stopping = true
  process.exit(0)
})

void main()
