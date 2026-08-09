export function formatTokens(value: number, options: { millionDecimals?: number } = {}): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(options.millionDecimals ?? 1)}M`;
}

/** Compact token count: `900`, `1.2K`, `45.3K`, `2.1M`. */
export function tokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

/** Elapsed time for tool/status rows: `312ms`, `8.4s`, `2m 13s`. */
export function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
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
