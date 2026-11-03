import { useCallback, useEffect, useState } from 'react'
import { readPluginsDetails, subscribePluginsDetails } from './plugins-details'

/**
 * 侧栏 Plugins 入口上那枚提示点。
 *
 * 插件可以往自己的 `plugin-data/<id>/data.json` 里写一条 `attention`（「手机端页面落后，
 * 点一下同步」）——那件事只有用户点一下才会变好，而入口藏在「Plugins → 某张卡 → 操作」里，
 * 不点开就永远看不见。所以宿主在入口上点一个点：有提示点就说明「有个插件在等人动手」。
 *
 * 数据来自配置页那份插件数据（`readPluginsDetails`），这里只挑「当前显示哪一个」——
 * 宿主不认识任何具体插件，也不解释提示的语义，只把插件写的 `text` 原样放进 tooltip。
 *
 * 一条提示只点一次：**点开它就等于看过了**（记在本地，按插件 + 文案去重）。插件那边的
 * `attention` 是「页面落后」这个持续状态算出来的，只要版本没变就会一直上报；宿主照着
 * 原样常亮，等于把一个状态做成了永远关不掉的通知。文案里带着版本号，所以本机重新构建、
 * 中转机换了另一份时是另一条提示，会重新出现。
 */

/** 提示点的刷新节奏：插件是运行时写这份文件的，页面开着就该跟上，但不必按秒问。 */
export const ATTENTION_POLL_MS = 30_000

/** 「看过」的记忆。只记指纹，不记文案以外的东西；最多留这么多条。 */
const SEEN_STORAGE_KEY = 'mica.plugin-attention.seen'
const MAX_SEEN = 20

function localStore() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** 一条提示的身份：同一个插件换了一条文案就是新的一条。 */
export function attentionFingerprint(attention) {
  if (!attention || typeof attention.pluginId !== 'string' || typeof attention.text !== 'string') return ''
  return `${attention.pluginId}:${attention.text}`
}

function readSeen() {
  const store = localStore()
  if (!store) return []
  try {
    const parsed = JSON.parse(store.getItem(SEEN_STORAGE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

function writeSeen(seen) {
  const store = localStore()
  if (!store) return
  try {
    store.setItem(SEEN_STORAGE_KEY, JSON.stringify(seen.slice(-MAX_SEEN)))
  } catch {
    // 存不进去只是下次还会点一次点，不影响功能
  }
}

/** 记下「这一条看过了」；之后同一文案不再点亮侧栏。 */
export function markAttentionSeen(attention) {
  const fingerprint = attentionFingerprint(attention)
  if (!fingerprint) return
  const seen = readSeen()
  if (seen.includes(fingerprint)) return
  writeSeen([...seen, fingerprint])
}

/**
 * 从插件列表里挑出该显示的那一条提示。
 *
 * 只看已启用的插件：停用的插件不会运行，它的提示是过时的。多个插件同时有提示时取第一个
 * ——入口只有一个点，点进去是插件目录，用户能看到全部。`seen` 里的（用户点开过的）跳过。
 */
export function pickPluginAttention(plugins, seen = []) {
  if (!Array.isArray(plugins)) return null
  const tried = new Set(Array.isArray(seen) ? seen : [])
  for (const plugin of plugins) {
    if (!plugin || plugin.state !== 'enabled') continue
    const attention = plugin.attention
    if (!attention || typeof attention.text !== 'string' || !attention.text.trim()) continue
    const text = attention.text.trim()
    const fingerprint = `${plugin.id}:${text}`
    if (tried.has(fingerprint)) continue
    return {
      pluginId: plugin.id,
      pluginName: plugin.name || plugin.id,
      text,
      tone: attention.tone === 'error' ? 'error' : 'warn'
    }
  }
  return null
}

/**
 * 轮询插件提示。
 *
 * 页面不可见时不问：切回窗口的第一次 tick 会重新取一份，比在后台白白轮询省事。
 */
export function usePluginAttention() {
  const [attention, setAttention] = useState(null)

  useEffect(() => {
    let alive = true
    const tick = async () => {
      if (document.visibilityState === 'hidden') return
      const plugins = await readPluginsDetails({ force: true })
      if (alive) setAttention(pickPluginAttention(plugins, readSeen()))
    }
    void tick()
    // 启停之后立刻重算：停用的插件不该在侧栏继续留着那枚提示点。
    const unsubscribe = subscribePluginsDetails(() => void tick())
    const timer = setInterval(() => void tick(), ATTENTION_POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      unsubscribe()
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  // 点开那一下就是「看见了」：记下来并立刻收掉，不必等下一跳重新拉一遍。
  const dismiss = useCallback(() => {
    markAttentionSeen(attention)
    setAttention(null)
  }, [attention])

  return { attention, dismiss }
}
