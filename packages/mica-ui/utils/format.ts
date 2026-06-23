export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  if (ms < 60000) return `${s}s`;
  const m = Math.floor(ms / 60000);
  const sec = ((ms % 60000) / 1000).toFixed(0);
  return `${m}m ${sec}s`;
}

export function formatSessionListTime(updatedAt: string, now = new Date()): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return updatedAt;

  const time = formatClockTime(date);
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return time;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;

  return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${time}`;
}

export function formatSessionMeta(updatedAt: string, model: string): string {
  const date = new Date(updatedAt);
  const timestamp = Number.isNaN(date.getTime())
    ? updatedAt
    : date.toLocaleString(undefined, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
  return `[${timestamp} ${model}]`;
}

function formatClockTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
