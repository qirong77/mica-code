import { isActivityMessage } from './chat-turn-activity.js'

/** Stream rows normally sit at the tail; notices or queued prompts can follow them. */
export function updateStreamMessage(messages, id, update) {
  const index = messages.findLastIndex((message) => message.id === id)
  if (index < 0) return messages
  const message = update(messages[index])
  if (message === messages[index]) return messages
  // Native copying avoids invoking a JS callback for every historical row on each delta.
  const next = messages.slice()
  next[index] = message
  return next
}

/** Reasoning/tool deltas don't alter the main conversation; preserve its render list. */
export function transcriptMessagesForDisplay(messages, previous) {
  const next = messages.filter((message) => !message.queued && !isActivityMessage(message))
  return previous &&
    next.length === previous.length &&
    next.every((message, index) => message === previous[index])
    ? previous
    : next
}
