import { useEffect, useState } from 'react'

/**
 * 页面这边读「有哪些插件、各自启用没有、声明了什么界面」的唯一入口。
 *
 * 数据来自配置页数据层（`readPluginsDetails`）：它已经把官方插件与 `$MICA_HOME/plugins`
 * 下的用户插件合流成一份，并带上启用状态。对话右侧面板、侧栏入口、会话右键菜单项都从
 * 这一份里挑，所以这里只按 mtime 近似地缓存一次——清单是静态的（改插件要重开会话）。
 *
 * 读不到就返回空数组：画出一个点不开的按钮比什么都不画更糟。
 */
const CACHE_MS = 60_000
let cache = { at: 0, promise: null }

export function readPluginsDetails() {
  const fresh = cache.promise && Date.now() - cache.at < CACHE_MS
  if (fresh) return cache.promise
  const promise = window.mica?.configWeb
    ?.invoke('readPluginsDetails')
    .then((details) => (Array.isArray(details?.plugins) ? details.plugins : []))
    .catch(() => [])
  cache = { at: Date.now(), promise: promise ?? null }
  return promise ?? Promise.resolve([])
}

/** 组件读插件列表：只取一次，卸载后不再写状态。 */
export function usePluginsDetails() {
  const [plugins, setPlugins] = useState([])
  useEffect(() => {
    let alive = true
    void readPluginsDetails().then((list) => {
      if (alive) setPlugins(list)
    })
    return () => {
      alive = false
    }
  }, [])
  return plugins
}
