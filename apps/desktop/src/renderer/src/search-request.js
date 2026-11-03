// getRandomValues is available in Electron and in browsers, including environments
// where randomUUID is unavailable. Each request needs its own cross-window identity.
export function createSearchRequestId() {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
