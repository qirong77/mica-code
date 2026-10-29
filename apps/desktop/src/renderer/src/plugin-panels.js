import { useEffect, useState } from 'react'
import { readPluginsDetails } from './plugins-details'

/**
 * 对话右侧能出现的插件面板（清单 `desktop.panel`）。
 *
 * 面板是「插件给数据、宿主画出来」的界面，所以页面这边只需要知道**有哪些**：清单里的
 * 标题与角色门槛。真正的视图与动作由会话的常驻 host 提供（插件就在那个进程里）。
 *
 * 复用配置页数据层（`readPluginsDetails`）而不是新开一条读取链路：它已经把官方插件与
 * `$MICA_HOME/plugins` 下的用户插件合流成一份，且带启用状态——停用的插件不该在对话区
 * 留一个点不开的按钮。
 *
 * 角色是会话事实：`roles` 为空表示任何角色都显示，否则只有当前会话角色命中时才出现。
 * 用户可能刚在输入条切了角色还没发消息（新角色要到下一轮才落盘），所以调用方把「待生效
 * 的角色」一并传进来。
 */
export function usePluginPanels(role) {
  const [panels, setPanels] = useState([])

  useEffect(() => {
    let alive = true
    void (async () => {
      const plugins = await readPluginsDetails()
      if (alive) setPanels(selectPluginPanels(plugins, role))
    })()
    return () => {
      alive = false
    }
  }, [role])

  return panels
}

/**
 * 从配置页那几份插件数据里挑出「当前会话该显示的面板」。
 *
 * 三条都是硬条件：插件启用（停用的不该留一个点不开的按钮）、清单声明了面板、角色命中
 * （`roles` 为空表示任何角色）。角色用**待生效**的那个：用户可能刚在输入条切了角色还没
 * 发消息，那时落盘的还是旧角色。
 */
export function selectPluginPanels(plugins, role) {
  const active = String(role || 'default').trim() || 'default'
  return (Array.isArray(plugins) ? plugins : [])
    .filter((plugin) => plugin?.state === 'enabled' && plugin?.desktopPanel)
    .filter((plugin) => {
      const roles = Array.isArray(plugin.desktopPanel.roles) ? plugin.desktopPanel.roles : []
      return roles.length === 0 || roles.includes(active)
    })
    .map((plugin) => ({
      id: plugin.id,
      label: plugin.desktopPanel.label || plugin.name || plugin.id,
      icon: plugin.icon || '',
      shortcuts: Array.isArray(plugin.desktopPanel.shortcuts) ? plugin.desktopPanel.shortcuts : []
    }))
}
