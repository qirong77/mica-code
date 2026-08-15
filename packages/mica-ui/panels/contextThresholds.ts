/**
 * Context usage thresholds shared between the WorkingStatus UI (which colors
 * the token/ctx display) and the context-pressure plugin (which decides when
 * to warn the model about a red-zone context). Keep both in sync by importing
 * from here instead of re-declaring constants.
 */

export const CTX_RATIO_THRESHOLDS = [0.4, 0.5, 0.6, 0.7] as const;
export const CTX_TOKEN_THRESHOLDS = [80_000, 120_000, 200_000, 300_000] as const;

/** Highest threshold level: the UI colors this with statusError (red). */
export const CONTEXT_RED_LEVEL = CTX_RATIO_THRESHOLDS.length; // 4

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

/** True when either the token count or the ratio display would be red. */
export function isContextInRedZone(contextTokens: number, windowSize: number): boolean {
  return (
    getContextTokenColorIndex(contextTokens) >= CONTEXT_RED_LEVEL ||
    getContextRatioColorIndex(contextTokens, windowSize) >= CONTEXT_RED_LEVEL
  );
}

/**
 * Ratio below which a warned agent may be warned again (must leave the red
 * zone comfortably, not just flicker across the boundary).
 */
export const CONTEXT_RESET_RATIO_THRESHOLD = CTX_RATIO_THRESHOLDS[1]; // 0.5
