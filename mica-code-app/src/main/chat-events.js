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

export function buildChatArgs({ prompt, sessionId, cwd, maxTurns, model, variant, role }) {
  const args = ['run', '--format', 'json', '--thinking']
  if (sessionId) args.push('--session', sessionId)
  if (cwd) args.push('--dir', cwd)
  if (model) args.push('--model', model)
  if (variant) args.push('--variant', variant)
  if (role) args.push('--role', role)
  if (Number.isInteger(maxTurns) && maxTurns > 0) args.push('--max-turns', String(maxTurns))
  args.push('--', prompt)
  return args
}
