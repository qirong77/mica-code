/**
 * 会话列表右键 / 更多操作菜单的条目。
 *
 * 「查看详情」打开 Stats 页复用的 session 详情弹窗，只读、不碰磁盘。
 * 「Fork」复用已有会话分叉能力；草稿没有可复制的会话，因此不提供此项。
 * 「分享链接」生成一条只带这个会话的地址（见 app-url.js 的 sessionShareUrl），打开它的人
 * 看不到左侧会话列表，所以草稿没有这一项——草稿还没绑定会话，没有可分享的对象。
 * 「删除对话」始终给出，和标签页有没有打开无关——它删的是磁盘上的会话，不是界面上的
 * 那个页签（关页签在各页签自己的关闭按钮上）。`true` 是危险样式标记，由 ContextMenu 解读。
 */
export function sessionMenuItems({ pinned, inProject, isChild = false }) {
  const items = isChild ? [] : [[pinned ? 'unpin' : 'pin', pinned ? '取消置顶' : '置顶']]
  if (inProject && !isChild) items.push(['unassign', '移出项目分组'])
  items.push(
    ['detail', '查看详情'],
    ['fork', 'Fork'],
    ['share', '分享链接'],
    ['copy-id', '复制会话 ID'],
    ['rename', '重命名'],
    'separator'
  )
  items.push(['delete', '删除对话', true])
  return items
}

/** 侧栏会话拖入输入框时使用的可读文本。 */
export function sessionDragText(session) {
  const id = String(session?.id || '').trim()
  if (!id) return ''
  const title = String(session?.title || '').trim()
  return title && title !== id ? `${title} (${id})` : id
}

/** 草稿（还没绑定真实会话的新对话）只有重命名和删除。 */
export function draftMenuItems() {
  return [['rename', '重命名'], 'separator', ['delete', '删除对话', true]]
}

/**
 * 「重命名」该进哪一行的编辑态。
 *
 * 右键菜单的载荷两种形态：会话行带 `session`，草稿行（还未绑定真实会话的新对话）只带
 * `draft`。按 `session` 去取 id 会在草稿上抛错，编辑态永远进不去——新对话看起来就是
 * 「点了重命名没反应」。所以两种都要认，都没有时返回 null（调用方什么都不做）。
 */
export function renameTargetOf(menuPayload) {
  if (menuPayload?.session?.id) return { kind: 'session', id: menuPayload.session.id }
  if (menuPayload?.draft?.id) return { kind: 'draft', id: menuPayload.draft.id }
  return null
}

/**
 * 把插件贡献的项插到「删除」之前：删除永远排最后，误点就找不回来了。
 *
 * `extra` 里既有会话标记（打勾项）也有插件动作（`session-menu:<pluginId>:<action>`），
 * 两者都由插件提供，宿主只负责摆放位置。
 *
 * 声明了 `position: 'top'` 的项反过来摆到菜单最上面（例如会话压缩：它是对这条会话本身
 * 的操作，比置顶/改名更常点）；其余项仍是默认位置。
 */
export function withExtraMenuItems(items, extra) {
  const additions = Array.isArray(extra) ? extra.filter(Boolean) : []
  if (!additions.length) return items
  const top = additions.filter((item) => item?.position === 'top')
  const rest = additions.filter((item) => item?.position !== 'top')
  const dangerIndex = items.findIndex((item) => Array.isArray(item) && item[2])
  const head = [...(dangerIndex < 0 ? items : items.slice(0, dangerIndex))]
  while (head.at(-1) === 'separator') head.pop()
  const tail = dangerIndex < 0 ? [] : items.slice(dangerIndex)
  // 三段用分隔线隔开，空段跳过：顶部项 → 宿主自己的项 → 其余插件项 → 危险项。
  const merged = []
  for (const chunk of [top, head, rest]) {
    if (!chunk.length) continue
    if (merged.length) merged.push('separator')
    merged.push(...chunk)
  }
  return tail.length ? [...merged, 'separator', ...tail] : merged
}
