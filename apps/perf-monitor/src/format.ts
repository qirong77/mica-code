export const timestampMs = (value: number) => (Math.abs(value) < 100_000_000_000 ? value * 1000 : value);

export function number(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(value);
}

export function memory(mb: number | null | undefined): string {
  if (mb == null || !Number.isFinite(mb)) return '—';
  return Math.abs(mb) >= 1024 ? `${number(mb / 1024, 2)} GB` : `${number(mb)} MB`;
}

export function percent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : `${number(value)}%`;
}

export function dateTime(value: string | number | null | undefined, compact = false): string {
  if (value == null) return '—';
  const date = new Date(typeof value === 'number' ? timestampMs(value) : value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    ...(compact ? {} : { second: '2-digit' }),
    hour12: false,
  });
}

export function clock(value: number): string {
  return new Date(timestampMs(value)).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '未知';
  const value = Math.max(0, seconds);
  if (value < 60) return `${Math.floor(value)} 秒`;
  if (value < 3600) return `${Math.floor(value / 60)} 分钟`;
  if (value < 86400) return `${Math.floor(value / 3600)} 小时 ${Math.floor((value % 3600) / 60)} 分`;
  return `${Math.floor(value / 86400)} 天 ${Math.floor((value % 86400) / 3600)} 小时`;
}

export function bytes(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${number(value / 1024)} KB`;
  return `${number(value / 1024 / 1024)} MB`;
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}

export const nullableCompare = (a: number | null | undefined, b: number | null | undefined) => {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return a - b;
};
