export function appendBufferedEvent(events, record, maxParts = 500) {
  const event = record.event
  const previous = events.at(-1)
  if (
    previous &&
    (event.type === 'text' || event.type === 'reasoning') &&
    previous.event.type === event.type &&
    previous.event.sessionID === event.sessionID
  ) {
    previous.sequence = record.sequence
    previous.event = {
      ...previous.event,
      part: {
        ...previous.event.part,
        text: `${previous.event.part?.text || ''}${event.part?.text || ''}`
      }
    }
    return
  }
  events.push(record)
  if (events.length > maxParts) events.shift()
}

function isPaceableDelta(event) {
  return event?.type === 'text' || event?.type === 'reasoning'
}

function copyDeltaRecord(record) {
  return {
    ...record,
    event: {
      ...record.event,
      part: { ...record.event?.part }
    }
  }
}

function canMergeDelta(previous, next) {
  return (
    isPaceableDelta(previous?.event) &&
    isPaceableDelta(next?.event) &&
    previous.event.type === next.event.type &&
    previous.event.sessionID === next.event.sessionID
  )
}

function mergeDelta(previous, next) {
  return {
    ...previous,
    sequence: next.sequence,
    event: {
      ...previous.event,
      part: {
        ...previous.event.part,
        text: `${previous.event.part?.text || ''}${next.event.part?.text || ''}`
      }
    }
  }
}

export function createChatEventPacer(
  emit,
  { delayMs = 32, setTimer = setTimeout, clearTimer = clearTimeout } = {}
) {
  let pending = null
  let timer = null

  const flush = () => {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    if (!pending) return false
    const record = pending
    pending = null
    emit(record)
    return true
  }

  const schedule = () => {
    timer = setTimer(() => {
      timer = null
      flush()
    }, delayMs)
    timer?.unref?.()
  }

  return {
    push(record) {
      if (!isPaceableDelta(record?.event)) {
        flush()
        emit(record)
        return
      }

      if (pending && !canMergeDelta(pending, record)) flush()
      if (pending) {
        pending = mergeDelta(pending, record)
        return
      }

      pending = copyDeltaRecord(record)
      schedule()
    },
    flush
  }
}

// Chat starts a fresh headless CLI for every turn, so a broken MCP would add
// this delay repeatedly. Two seconds leaves enough room for normal npx-based
// servers while keeping an unavailable server from dominating model TTFT.
export const CHAT_MCP_INIT_TIMEOUT_MS = 2000

export function buildChatEnv(env = process.env) {
  return {
    ...env,
    MICA_MCP_INIT_TIMEOUT_MS: String(CHAT_MCP_INIT_TIMEOUT_MS)
  }
}

// Per-session resident `mica app-server` process: one host per chat node, kept
// alive across turns so repeated messages skip process startup, session reload
// and MCP re-init, and queued inputs get real after_iteration injection.
export function buildAppServerArgs({ sessionId, cwd, model, variant, role, maxTurns }) {
  // Keep `--thinking` so reasoning deltas reach the renderer turn log and
  // status line, matching the pre-codex `mica run --format json --thinking`.
  const args = ['app-server', '--thinking']
  if (sessionId) args.push('--session', sessionId)
  if (cwd) args.push('--dir', cwd)
  if (model) args.push('--model', model)
  if (variant) args.push('--variant', variant)
  if (role) args.push('--role', role)
  if (Number.isInteger(maxTurns) && maxTurns > 0) args.push('--max-turns', String(maxTurns))
  return args
}

