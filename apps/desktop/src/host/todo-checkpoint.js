import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SESSION_ID = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/

/**
 * The todo plugin writes its latest plan to `$MICA_HOME/todo-checkpoints/<id>.json`
 * so an interrupted turn still knows its progress. The dialog shows that same
 * plan when the tool row never reached the conversation (a tool batch cut off
 * mid-flight): provider history has nothing to project in that case.
 *
 * Only items are returned in the tool-input shape `{ todos }`; the checkpoint's
 * own turn bookkeeping stays private to the plugin.
 */
export function readTodoCheckpointInput(homeDir, sessionId) {
  if (typeof homeDir !== 'string' || !homeDir) return null
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || sessionId.includes('..'))
    return null
  let text
  try {
    text = readFileSync(join(homeDir, 'todo-checkpoints', `${sessionId}.json`), 'utf8')
  } catch {
    return null
  }
  if (text.length > 64 * 1024) return null
  try {
    const value = JSON.parse(text)
    if (!value || value.version !== 1 || value.sessionId !== sessionId) return null
    if (!Array.isArray(value.items) || value.items.length === 0) return null
    const todos = value.items
      .filter((item) => item && typeof item.content === 'string' && item.content.trim())
      .map((item) => ({ content: item.content, status: item.status }))
    return todos.length > 0 ? { todos } : null
  } catch {
    return null
  }
}
