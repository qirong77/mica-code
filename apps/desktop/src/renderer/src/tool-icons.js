/**
 * 工具行左侧的 emoji。
 *
 * 事实来源是工具自己的声明（内置工具类里的 `icon`、插件 `ctx.tools.register(tool, { icon })`），
 * 那份注册表活在跑 agent 的宿主里，页面拿不到；宿主每装配一次插件就把它投影到
 * `$MICA_HOME/tool-icons.json`，这里读那份投影（`window.mica.chat.toolIcons()`）。
 *
 * 页面里**没有**第二张名字→emoji 的表：抄一份进渲染层就会漂移，插件工具行永远显示默认齿轮。
 * 投影还没到（首帧、或这台机器还没跑过装配插件的宿主）时查不到，`toolIcon()` 回落默认图标，
 * 之后的重新渲染会自己补上。
 */
import { useSyncExternalStore, useEffect } from 'react'
import { toolIcon as sharedToolIcon } from '@packages/mica-web-shared'

let icons = {}

const listeners = new Set()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function snapshot() {
  return icons
}

function sameIcons(a, b) {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => a[key] === b[key])
}

/** 重新读一次宿主投影（插件启停、新装插件后调用；宿主按文件 mtime 缓存，读它是廉价的）。 */
export async function refreshToolIcons() {
  try {
    const next = await window.mica?.chat?.toolIcons?.()
    if (!next || typeof next !== 'object') return
    if (sameIcons(next, icons)) return
    icons = next
    emit()
  } catch {
    // 图标只影响观感：读不到就按默认图标画，不打扰用户。
  }
}

let started = null

function start() {
  if (started) return started
  started = refreshToolIcons()
  // 一轮开始时再对一次：用户刚在设置里启用了插件，紧接着发消息就能看到它的图标。
  window.mica?.chat?.onRunStarted?.(() => {
    refreshToolIcons()
  })
  return started
}

/** 订阅图标投影：投影到达 / 变化后组件重画。 */
export function useToolIcons() {
  useEffect(() => {
    start()
  }, [])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** 工具行的 emoji（MCP 工具按前缀统一成插头，其余查投影，缺省默认齿轮）。 */
export function toolIcon(toolName, current = icons) {
  return sharedToolIcon(toolName, current)
}
