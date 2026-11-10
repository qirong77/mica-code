export const CLIENT_SCHEME = 'mica-client'

/** 只有外壳认可的入口且仍停留在该来源的窗口，才能授予客户端能力。 */
export function isClientOriginAllowed(windows, origin) {
  for (const state of windows) {
    if (state.win.isDestroyed() || state.clientOrigin !== origin) continue
    try {
      if (new URL(state.win.webContents.getURL()).origin === origin) return true
    } catch {
      /* Blank/error pages do not authorize origins. */
    }
  }
  return false
}

// Plugin data may occupy 256 KiB; leave room for its JSON request envelope.
const MAX_BODY_BYTES = 256 * 1024 + 4096
const PATHS = new Set(['/read-data', '/write-data', '/probe', '/open', '/local', '/context'])

class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * Electron-independent handler for protocol.handle on the default session only.
 * isAllowedOrigin must consult actual Mica runtime windows; browser partitions
 * must never register this protocol. Authorization is checked on every request.
 *
 * manifests is an array (or a function returning one) of parsed plugin manifests.
 * readDisabled() returns an iterable of disabled ids. Both may be asynchronous.
 * readData(id) and writeData(id, value, options?) return their results unchanged,
 * including version/CAS conflict results. options is omitted unless the request
 * owns expectedVersion, in which case it is { expectedVersion }.
 * probe(address), open(url), local(), localHost() supply desktop capabilities.
 */
export function createClientContextHandler({
  isAllowedOrigin,
  manifests,
  readDisabled,
  readData,
  writeData,
  probe,
  open,
  local,
  localHost
}) {
  return async (request) => {
    // Electron 39 omits Origin on custom protocol Requests but supplies the
    // browser-validated referrer. Newer shells also supply initiatorOrigin.
    let origin = request.initiatorOrigin ?? request.headers.get('origin')
    if (!origin && request.referrer) {
      try {
        const referrer = new URL(request.referrer)
        if (['http:', 'https:'].includes(referrer.protocol)) origin = referrer.origin
      } catch {
        /* Invalid/opaque referrers do not authorize a request. */
      }
    }
    // A sandboxed/opaque origin is serialized as the literal string "null".
    try {
      if (!origin || origin === 'null' || !(await isAllowedOrigin(origin))) {
        return jsonResponse(403, { ok: false, error: 'Forbidden origin' })
      }
    } catch {
      return jsonResponse(403, { ok: false, error: 'Forbidden origin' })
    }

    try {
      const url = new URL(request.url)
      if (url.protocol !== `${CLIENT_SCHEME}:` || url.hostname !== 'host') {
        throw new RequestError(403, 'Forbidden host')
      }
      if (!PATHS.has(url.pathname)) throw new RequestError(404, 'Unknown client operation')
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) })
      }
      if (request.method !== 'POST') throw new RequestError(405, 'Only POST is supported')

      const body = await readJson(request)
      let result
      switch (url.pathname) {
        case '/read-data':
        case '/write-data': {
          const { pluginId } = body
          if (typeof pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(pluginId)) {
            throw new RequestError(400, 'Invalid pluginId')
          }
          const available = await (typeof manifests === 'function' ? manifests() : manifests)
          const manifest = available.find((entry) => entry.id === pluginId)
          const disabled = new Set(await readDisabled())
          if (manifest?.desktopClientData !== true || disabled.has(pluginId)) {
            throw new RequestError(403, 'Plugin client data access is not enabled')
          }
          if (url.pathname === '/read-data') {
            result = await readData(pluginId)
          } else {
            if (!Object.hasOwn(body, 'value')) throw new RequestError(400, 'Missing value')
            result = Object.hasOwn(body, 'expectedVersion')
              ? await writeData(pluginId, body.value, { expectedVersion: body.expectedVersion })
              : await writeData(pluginId, body.value)
          }
          break
        }
        case '/probe':
          if (typeof body.address !== 'string' || !body.address.trim()) {
            throw new RequestError(400, 'Invalid address')
          }
          result = await probe(body.address)
          break
        case '/open': {
          let target
          try {
            target = typeof body.url === 'string' ? new URL(body.url) : null
          } catch {
            /* Invalid absolute URLs are rejected below. */
          }
          if (!target || !['http:', 'https:'].includes(target.protocol)) {
            throw new RequestError(400, 'Only HTTP and HTTPS URLs are supported')
          }
          result = await open(body.url)
          break
        }
        case '/local':
          result = await local()
          break
        case '/context':
          result = { localHost: await localHost() }
          break
      }
      return jsonResponse(200, { ok: true, result: result === undefined ? null : result }, origin)
    } catch (error) {
      return jsonResponse(
        error instanceof RequestError ? error.status : 500,
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        // Host authorization failures, like origin failures, never grant CORS.
        error instanceof RequestError && error.status === 403 ? undefined : origin
      )
    }
  }
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    Vary: 'Origin'
  }
}

function jsonResponse(status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(origin ? corsHeaders(origin) : {})
    }
  })
}

async function readJson(request) {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (mediaType !== 'application/json') throw new RequestError(415, 'Expected application/json')
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) {
    throw new RequestError(413, 'Request body is too large')
  }
  const reader = request.body?.getReader()
  const chunks = []
  let bytes = 0
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > MAX_BODY_BYTES) {
          // Do not wait for an untrusted request producer to finish cancelling.
          void reader.cancel().catch(() => {})
          throw new RequestError(413, 'Request body is too large')
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  const buffer = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    buffer.set(chunk, offset)
    offset += chunk.byteLength
  }
  let body
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer))
  } catch {
    throw new RequestError(400, 'Invalid JSON body')
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError(400, 'JSON body must be an object')
  }
  return body
}
