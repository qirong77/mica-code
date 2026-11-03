/** 一段耗时：`850ms` / `1.2s` / `1m 20s`。状态行、工具行与耗时分析的明细都用它。 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

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
