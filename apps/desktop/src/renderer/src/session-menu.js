/**
 * 会话列表右键 / 更多操作菜单的条目。
 *
 * 「删除对话」始终给出，和标签页有没有打开无关——它删的是磁盘上的会话，不是界面上的
 * 那个页签（关页签在各页签自己的关闭按钮上）。`true` 是危险样式标记，由 ContextMenu 解读。
 */
export function sessionMenuItems({ pinned, inProject }) {
  const items = [[pinned ? 'unpin' : 'pin', pinned ? '取消置顶' : '置顶']]
  if (inProject) items.push(['unassign', '移出项目分组'])
  items.push(['rename', '重命名'], 'separator', ['delete', '删除对话', true])
  return items
}

/** 草稿（还没绑定真实会话的新对话）只有重命名和删除。 */
export function draftMenuItems() {
  return [['rename', '重命名'], 'separator', ['delete', '删除对话', true]]
}
