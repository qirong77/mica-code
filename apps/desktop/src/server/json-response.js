import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

const gzipAsync = promisify(gzip)
const GZIP_MIN_BYTES = 2 * 1024

function gzipQuality(header) {
  let explicit
  let wildcard

  for (const item of String(header || '').split(',')) {
    const [name, ...parameters] = item.trim().split(';')
    const coding = name.trim().toLowerCase()
    if (!coding) continue

    let quality = 1
    for (const parameter of parameters) {
      const [key, value] = parameter.split('=', 2)
      if (key?.trim().toLowerCase() !== 'q') continue
      const parsed = Number(value?.trim())
      quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0
    }

    if (coding === 'gzip') explicit = quality
    else if (coding === '*') wildcard = quality
  }

  return explicit ?? wildcard ?? 0
}

function acceptsGzip(header) {
  return gzipQuality(header) > 0
}

function ensureVary(res) {
  const current = res.getHeader?.('vary')
  const values = (Array.isArray(current) ? current : [current])
    .filter(Boolean)
    .flatMap((value) => String(value).split(','))
    .map((value) => value.trim())
    .filter(Boolean)

  if (!values.includes('*') && !values.some((value) => value.toLowerCase() === 'accept-encoding'))
    values.push('Accept-Encoding')
  res.setHeader('vary', values.join(', '))
}

function writable(res) {
  return !res.destroyed && !res.writableEnded
}

export async function sendJson(res, status, body) {
  if (!writable(res)) return

  const payload = Buffer.from(JSON.stringify(body))
  let output = payload
  let compressed = false

  if (payload.byteLength >= GZIP_MIN_BYTES && acceptsGzip(res.req?.headers?.['accept-encoding'])) {
    try {
      const zipped = await gzipAsync(payload, { level: 3 })
      if (zipped.byteLength < payload.byteLength) {
        output = zipped
        compressed = true
      }
    } catch {
      // Fall back to the original JSON when compression fails.
    }
  }

  if (!writable(res)) return

  res.statusCode = status
  res.setHeader('content-type', 'application/json;charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  ensureVary(res)
  res.setHeader('content-length', String(output.byteLength))
  if (compressed) res.setHeader('content-encoding', 'gzip')
  else res.removeHeader('content-encoding')
  res.end(res.req?.method === 'HEAD' ? undefined : output)
}