// Map a Codex v2 app-server notification (mica chat-host protocol) to the app's
// internal event shape consumed by the renderer. Returns null for notifications
// that need state accumulation (commandExecution outputDelta, token usage) or
// that have no UI projection.
export function codexNotificationToEvent(notification) {
  const { method, params = {}, emittedAtMs } = notification
  const timestamp = emittedAtMs || Date.now()
  const sessionID = params.threadId || null
  switch (method) {
    case 'turn/started':
      return {
        type: 'step_start',
        timestamp,
        sessionID,
        turnId: params.turn?.id
      }
    case 'turn/completed':
      return {
        type: 'step_finish',
        timestamp,
        sessionID,
        part: {
          type: 'step-finish',
          reason: codexTurnStatusToReason(params.turn?.status),
          error: params.turn?.error?.message || undefined,
          tokens: {
            total: 0,
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 }
          }
        }
      }
    case 'item/agentMessage/delta':
      return {
        type: 'text',
        timestamp,
        sessionID,
        part: { type: 'text', text: params.delta || '' }
      }
    case 'item/reasoning/textDelta':
      return {
        type: 'reasoning',
        timestamp,
        sessionID,
        part: { type: 'reasoning', text: params.delta || '' }
      }
    case 'item/started':
      if (params.item?.type !== 'commandExecution') return null
      return {
        type: 'tool_use',
        timestamp,
        sessionID,
        part: {
          type: 'tool',
          tool: commandToolName(params.item.command),
          callID: params.item.id,
          displayText: params.item.displayText || null,
          state: { status: 'pending', input: commandInput(params.item.command) }
        }
      }
    case 'item/completed':
      if (params.item?.type !== 'commandExecution') return null
      return {
        type: 'tool_use',
        timestamp,
        sessionID,
        part: {
          type: 'tool',
          tool: commandToolName(params.item.command),
          callID: params.item.id,
          displayText: params.item.displayText || null,
          state: {
            status: 'completed',
            input: commandInput(params.item.command),
            output: params.item.aggregatedOutput || ''
          }
        }
      }
    case 'item/commandExecution/outputDelta':
      // Accumulated into the item/completed output by chat.js.
      return null
    case 'thread/tokenUsage/updated':
      // Accumulated into step_finish tokens by chat.js.
      return { type: 'usage', timestamp, sessionID, tokenUsage: params.tokenUsage }
    case 'mica/backgroundTasks/updated':
      // Host-side snapshot of active background shell tasks, pushed whenever
      // the list changes (change-driven, ~1s poll). Replaces the whole list.
      return {
        type: 'background_tasks',
        timestamp,
        sessionID,
        tasks: Array.isArray(params.tasks) ? params.tasks : []
      }
    case 'mica/subagentTasks/updated':
      // Host-side snapshot of running subagents (foreground + background),
      // pushed whenever the list changes. Replaces the whole list.
      return {
        type: 'subagent_tasks',
        timestamp,
        sessionID,
        tasks: Array.isArray(params.tasks) ? params.tasks : []
      }
    case 'mica/sessionHistory/replaced':
      // A session_* tool replaced the persisted history mid-host. chat.js
      // attaches the reloaded session rows; the renderer swaps its transcript.
      return {
        type: 'session_history_replaced',
        timestamp,
        sessionID
      }
    case 'error':
      return {
        type: 'error',
        timestamp,
        sessionID,
        error: {
          name: 'MicaRuntimeError',
          data: { message: params.error?.message || 'chat host 出错' }
        }
      }
    default:
      return null
  }
}

export function codexTurnStatusToReason(status) {
  if (status === 'completed') return 'completed'
  if (status === 'interrupted') return 'aborted'
  return 'error'
}

export function tokensFromCodexUsage(tokenUsage) {
  // CodexProjector emits cumulative `total` plus the per-record `last`.
  // The old run-JSON protocol reported accumulated usage, so surface `total`
  // to keep context/cached figures matching the pre-codex UI.
  const total = tokenUsage?.total || tokenUsage?.last
  if (!total) return { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  return {
    total: total.total_tokens || 0,
    input: total.input_tokens || 0,
    output: total.output_tokens || 0,
    reasoning: total.reasoning_output_tokens || 0,
    cache: {
      read: total.cached_input_tokens || 0,
      write: total.cache_write_input_tokens || 0
    }
  }
}

function commandToolName(command) {
  return String(command || '').split(/\s+/)[0] || 'tool'
}

function commandInput(command) {
  const rest = String(command || '')
    .split(/\s+/)
    .slice(1)
    .join(' ')
    .trim()
  if (!rest) return {}
  try {
    const value = JSON.parse(rest)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { value: rest }
  } catch {
    return { value: rest }
  }
}
