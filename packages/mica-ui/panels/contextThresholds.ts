/**
 * Context usage thresholds for the WorkingStatus UI, which colors the token
 * and ctx displays with these levels.
 */

export const CTX_RATIO_THRESHOLDS = [0.4, 0.5, 0.6, 0.7] as const;
export const CTX_TOKEN_THRESHOLDS = [80_000, 120_000, 200_000, 300_000] as const;

export function getThresholdLevel(value: number, thresholds: readonly number[]): number {
  for (let i = thresholds.length - 1; i >= 0; i--) {
    if (value >= thresholds[i]) return i + 1;
  }
  return 0;
}

export function getContextTokenColorIndex(contextTokens: number): number {
  return getThresholdLevel(contextTokens, CTX_TOKEN_THRESHOLDS);
}

export function getContextRatioColorIndex(contextTokens: number, windowSize: number): number {
  const ratio = windowSize > 0 ? contextTokens / windowSize : 0;
  return getThresholdLevel(ratio, CTX_RATIO_THRESHOLDS);
}
