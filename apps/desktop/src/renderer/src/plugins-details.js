import { useEffect, useState } from 'react'

/**
 * 页面这边读「有哪些插件、各自启用没有、声明了什么界面」的唯一入口。
 *
 * 数据来自配置页数据层（`readPluginsDetails`）：它已经把官方插件与 `$MICA_HOME/plugins`
 * 下的用户插件合流成一份，并带上启用状态。对话右侧面板、侧栏入口、会话右键菜单项都从
 * 这一份里挑，所以这里只按 mtime 近似地缓存一次——清单是静态的（改插件要重开会话）。
 *
 * 读不到就返回空数组：画出一个点不开的按钮比什么都不画更糟。
 *
 * 但**失败不进缓存**，且当场重试两次：窗口刚起来的那一下 `/api/invoke` 可能还没就绪，
 * 一次抖动若被缓存 60 秒，所有在那一刻挂载的界面（对话区快捷条、侧栏插件入口、会话
 * 右键菜单）会整页空着直到重载页面。
 */
const CACHE_MS = 60_000
const READ_RETRY_DELAYS = [300, 1200]
let cache = { at: 0, promise: null }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 这次读取必须**一定会结束**。
 *
 * `/api/invoke` 在页面刚起来时可能连上了却迟迟不回（运行时还在装配插件目录），而这份清单
 * 的 promise 会被 60 秒内的所有调用方共享——一个永不 settle 的请求会让「输入框上方的插件
 * 状态行」「侧栏插件入口」整页空着，且没有任何报错可查。超时当作一次失败，交给上面的重试
 * 逻辑再来一次。
 */
const READ_TIMEOUT_MS = 4000

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('readPluginsDetails timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** 读一次清单；读不到（没有 transport / 请求失败 / 形状不对）返回 null，与「确实没有插件」区分开。 */
async function fetchPluginsDetails() {
  const configWeb = window.mica?.configWeb
  if (!configWeb) return null
  try {
    const details = await withTimeout(configWeb.invoke('readPluginsDetails'), READ_TIMEOUT_MS)
    return Array.isArray(details?.plugins) ? details.plugins : null
  } catch {
    return null
  }
}

async function loadPluginsDetails() {
  for (let attempt = 0; ; attempt += 1) {
    const plugins = await fetchPluginsDetails()
    if (plugins) return { plugins, ok: true }
    if (attempt >= READ_RETRY_DELAYS.length) return { plugins: [], ok: false }
    await sleep(READ_RETRY_DELAYS[attempt])
  }
}

export function readPluginsDetails({ force = false } = {}) {
  if (!force && cache.promise && Date.now() - cache.at < CACHE_MS) return cache.promise
  const entry = { at: Date.now(), promise: null }
  entry.promise = loadPluginsDetails().then(({ plugins, ok }) => {
    // 失败的那次不进缓存：下一个调用方（新挂载的界面、重试）应该重新问运行时。
    if (!ok && cache === entry) cache = { at: 0, promise: null }
    return plugins
  })
  cache = entry
  return entry.promise
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
