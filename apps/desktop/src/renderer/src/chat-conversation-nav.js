/**
 * 悬浮 tip 上的「上一个对话 / 下一个对话」：在对话流里按用户消息（一轮对话的起点）跳转。
 *
 * 判定是纯函数——入参是一串用户消息在滚动坐标系里的位置（`scrollTop` 同一口径），组件只
 * 负责量位置与滚动。「跳到哪一条」的规则放在这里，可以被单测锁住，不要在组件里另写一份。
 */

/** 视口顶部与消息位置差几像素以内仍算「这一条已经滚到顶部」。 */
export const CONVERSATION_ANCHOR_TOLERANCE = 8

/**
 * 当前视图的锚点：视野顶部及上方最后一条用户消息的下标。
 * 上方一条都没有（还没滚过第一条）时返回 -1。
 */
export function conversationAnchorIndex(
  tops,
  scrollTop,
  tolerance = CONVERSATION_ANCHOR_TOLERANCE
) {
  let anchor = -1
  for (let index = 0; index < tops.length; index += 1) {
    if (tops[index] > scrollTop + tolerance) break
    anchor = index
  }
  return anchor
}

/** 上方还有对话（能往上跳）吗。只看前两条也成立：锚点大于 0 ⟺ 第二条已滚到顶部。 */
export function canGoToPreviousConversation(
  tops,
  scrollTop,
  tolerance = CONVERSATION_ANCHOR_TOLERANCE
) {
  return conversationAnchorIndex(tops, scrollTop, tolerance) > 0
}

/**
 * 某个方向该跳到哪儿。
 *
 * - `{ kind: 'message', index, top }`：把这一条用户消息滚到视野顶部；
 * - `{ kind: 'bottom' }`：下方没有对话了，回落到「最新消息」（滚动到底部）；
 * - `{ kind: 'none' }`：上方没有对话了，什么都不做。
 */
export function conversationNavTarget(
  tops,
  scrollTop,
  direction,
  tolerance = CONVERSATION_ANCHOR_TOLERANCE
) {
  const anchor = conversationAnchorIndex(tops, scrollTop, tolerance)
  if (direction === 'previous') {
    if (anchor <= 0) return { kind: 'none' }
    return { kind: 'message', index: anchor - 1, top: tops[anchor - 1] }
  }
  const next = anchor + 1
  if (next >= tops.length) return { kind: 'bottom' }
  return { kind: 'message', index: next, top: tops[next] }
}
