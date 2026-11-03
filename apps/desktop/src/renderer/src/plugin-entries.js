import { useEffect, useState } from 'react'
import { usePluginsDetails } from './plugins-details'

/**
 * 插件在桌面端的入口（侧栏一行，或者顶栏的一枚图标按钮）。
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
  // 启停变化会让这份清单重读：停用的插件入口立刻从侧栏 / 顶栏撤下。
  const plugins = usePluginsDetails()

  useEffect(() => {
    let alive = true
    void (async () => {
      const loaded = await Promise.all(
        plugins.map(async (plugin) => {
          if (plugin?.state !== 'enabled' || !plugin?.desktopEntry) return null
          const load = pluginEntryLoader(plugin.id)
          if (!load) return null
          try {
            const module = await load()
            // 整页入口只要求模块有 `Page`（可以是 default），卡片入口要求有 default
            const page = plugin.desktopPage ?? null
            const component = page ? (module?.Page ?? module?.default) : module?.default
            if (!component) return null
            return {
              id: plugin.id,
              label: plugin.desktopEntry.label,
              // 位置是清单说了算的呈现选择：`header` 走顶栏，其余一律按侧栏一行画
              placement: plugin.desktopEntry.placement === 'header' ? 'header' : 'sidebar',
              icon: plugin.icon,
              // 卡片宽度可以由插件模块声明（`export const card = { width }`）：笔记、
              // 表格这类内容在 320px 里放不下，宿主只负责把数值夹到合理范围。
              cardWidth: clampCardWidth(module?.card?.width),
              module,
              page
            }
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
  }, [plugins])

  return entries
}

const CARD_MIN_WIDTH = 240
const CARD_MAX_WIDTH = 960

function clampCardWidth(width) {
  const value = Number(width)
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.min(CARD_MAX_WIDTH, Math.max(CARD_MIN_WIDTH, Math.round(value)))
}
