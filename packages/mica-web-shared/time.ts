export function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return time;
  const monthDay = date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  return `${monthDay} ${time}`;
}

export function formatRelative(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = now - then;
  if (diff < 0) return formatTime(iso);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatTime(iso);
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
