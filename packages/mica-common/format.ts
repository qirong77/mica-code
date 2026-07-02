export function formatTokenCount(
  tokens: number,
  options: { zero?: string; compactLowercase?: boolean; roundedThousands?: boolean } = {},
): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return options.zero ?? '0';
  if (tokens < 1000) return `${Math.round(tokens)}`;
  const thousandSuffix = options.compactLowercase ? 'k' : 'K';
  if (tokens < 1_000_000) {
    const value = options.roundedThousands ? Math.round(tokens / 1000) : (tokens / 1000).toFixed(1);
    return `${value}${thousandSuffix}`;
  }
  const value = options.roundedThousands ? Number((tokens / 1_000_000).toFixed(1)) : (tokens / 1_000_000).toFixed(2);
  return `${value}M`;
}
