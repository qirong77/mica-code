import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { applyUiStatePatch, uiStateValuesEqual } from '@packages/mica-web-shared'

/**
 * 页面侧的界面状态：与运行时同源（见 host/ui-state.js）。
 *
 * 单一实例架构下页面不再各自留一份界面状态——输入框草稿、打开的对话页签、面板布局都
 * 只有运行时那一份：页面读到什么就是当前值，改了就写回去。于是第二个窗口不是「另一处」，
 * 它渲染的就是同一份界面；刷新/重启后还是上一次的样子（运行时落盘）。
 *
 * 写入是「本地先落地 + 攒一下再发」：拖动分隔条必须跟手，而每次 pointermove 都发一次
 * 请求没有意义。自己写出去的值广播回来时可能已经落后于本页最新值（打字、拖动会连着写
 * 好几次），直接应用会把界面往回拽，所以按「键 + 值」记一份未认领的回声计数，
 * 收到自己的回声就丢掉。
 */

let keys = {}
const listeners = new Set()
let booted = null
let pending = {}
let flushTimer = null
const keyVersions = new Map()
const inFlight = new Map()
let snapshotGeneration = 0
const outbound = new Map() // key -> Map<值的序列化, 尚未认领的回声数>
// 每个键最后一次写入的时刻：广播丢失时（页面重载、运行时重启、连接断开那一瞬），
// 未认领的计数就永远留在这里。键里含会话 id 与输入框草稿文本，切会话越多留得越多。
const outboundAt = new Map()
const OUTBOUND_TTL_MS = 60_000

const FLUSH_DEBOUNCE_MS = 80

function serialized(value) {
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    // 循环引用之类序列化不了的值：给一个不可能与任何广播相等的记号（self-write 计数）
    return `!${Math.random()}`
  }
}

function emit() {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.error('[mica] ui-state listener failed', error)
    }
  }
}

export function uiStateKeys() {
  return keys
}

export function subscribeUiState(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function applyLocal(patch) {
  const next = applyUiStatePatch(keys, patch)
  if (!next) return false
  keys = next
  emit()
  return true
}

function markChanged(key) {
  keyVersions.set(key, (keyVersions.get(key) || 0) + 1)
}

function rememberOutbound(key, value) {
  const json = serialized(value)
  let counts = outbound.get(key)
  if (!counts) outbound.set(key, (counts = new Map()))
  counts.set(json, (counts.get(json) || 0) + 1)
  outboundAt.set(key, Date.now())
  pruneOutbound()
}

/** 丢掉久未认领的计数：正常回声在几十毫秒内就到，留一分钟已经非常宽松。 */
function pruneOutbound(now = Date.now()) {
  if (outboundAt.size <= 64) return
  for (const [key, at] of outboundAt) {
    if (now - at < OUTBOUND_TTL_MS) continue
    outboundAt.delete(key)
    outbound.delete(key)
  }
}

/**
 * 这条广播是本页自己那次写入的回声吗？是就丢掉——回声可能落后于本页最新值（打字、拖动
 * 会连着写好几次），直接应用会把界面往回拽。按「键 + 值」计数而不是只记最后一次写入，
 * 这样多次写入的多个回声（到达顺序也不保证）都能各自认领。
 *
 * **只由 `applyRemote` 调用**：同一个键可能有多个消费者（每个挂载中的 ChatView 都读
 * `drafts`），认领一旦散到各个组件里就会变成「谁先跑到谁吃掉」，晚到的那个把滞后的广播
 * 值当外部改动应用回去——正在打字的输入框于是被回写成上一个字符的值。
 */
export function claimUiStateEcho(key, value) {
  const counts = outbound.get(key)
  if (!counts) return false
  const json = serialized(value)
  const count = counts.get(json) || 0
  if (!count) return false
  if (count === 1) counts.delete(json)
  else counts.set(json, count - 1)
  // 计数清空后把键本身也删掉：否则 Map 只会因为「出现过新的键」而增长。
  if (counts.size === 0) {
    outbound.delete(key)
    outboundAt.delete(key)
  }
  return true
}

/**
 * 广播（或初始快照）进来了：先逐键认领本页自己写出去的回声，**只把真正来自别处的键**
 * 合并到本地。
 *
 * 认领必须只在这里发生，而且只做这一次：同一个键会被多个组件同时读取（`drafts` 对应
 * 每个挂载中的 ChatView），谁先认领谁就把计数吃掉，后面那些消费者只看到「不是我的回声」，
 * 于是把运行时的滞后值应用回去。
 */
function applyRemote(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return
  const external = {}
  for (const [key, value] of Object.entries(patch)) {
    if (claimUiStateEcho(key, value)) continue
    markChanged(key)
    external[key] = value
  }
  applyLocal(external)
}

function sendPending() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const patch = pending
  pending = {}
  if (Object.keys(patch).length === 0) return Promise.resolve()
  for (const [key, value] of Object.entries(patch)) {
    rememberOutbound(key, value)
    inFlight.set(key, (inFlight.get(key) || 0) + 1)
  }
  return Promise.resolve(window.mica.uiState.patch(patch)).catch((error) => {
    console.error('[mica] 保存界面状态失败', error)
  }).finally(() => {
    for (const key of Object.keys(patch)) {
      const count = inFlight.get(key) - 1
      if (count) inFlight.set(key, count)
      else inFlight.delete(key)
    }
  })
}

