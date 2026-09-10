export function formatTokens(value: number, options: { millionDecimals?: number } = {}): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${(value / 1_000_000).toFixed(options.millionDecimals ?? 1)}M`;
}
