// A replay buffer can start midway through an attempt. Only remove text that
// is known to belong to that attempt, even if the server reports more text.
function rollbackAttempt(messages, turnId, attemptId, length, kind) {
  if (!attemptId) return messages
  let remaining = Math.max(0, Number(length) || 0)
  const next = messages.slice()
  for (let i = next.length - 1; i >= 0; i--) {
    const message = next[i]
    if (remaining <= 0) continue
    if (message.turnId !== turnId || message.kind !== kind ||
        (kind === 'message' && message.role !== 'assistant') || message.attemptId !== attemptId) continue
    const removed = Math.min(remaining, message.text.length)
    remaining -= removed
    const text = message.text.slice(0, message.text.length - removed)
    if (text) next[i] = { ...message, text }
    else next.splice(i, 1)
  }
  return next
}

export function rollbackAttemptText(messages, turnId, attemptId, length) {
  return rollbackAttempt(messages, turnId, attemptId, length, 'message')
}

export function rollbackAttemptReasoning(messages, turnId, attemptId, length) {
  return rollbackAttempt(messages, turnId, attemptId, length, 'reasoning')
}
