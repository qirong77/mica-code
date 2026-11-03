// Recent 分区里草稿（新建但还没落盘的会话）的呈现顺序。
//
// 草稿永远排在真实会话之前：用户刚点开的那条会话就是这个分区里「最新」的东西，把它排在
// 几十条按 updatedAt 排下来的会话末尾等同于「新建的对话找不到了」。当前选中那条仍然第
// 一（那是「我正在用的这条」），其余按最近活动时间倒序跟在后面。
export function orderRecentDrafts(drafts = [], selectedId = null) {
  const active = []
  const rest = []
  for (const node of Array.isArray(drafts) ? drafts : []) {
    if (!node?.id) continue
    if (node.id === selectedId) active.push(node)
    else rest.push(node)
  }
  // 稳定排序：没有活动时间（或相同）时保持工作区里的原有顺序。
  rest.sort((a, b) => (Number(b.lastActiveAt) || 0) - (Number(a.lastActiveAt) || 0))
  return [...active, ...rest]
}
