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

export function formatStatus(state: string): { label: string; color: string } {
  switch (state) {
    case 'running':
      return { label: '运行中', color: '#4f9cf7' };
    case 'completed':
      return { label: '已完成', color: '#5cb87c' };
    case 'aborted':
      return { label: '已中止', color: '#d79b3e' };
    case 'error':
      return { label: '出错', color: '#e05c5c' };
    default:
      return { label: state, color: '#8b94a3' };
  }
}
