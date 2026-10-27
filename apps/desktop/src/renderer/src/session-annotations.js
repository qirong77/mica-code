/**
 * 插件提供的会话标记（侧栏圆点 / 右键菜单项）。
 *
 * 宿主不知道「标签」这个概念：它只知道某个插件（见 mica-plugin 的 sessionAnnotations）
 * 声明了一组「选项 = id + 名字 + 颜色」，并把它们挂到会话上。侧栏只负责把颜色画成圆点、
 * 把选项名放进右键菜单，语义完全由插件决定。所以这里既没有 MAX_TAGS，也没有颜色约束。
 */

/** 行内最多画几个圆点：再多会把标题挤没，剩下的折成 +N。 */
const MAX_VISIBLE_DOTS = 3

/** 一个会话上挂着的所有标记，按插件顺序、插件内选项顺序摊平。 */
export function annotationBadges(providers, sessionId) {
  if (!sessionId) return []
  const badges = []
  for (const provider of providers || []) {
    const ids = provider?.assignments?.[sessionId]
    if (!Array.isArray(ids) || !ids.length) continue
    for (const option of provider.options || []) {
      if (!ids.includes(option.id)) continue
      badges.push({
        key: `${provider.pluginId}:${option.id}`,
        // 插件可以把名字留空（表示「还没命名」），这时退回 id。
        label: option.label || option.id,
        color: option.color,
        providerName: provider.name || provider.pluginId
      })
    }
  }
  return badges
}

export function visibleBadges(badges) {
  return badges.slice(0, MAX_VISIBLE_DOTS)
}

export function hiddenBadgeCount(badges) {
  return Math.max(0, badges.length - MAX_VISIBLE_DOTS)
}

/**
 * 右键菜单里的标记项。选项名旁边画自己的颜色、已挂上的打勾（分隔线由调用方插入，
 * 因为分隔线该插在哪由宿主的菜单结构决定）。动作名带插件和选项 id
 * （`annotation:<pluginId>:<optionId>`），因为这两者都是运行时才知道的。
 */
export function annotationMenuItems(providers, sessionId) {
  if (!sessionId) return []
  const items = []
  for (const provider of providers || []) {
    if (!provider?.options?.length) continue
    const assigned = new Set(provider.assignments?.[sessionId] || [])
    for (const option of provider.options) {
      items.push({
        action: `annotation:${provider.pluginId}:${option.id}`,
        label: option.label || option.id,
        dot: option.color,
        checked: assigned.has(option.id)
      })
    }
  }
  return items
}

/** `annotation:<pluginId>:<optionId>` → { pluginId, optionId }；不是标记项返回 null。 */
export function parseAnnotationAction(action) {
  if (typeof action !== 'string' || !action.startsWith('annotation:')) return null
  const rest = action.slice('annotation:'.length)
  const split = rest.indexOf(':')
  if (split <= 0) return null
  const pluginId = rest.slice(0, split)
  const optionId = rest.slice(split + 1)
  if (!optionId) return null
  return { pluginId, optionId }
}

/** 点一下是挂上还是摘掉，取决于它当前是否已经挂着——菜单里画的那个勾就来自同一份数据。 */
export function toggleTarget(providers, sessionId, { pluginId, optionId }) {
  const provider = (providers || []).find((item) => item?.pluginId === pluginId)
  const on = !(provider?.assignments?.[sessionId] || []).includes(optionId)
  return { pluginId, optionId, on }
}
