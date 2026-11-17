export function askRemainingMs(ask, now = Date.now()) {
  const base = Number(ask?.timeoutRemainingMs ?? ask?.timeoutMs)
  if (!Number.isFinite(base)) return 0
  if (ask?.timeoutPaused) return Math.max(0, base)

  const updatedAt = Date.parse(String(ask?.timeoutUpdatedAt || ask?.askedAt || ''))
  if (!Number.isFinite(updatedAt)) return Math.max(0, base)
  return Math.max(0, base - Math.max(0, now - updatedAt))
}

export function formatAskCountdown(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil(Number(remainingMs) / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}:${String(seconds).padStart(2, '0')}`
  const hours = Math.floor(minutes / 60)
  return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
