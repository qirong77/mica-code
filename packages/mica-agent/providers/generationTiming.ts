export type GenerationTiming = {
  firstTextDeltaAt?: number;
  lastTextDeltaAt?: number;
  textDeltaCount: number;
  hasOtherOutput: boolean;
};

export type GenerationSample = {
  generationDurationMs: number;
  generationOutputTokens: number;
};

export function observeGenerationText(timing: GenerationTiming, text: string, at = Date.now()): void {
  if (!text) return;
  timing.firstTextDeltaAt ??= at;
  timing.lastTextDeltaAt = at;
  timing.textDeltaCount++;
}

export function sampleGenerationTiming(
  timing: GenerationTiming,
  outputTokens: unknown,
  reasoningTokens: unknown,
): GenerationSample | undefined {
  if (
    timing.hasOtherOutput ||
    typeof outputTokens !== 'number' || !Number.isSafeInteger(outputTokens) || outputTokens <= 0 ||
    typeof reasoningTokens !== 'number' || !Number.isSafeInteger(reasoningTokens) || reasoningTokens < 0 ||
    reasoningTokens > outputTokens ||
    !Number.isSafeInteger(timing.textDeltaCount) || timing.textDeltaCount < 2 ||
    timing.firstTextDeltaAt === undefined || !Number.isFinite(timing.firstTextDeltaAt) || timing.firstTextDeltaAt < 0 ||
    timing.lastTextDeltaAt === undefined || !Number.isFinite(timing.lastTextDeltaAt)
  ) return undefined;

  const textTokens = outputTokens - reasoningTokens;
  const generationDurationMs = timing.lastTextDeltaAt - timing.firstTextDeltaAt;
  const generationOutputTokens = textTokens - 1;
  if (textTokens < 32 || generationDurationMs < 500 || generationOutputTokens <= 0) return undefined;

  // API text tokens can include formatting; arrival times still include network chunking.
  return { generationDurationMs, generationOutputTokens };
}
