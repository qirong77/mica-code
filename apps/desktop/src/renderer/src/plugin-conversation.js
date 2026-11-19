/**
 * State used by the generic embedded conversation surface.
 *
 * A conversation is deliberately stored under one ui-state key per
 * plugin/scope pair. Updating one note (or another plugin scope) therefore
 * cannot replace a sibling scope's active conversation. The value is only a
 * pointer/index; the transcript itself remains the normal Mica session.
 */

export const CONVERSATION_STATE_VERSION = 1
export const RECENT_CONVERSATION_LIMIT = 60

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function hash(value) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return (result >>> 0).toString(36)
}

/** The key is stable, safe for ui-state, and bounded by its 128-char limit. */
export function conversationStateKey(pluginId, scope) {
  const plugin = encodeURIComponent(text(pluginId) || 'unknown')
  const name = encodeURIComponent(text(scope) || 'default')
  const key = `pluginUi.conversation.${plugin}.${name}`
  return key.length <= 128 ? key : `pluginUi.conversation.${hash(`${plugin}\u0000${name}`)}`
}

export function normalizeConversationState(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const items = []
  const seen = new Set()
  for (const candidate of Array.isArray(value.items) ? value.items : []) {
    const key = text(candidate?.key)
    const nodeId = text(candidate?.nodeId)
    const sessionId = text(candidate?.sessionId)
    if (!key || seen.has(key) || (!nodeId && !sessionId)) continue
    seen.add(key)
    items.push({
      key,
      ...(nodeId ? { nodeId } : {}),
      ...(sessionId ? { sessionId } : {}),
      title: text(candidate?.title) || '新对话',
      ...(text(candidate?.cwd) ? { cwd: text(candidate.cwd) } : {}),
      ...(Number.isFinite(Number(candidate?.createdAt))
        ? { createdAt: Number(candidate.createdAt) }
        : {}),
      ...(Number.isFinite(Number(candidate?.updatedAt))
        ? { updatedAt: Number(candidate.updatedAt) }
        : {})
    })
  }
  const activeId = text(value.activeId)
  return {
    version: CONVERSATION_STATE_VERSION,
    activeId: items.some((item) => item.key === activeId) ? activeId : items.at(-1)?.key || null,
    items
  }
}

export function conversationStateWithItem(state, item) {
  const current = normalizeConversationState(state)
  const nextItem = normalizeConversationState({ items: [item] }).items[0]
  if (!nextItem) return current
  const index = current.items.findIndex((entry) => entry.key === nextItem.key)
  const items =
    index < 0
      ? [...current.items, nextItem]
      : current.items.map((entry, itemIndex) =>
          itemIndex === index ? { ...entry, ...nextItem } : entry
        )
  return { ...current, activeId: nextItem.key, items }
}

export function conversationStateActivate(state, key) {
  const current = normalizeConversationState(state)
  return current.items.some((item) => item.key === key) ? { ...current, activeId: key } : current
}

/** A delayed binding belongs to its original node, never the currently selected conversation. */
export function conversationStateBind(state, nodeId, sessionId, now = Date.now()) {
  const current = normalizeConversationState(state)
  if (!text(nodeId) || !text(sessionId)) return current
  return {
    ...current,
    items: current.items.map((item) =>
      item.nodeId === nodeId ? { ...item, sessionId, updatedAt: now } : item
    )
  }
}

export function isConversationTarget(current, target) {
  return Boolean(
    current?.visible &&
    current.stateKey === target?.stateKey &&
    current.itemKey === target?.itemKey &&
    current.nodeId === target?.nodeId
  )
}

export function appendConversationDraft(current, addition) {
  const textValue = String(addition ?? '')
  if (!textValue) return String(current ?? '')
  const existing = String(current ?? '')
  return existing ? `${existing}${/\s$/.test(existing) ? '' : '\n'}${textValue}` : textValue
}
