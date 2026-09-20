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
const outbound = new Map() // key -> Map<值的序列化, 尚未认领的回声数>

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

function rememberOutbound(key, value) {
  const json = serialized(value)
  let counts = outbound.get(key)
  if (!counts) outbound.set(key, (counts = new Map()))
  counts.set(json, (counts.get(json) || 0) + 1)
}

/**
 * 这条广播是本页自己那次写入的回声吗？是就丢掉——回声可能落后于本页最新值（打字、拖动
 * 会连着写好几次），直接应用会把界面往回拽。按「键 + 值」计数而不是只记最后一次写入，
 * 这样多次写入的多个回声（到达顺序也不保证）都能各自认领。
 */
export function claimUiStateEcho(key, value) {
  const counts = outbound.get(key)
  if (!counts) return false
  const json = serialized(value)
  const count = counts.get(json) || 0
  if (!count) return false
  if (count === 1) counts.delete(json)
  else counts.set(json, count - 1)
  return true
}

function sendPending() {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const patch = pending
  pending = {}
  if (Object.keys(patch).length === 0) return Promise.resolve()
  for (const [key, value] of Object.entries(patch)) rememberOutbound(key, value)
  return Promise.resolve(window.mica.uiState.patch(patch)).catch((error) => {
    console.error('[mica] 保存界面状态失败', error)
  })
}

/** 立刻把攒着的改动发出去（页面即将卸载时用）。 */
export function flushUiState() {
  return sendPending()
}

export function setUiState(key, value) {
  if (uiStateValuesEqual(keys[key], value)) return
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

export function useUiStateValue(key, fallback) {
  const table = useSyncExternalStore(subscribeUiState, uiStateKeys, uiStateKeys)
  return table[key] === undefined ? fallback : table[key]
}

/** 挂载前先把运行时的界面状态取回来，页面第一帧就是正确的值（避免闪一下再对齐）。 */
export async function ensureUiState() {
  if (booted) return booted
  booted = (async () => {
    const initial = await window.mica.uiState.get()
    applyLocal(initial || {})
    // 先取回快照再订阅：反过来的话，订阅与取回之间发生的变更会被更旧的回包覆盖掉。
    window.mica.uiState.onChanged((payload) => applyLocal(payload?.keys || {}))
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
    // 先认领回声：认领必须无条件发生，否则计数会漏，之后真的远端改动会被吞掉。
    if (claimUiStateEcho(key, remote)) return
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
