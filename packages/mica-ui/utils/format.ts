export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  if (ms < 60000) return `${s}s`;
  const m = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${m}m ${sec}s`;
}

/** 将剩余毫秒格式化为中文倒计时，如「42 秒」「3 分 12 秒」「1 小时 5 分」。 */
export function formatCountdown(ms: number): string {
  if (ms < 1000) return '即将触发';
  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes > 0 ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return `${days} 天`;
}

/** 输入框定时循环徽标：⏰ 每 60 分钟 · 下次 3 分 12 秒 · 第 3 次 */
export function buildLoopBadge(intervalLabel: string, fireCount: number, nextFireAt: number, now: number): string {
  return `⏰ 每 ${intervalLabel} · 下次 ${formatCountdown(nextFireAt - now)} · 第 ${fireCount} 次`;
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
