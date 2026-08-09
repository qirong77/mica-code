import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const MAX_INPUT_HISTORY_ITEMS = 200

function micaHomeDir() {
  return process.env.MICA_HOME || join(homedir(), '.mica')
}

// Shared input history lives in the same ~/.mica/storage.json the CLI uses
// (`micaConfig.inputHistory`), so the app and the terminal share one history.
// Tolerant read/write: a corrupted or missing storage file degrades to empty
// history and never breaks the chat UI.
function readMicaStorage() {
  try {
    const file = join(micaHomeDir(), 'storage.json')
    if (!existsSync(file)) return { version: 1 }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { version: 1 }
    return parsed
  } catch {
    return { version: 1 }
  }
}

function writeMicaStorage(storage) {
  mkdirSync(micaHomeDir(), { recursive: true })
  writeFileSync(join(micaHomeDir(), 'storage.json'), `${JSON.stringify(storage, null, 2)}\n`)
}

export function readInputHistory() {
  const history = readMicaStorage().inputHistory
  if (!Array.isArray(history)) return []
  return history.map((entry) => String(entry).trim()).filter(Boolean)
}

export function appendInputHistory(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return readInputHistory()
  const next = [...readInputHistory().filter((entry) => entry !== trimmed), trimmed].slice(
    -MAX_INPUT_HISTORY_ITEMS
  )
  writeMicaStorage({ ...readMicaStorage(), inputHistory: next })
  return next
}
