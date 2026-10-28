/**
 * 会话设置左侧导航里「插件」一节的纯逻辑。
 *
 * 插件是导航的子项而不是内容区的页签：左侧这一列本来就在回答「有哪些可调的东西」，
 * 插件挂在它下面，用户点一次就到、也不用先把视野拉到右上方再找页签。
 */

/** 选中的插件被停用（或列表还没加载）时回到第一个，界面不会停在空页签上。 */
export function pickActivePlugin(plugins, activeId) {
  if (!Array.isArray(plugins) || plugins.length === 0) return null
  return plugins.find((plugin) => plugin.id === activeId) || plugins[0]
}

/** 这一插件在本会话被改过的项数，导航右侧的角标用它。 */
export function countPluginOverrides(plugin) {
  const overrides = plugin?.overrides
  return overrides && typeof overrides === 'object' ? Object.keys(overrides).length : 0
}
