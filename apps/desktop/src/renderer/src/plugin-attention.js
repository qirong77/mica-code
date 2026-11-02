import { useEffect, useState } from 'react'
import { readPluginsDetails } from './plugins-details'

/**
 * 侧栏 Plugins 入口上那枚提示点。
 *
 * 插件可以往自己的 `plugin-data/<id>/data.json` 里写一条 `attention`（「手机端页面落后，
 * 点一下同步」）——那件事只有用户点一下才会变好，而入口藏在「Plugins → 某张卡 → 操作」里，
 * 不点开就永远看不见。所以宿主在入口上点一个点：有提示点就说明「有个插件在等人动手」。
 *
 * 数据来自配置页那份插件数据（`readPluginsDetails`），这里只挑「当前显示哪一个」——
 * 宿主不认识任何具体插件，也不解释提示的语义，只把插件写的 `text` 原样放进 tooltip。
 */

/** 提示点的刷新节奏：插件是运行时写这份文件的，页面开着就该跟上，但不必按秒问。 */
export const ATTENTION_POLL_MS = 30_000

/**
 * 从插件列表里挑出该显示的那一条提示。
 *
 * 只看已启用的插件：停用的插件不会运行，它的提示是过时的。多个插件同时有提示时取第一个
 * ——入口只有一个点，点进去是插件目录，用户能看到全部。
 */
export function pickPluginAttention(plugins) {
  if (!Array.isArray(plugins)) return null
  for (const plugin of plugins) {
    if (!plugin || plugin.state !== 'enabled') continue
    const attention = plugin.attention
    if (!attention || typeof attention.text !== 'string' || !attention.text.trim()) continue
    return {
      pluginId: plugin.id,
      pluginName: plugin.name || plugin.id,
      text: attention.text.trim(),
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
      if (alive) setAttention(pickPluginAttention(plugins))
    }
    void tick()
    const timer = setInterval(() => void tick(), ATTENTION_POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return attention
}
