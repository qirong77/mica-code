// Usage / context summary helpers shared by apps/sync/web and apps/desktop
// renderer. Pure functions: normalize provider usage records and compute the
// compact `model · tokens (cached %, ctx %)` grammar both UIs display.

export type UsageValues = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

/** Normalizes the various usage record shapes into one numeric view. */
export function usageValues(usage: unknown): UsageValues | null {
  if (!usage || typeof usage !== 'object') return null;
  const tokens = usage as Record<string, unknown>;
  const total = tokens.total_tokens ?? tokens.totalTokens ?? tokens.total ?? null;
  const input = tokens.prompt_tokens ?? tokens.inputTokens ?? tokens.input ?? null;
  const output = tokens.completion_tokens ?? tokens.outputTokens ?? tokens.output ?? null;
  const cached =
    tokens.cachedInputTokens ??
    tokens.cacheRead ??
    ((tokens.cache as Record<string, unknown> | undefined)?.read as unknown) ??
    null;
  if (total == null && input == null && output == null && cached == null) return null;
  return {
    totalTokens: Number(total) || 0,
    inputTokens: Number(input) || 0,
    outputTokens: Number(output) || 0,
    cachedInputTokens: Number(cached) || 0,
  };
}

/** `model_effort` label; omits the suffix when effort is unset or `none`. */
export function modelLabel(model: string | undefined, effort?: string | null | undefined): string {
  const name = String(model || '').trim();
  if (!name) return '';
  const suffix = effort && effort !== 'none' ? `_${effort}` : '';
  return `${name}${suffix}`;
}

export type ContextTone = 'low' | 'mid' | 'high';

export type ContextUsage = {
  tokens: number;
  cachedPct: number;
  contextPct: number;
  tone: ContextTone;
};

/**
 * Computes the context pressure summary from a usage record and the model's
 * context window. `tone` grades ctx occupancy (>80 high, >50 mid) so the
 * highlight color matches the pressure level.
 */
export function contextUsage(input: {
  usage: unknown;
  model?: string;
  contextWindowSize?: number;
}): ContextUsage | null {
  const values = usageValues(input.usage);
  if (!values || values.totalTokens <= 0) return null;
  const cachedPct = values.inputTokens > 0 ? Math.round((values.cachedInputTokens / values.inputTokens) * 100) : 0;
  const windowSize = Number(input.contextWindowSize);
  const hasWindow = Number.isFinite(windowSize) && windowSize > 0;
  const contextPct = hasWindow ? Math.min(100, Math.round((values.totalTokens / windowSize) * 100)) : 0;
  const tone: ContextTone = contextPct > 80 ? 'high' : contextPct > 50 ? 'mid' : 'low';
  return { tokens: values.totalTokens, cachedPct, contextPct, tone };
}
