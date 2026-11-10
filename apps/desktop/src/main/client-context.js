export const CLIENT_CONTEXT_CHANNEL = 'mica:client-context'

/** Only the registered window's current top-level HTTP(S) page gets capabilities. */
export function isClientSenderAllowed(windows, event) {
  try {
    const sender = event?.sender
    const frame = event?.senderFrame
    if (!sender || !frame || frame !== sender.mainFrame || sender.isDestroyed?.()) return false
    for (const state of windows) {
      if (state.win.isDestroyed() || state.win.webContents !== sender) continue
      const origin = httpOrigin(state.clientOrigin)
      return Boolean(
        origin &&
        origin === state.clientOrigin &&
        httpOrigin(frame.url) === origin &&
        httpOrigin(sender.getURL()) === origin
      )
    }
  } catch {
    // Destroyed frames/windows and invalid URLs never grant capabilities.
  }
  return false
}

function httpOrigin(value) {
  if (typeof value !== 'string') return null
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) ? url.origin : null
}

// Plugin data may occupy 256 KiB; leave room for its JSON request envelope.
const MAX_BODY_BYTES = 256 * 1024 + 4096
const OPERATIONS = new Set(['context', 'read-data', 'write-data', 'probe', 'open', 'local'])

/**
 * Electron-independent IPC handler. Authorization is checked on every invocation.
 * manifests is an array (or an async function returning one) of parsed manifests.
 * readDisabled() returns an iterable of disabled ids. Data results, including CAS
 * conflicts, pass through unchanged. Omitted expectedVersion stays omitted.
 */
export function createClientContextHandler({
  isAllowedSender,
  manifests,
  readDisabled,
  readData,
  writeData,
  probe,
  open,
  local,
  localHost
}) {
  return async (event, operation, payload = {}) => {
    try {
      if (!(await isAllowedSender(event))) return { ok: false, error: 'Forbidden sender' }
    } catch {
      return { ok: false, error: 'Forbidden sender' }
    }

    try {
      if (!OPERATIONS.has(operation)) throw new Error('Unknown client operation')
      const body = readPayload(payload)
      let result
      switch (operation) {
        case 'read-data':
        case 'write-data': {
          const { pluginId } = body
          if (typeof pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(pluginId)) {
            throw new Error('Invalid pluginId')
          }
          const available = await (typeof manifests === 'function' ? manifests() : manifests)
          const manifest = available.find((entry) => entry.id === pluginId)
          const disabled = new Set(await readDisabled())
          if (manifest?.desktopClientData !== true || disabled.has(pluginId)) {
            throw new Error('Plugin client data access is not enabled')
          }
          if (operation === 'read-data') {
            result = await readData(pluginId)
          } else {
            if (!Object.hasOwn(body, 'value')) throw new Error('Missing value')
            result = Object.hasOwn(body, 'expectedVersion')
              ? await writeData(pluginId, body.value, { expectedVersion: body.expectedVersion })
              : await writeData(pluginId, body.value)
          }
          break
        }
        case 'probe':
          if (typeof body.address !== 'string' || !body.address.trim()) {
            throw new Error('Invalid address')
          }
          result = await probe(body.address)
          break
        case 'open': {
          let target
          try {
            target = typeof body.url === 'string' ? new URL(body.url) : null
          } catch {
            // Invalid absolute URLs are rejected below.
          }
          if (!target || !['http:', 'https:'].includes(target.protocol)) {
            throw new Error('Only HTTP and HTTPS URLs are supported')
          }
          result = await open(body.url)
          break
        }
        case 'local':
          result = await local()
          break
        case 'context':
          result = { localHost: await localHost() }
          break
      }
      return { ok: true, result: result === undefined ? null : result }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Validate without invoking getters/toJSON or stringifying an unbounded graph. */
function readPayload(payload) {
  if (!isPlainObject(payload)) throw new Error('JSON payload must be a plain object')
  let bytes = 0
  const addBytes = (size) => {
    bytes += size
    if (bytes > MAX_BODY_BYTES) throw new Error('Request body is too large')
  }
  const stringBytes = (value) => {
    // Every UTF-16 code unit needs at least one byte in its JSON representation.
    if (value.length > MAX_BODY_BYTES) throw new Error('Request body is too large')
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  }
  const invalid = () => {
    throw new Error('Invalid JSON payload')
  }
  const active = new WeakSet()
  const stack = [{ value: payload }]
  while (stack.length) {
    const { value, exit } = stack.pop()
    if (exit) {
      active.delete(value)
      continue
    }
    if (value === null) {
      addBytes(4)
    } else if (typeof value === 'string') {
      addBytes(stringBytes(value))
    } else if (typeof value === 'boolean') {
      addBytes(value ? 4 : 5)
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      addBytes(JSON.stringify(value).length)
    } else if (typeof value === 'object') {
      const array = Array.isArray(value)
      if ((!array && !isPlainObject(value)) || active.has(value)) invalid()
      if (array && Object.getPrototypeOf(value) !== Array.prototype) invalid()
      active.add(value)
      stack.push({ value, exit: true })
      const keys = Reflect.ownKeys(value)
      const count = array ? value.length : keys.length
      addBytes(2 + Math.max(0, count - 1))
      if (array && keys.length !== count + 1) invalid()
      for (let index = 0; index < count; index++) {
        const key = array ? String(index) : keys[index]
        if (typeof key !== 'string') invalid()
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) invalid()
        if (!array) addBytes(stringBytes(key) + 1)
        stack.push({ value: descriptor.value })
      }
    } else {
      invalid()
    }
  }
  // Work with a detached plain JSON value, just as the former JSON request did.
  return JSON.parse(JSON.stringify(payload))
}