/** 立刻把攒着的改动发出去（页面即将卸载时用）。 */
export function flushUiState() {
  return sendPending()
}

export function setUiState(key, value) {
  if (uiStateValuesEqual(keys[key], value)) return
  markChanged(key)
  applyLocal({ [key]: value })
  pending = { ...pending, [key]: value }
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void sendPending()
  }, FLUSH_DEBOUNCE_MS)
}

/**
 * 改一个键里的某一条：这种键的值是「一整个对象」（草稿表），合并后再写回，直接覆盖整键
 * 会把别的页面刚写进去的条目抹掉。`null` 表示把这条删掉，而不是写一个 null 进去。
 */
export function setUiStateEntries(key, entries) {
  const next = { ...(keys[key] || {}), ...entries }
  for (const [entry, value] of Object.entries(entries)) {
    if (value === null || value === undefined) delete next[entry]
  }
  setUiState(key, next)
}

/**
 * 订阅一个键：别的键变化时快照引用不变，React 就不会重渲染。
 *
 * 之前整个表订阅，任何一次输入（`drafts` 每敲一个字都写一次）都会让所有读者
 * 重渲染——App、最多 5 个挂载中的 ChatView、整棵会话树都跟着跑一遍。快照取
 * `keys[key]` 而不是 `keys` 之后，只有真正改了这个键的组件更新。
 */
export function useUiStateValue(key, fallback) {
  const read = useCallback(() => keys[key], [key])
  const value = useSyncExternalStore(subscribeUiState, read, read)
  return value === undefined ? fallback : value
}

async function refreshUiState() {
  const generation = ++snapshotGeneration
  const versions = new Map(keyVersions)
  const writing = new Set([...Object.keys(pending), ...inFlight.keys()])
  const snapshot = await window.mica.uiState.get()
  if (generation !== snapshotGeneration || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return
  const patch = {}
  for (const key of new Set([...Object.keys(keys), ...Object.keys(snapshot)])) {
    if (writing.has(key) || Object.hasOwn(pending, key) || inFlight.has(key)) continue
    if ((versions.get(key) || 0) !== (keyVersions.get(key) || 0)) continue
    patch[key] = Object.hasOwn(snapshot, key) ? snapshot[key] : null
  }
  applyLocal(patch)
}

/** 挂载前先把运行时的界面状态取回来，页面第一帧就是正确的值（避免闪一下再对齐）。 */
export async function ensureUiState() {
  if (booted) return booted
  booted = (async () => {
    window.mica.uiState.onChanged((payload) => applyRemote(payload?.keys || {}))
    window.addEventListener('mica:transport-resync', () => {
      // 初始快照必须先落地，才能让 ensureUiState 结束并挂载输入框。
      void booted.then(() => refreshUiState()).catch((error) => console.error('[mica] 同步界面状态失败', error))
    })
    await refreshUiState()
  })()
  return booted
}

/**
 * 一个键的读写：本地立刻生效并写回运行时，别的页面改了同一键时本页跟着变。
 */
export function useSharedState(key, initial) {
  const remote = useUiStateValue(key, undefined)
  const [value, setValue] = useState(() => (remote === undefined ? initial : remote))
  const valueRef = useRef(value)
  valueRef.current = value

  useEffect(() => {
    if (remote === undefined) return
    // 回声已经在广播入口（applyRemote）统一认领过，这里拿到的都是真正的外部改动。
    if (uiStateValuesEqual(remote, valueRef.current)) return
    valueRef.current = remote
    setValue(remote)
  }, [key, remote])

  const update = useCallback(
    (next) => {
      const resolved = typeof next === 'function' ? next(valueRef.current) : next
      valueRef.current = resolved
      setValue(resolved)
      setUiState(key, resolved)
    },
    [key]
  )

  return [value, update]
}

if (typeof window !== 'undefined') {
  // 卸载时把攒着的改动发出去（浏览器不保证定时器还能跑）。
  window.addEventListener('pagehide', () => {
    void flushUiState()
  })
}
