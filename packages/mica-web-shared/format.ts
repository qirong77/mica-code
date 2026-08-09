export function formatTokens(value: number, options: { millionDecimals?: number } = {}): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(options.millionDecimals ?? 1)}M`;
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
