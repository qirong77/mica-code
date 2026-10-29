import { useMemo } from 'react'
import { usePluginsDetails } from './plugins-details'

/**
 * 会话右键菜单里的插件动作（清单 `desktop.sessionMenu`）。
 *
 * 和会话标签（`session-annotations.js`）是两回事：那是**数据**，宿主按插件给的色槽画点；
 * 这里是**动作**——插件要真的跑一段自己的代码，把结果交回来（典型是剪贴板里的文本）。
 *
 * 菜单项来自清单，所以右键时同步就能画出来；点了才去会话的常驻 host 转发动作，插件在
 * 那边执行。宿主不认识任何具体插件，它只知道「插件 id + 动作 id」。
 */

/** 动作 id 在菜单里的编码：`session-menu:<pluginId>:<action>`。 */
const PREFIX = 'session-menu:'

/**
 * 菜单项列表。与其它插件数据一样复用配置页那份 `readPluginsDetails`：它已经把官方插件
 * 与用户插件合流、带启用状态——停用的插件不该在右键里留一条点不动的项。
 */
export function sessionMenuPluginItems(plugins) {
  const items = []
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    if (plugin?.state !== 'enabled') continue
    const menu = Array.isArray(plugin.desktopSessionMenu) ? plugin.desktopSessionMenu : []
    for (const entry of menu) {
      const label = typeof entry?.label === 'string' ? entry.label.trim() : ''
      const action = typeof entry?.action === 'string' ? entry.action.trim() : ''
      if (!label || !action) continue
      items.push({
        action: `${PREFIX}${plugin.id}:${action}`,
        label,
        pluginId: plugin.id,
        pluginAction: action
      })
    }
  }
  return items
}

export function useSessionMenuPlugins() {
  const plugins = usePluginsDetails()
  // 插件列表是缓存的，菜单项只在它变化时重算：右键是同步交互，不能每次都摊一遍。
  return useMemo(() => sessionMenuPluginItems(plugins), [plugins])
}

/** `session-menu:<pluginId>:<action>` → { pluginId, action }；不是插件项返回 null。 */
export function parseSessionMenuAction(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return null
  const rest = value.slice(PREFIX.length)
  // 插件 id 里不会出现 `:`（清单格式限制了字符集），所以第一个冒号就是分隔点。
  const split = rest.indexOf(':')
  if (split <= 0) return null
  const pluginId = rest.slice(0, split)
  const action = rest.slice(split + 1)
  if (!action) return null
  return { pluginId, action }
}
