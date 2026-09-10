/** Compact relative time for tight rows (desktop session list): `3m`, `2h`, `5d`. */
export function relativeTimeShort(timestamp: number | string, now = Date.now()): string {
  const time =
    typeof timestamp === 'string'
      ? /^\d+$/.test(timestamp.trim())
        ? Number(timestamp)
        : new Date(timestamp).getTime()
      : timestamp;
  if (!Number.isFinite(time) || time <= 0) return '';
  const elapsed = Math.max(0, now - time);
  if (elapsed < 60_000) return '刚刚';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  if (elapsed < 30 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)}d`;
  const date = new Date(time);
  const current = new Date(now);
  if (date.getFullYear() === current.getFullYear()) {
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}
