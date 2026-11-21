/**
 * Turn a site icon URL into a `data:` URL the launcher page is allowed to draw.
 *
 * The plugin window runs under `img-src 'self' data: file:`, so a remote
 * `<img src="https://site/favicon.ico">` is blocked before it is fetched and the
 * icon silently never appears. The launcher view already owns a session, so it
 * fetches the bytes here (same cookies/proxy as the page itself) and hands the
 * plugin an inlined image instead of a URL. Icons the page already declares inline
 * are passed straight through. The plugin only ever stores the address it drew
 * (`https://…` or an inline `data:image/…`), never the bytes of a remote icon.
 */

/** Refuse anything a `<img>` cannot show, plus everything a page could smuggle in. */
const ICON_TYPES = new Set([
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/png',
  'image/gif',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/svg+xml'
])

export const MAX_ICON_BYTES = 128 * 1024
const DEFAULT_TIMEOUT_MS = 4000

export function iconDataUrl(type, bytes) {
  const media = String(type || '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!ICON_TYPES.has(media) || !bytes?.length) return ''
  return `data:${media};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * Pages that declare their icon inline (`<link rel="icon" href="data:image/svg+xml,…">`)
 * report that whole data URL, and plenty of them have no `/favicon.ico` at all. The
 * page is allowed to draw `data:` images already, so the icon needs no fetch — only
 * the same type and size gate.
 */
export function inlineIconDataUrl(value, maxBytes = MAX_ICON_BYTES) {
  if (typeof value !== 'string' || !value.startsWith('data:') || value.length > maxBytes) return ''
  const comma = value.indexOf(',')
  if (comma < 0) return ''
  const media = value.slice('data:'.length, comma).split(';')[0].trim().toLowerCase()
  return ICON_TYPES.has(media) ? value : ''
}

/**
 * `fetchImage(url, { signal })` is the caller's network access (the launcher view's
 * session). Missing icons are not cached: a site that 404s its `favicon.ico` today
 * must be retried the next time the plugin asks, while a hit is reused for the
 * lifetime of the launcher record.
 */
export function createLauncherFavicons({
  fetchImage,
  maxBytes = MAX_ICON_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheLimit = 64
} = {}) {
  if (typeof fetchImage !== 'function') throw new TypeError('fetchImage 必须是函数')
  const cache = new Map()
  const loading = new Map()

  async function download(url) {
    const response = await fetchImage(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response?.ok) return ''
    const type = response.headers?.get?.('content-type') || ''
    const buffer = Buffer.from(await response.arrayBuffer())
    // `Content-Length` may lie and a redirect may answer with an error page; the
    // byte cap is enforced on what actually arrived.
    if (buffer.length > maxBytes) return ''
    return iconDataUrl(type, buffer)
  }

  return {
    async load(url) {
      if (typeof url !== 'string' || !url) return ''
      const inline = inlineIconDataUrl(url, maxBytes)
      if (inline) return inline
      const hit = cache.get(url)
      if (hit !== undefined) return hit
      const pending = loading.get(url)
      if (pending) return pending
      const task = download(url)
        .catch(() => '')
        .then((dataUrl) => {
          if (dataUrl) {
            if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value)
            cache.set(url, dataUrl)
          }
          return dataUrl
        })
        .finally(() => loading.delete(url))
      loading.set(url, task)
      return task
    },
    clear() {
      cache.clear()
    }
  }
}
