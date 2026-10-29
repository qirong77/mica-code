import { useEffect, useState } from 'react'
import { readPluginsDetails } from './plugins-details'

/**
 * 插件在桌面端侧栏的入口。
 *
 * 两半数据来自两处：文案来自清单的 `desktop.entry`（配置页数据层已经读好了），卡片内容
 * 来自插件自己目录里的 `desktop.jsx`。宿主因此不认识任何具体插件——加一个桌面插件只需
 * 建目录、写清单，这里一行都不用改。
 *
 * `desktop.jsx` 的约定：
 * - `default` 导出卡片组件，props 是 `{ api, onClose }`（api 见 `plugin-host.js`）；
 * - 可选命名导出 `summary(api)`，返回入口行右侧那一行字（例如「本机」），不写就空着。
 *
 * 只有**随包插件**会被收录：页面是构建期打的包，glob 只能看到打包时仓库里存在的文件；
 * 用户插件装在运行时才出现的 `$MICA_HOME/plugins`，页面这边没有它的模块。
 */

// glob 的 key 是匹配到的文件路径，形态跟着构建配置走（alias 解析后可能不是写下的样子），
// 所以按「结尾是 `<插件 id>/desktop.jsx`」取 id，而不是自己拼字符串去查表。
const entryLoaders = new Map()
for (const [key, load] of Object.entries(import.meta.glob('@plugins/*/desktop.jsx'))) {
  const match = /(?:^|\/)([^/]+)\/desktop\.jsx$/.exec(key)
  if (match) entryLoaders.set(match[1], load)
}

/** 某个插件的桌面入口模块加载器；没有 `desktop.jsx` 时返回 null。 */
export function pluginEntryLoader(pluginId) {
  return entryLoaders.get(pluginId) ?? null
}

/**
 * 当前该画出来的入口。
 *
 * 只看两件事：插件是启用的、并且它真有一个 `desktop.jsx` 模块。入口模块很小，读取插件
 * 列表时一次全部加载完，`summary` 这类同步信息因此不会晚一步出现。
 */
export function usePluginEntries() {
  const [entries, setEntries] = useState([])

  useEffect(() => {
    let alive = true
    void (async () => {
      // 读不到插件状态就不画入口：画出来也点不开，反而让人以为功能坏了
      const plugins = await readPluginsDetails()

      const loaded = await Promise.all(
        plugins.map(async (plugin) => {
          if (plugin?.state !== 'enabled' || !plugin?.desktopEntry) return null
          const load = pluginEntryLoader(plugin.id)
          if (!load) return null
          try {
            const module = await load()
            if (!module?.default) return null
            return { id: plugin.id, label: plugin.desktopEntry.label, icon: plugin.icon, module }
          } catch {
            return null
          }
        })
      )
      if (alive) setEntries(loaded.filter(Boolean))
    })()
    return () => {
      alive = false
    }
  }, [])

  return entries
}
