import { describe, expect, it } from 'vitest';
import { observeGenerationText, sampleGenerationTiming, type GenerationTiming } from './generationTiming.js';

const validTiming: GenerationTiming = {
  firstTextDeltaAt: 100,
  lastTextDeltaAt: 600,
  textDeltaCount: 2,
  hasOtherOutput: false,
};

describe('generation timing', () => {
  it('observes only nonempty body deltas, including an epoch-zero first delta', () => {
    const timing: GenerationTiming = { textDeltaCount: 0, hasOtherOutput: false };
    observeGenerationText(timing, '', 0);
    expect(timing).toEqual({ textDeltaCount: 0, hasOtherOutput: false });
    observeGenerationText(timing, 'first', 0);
    observeGenerationText(timing, '', 100);
    observeGenerationText(timing, 'last', 500);
    expect(timing).toEqual({ firstTextDeltaAt: 0, lastTextDeltaAt: 500, textDeltaCount: 2, hasOtherOutput: false });
    expect(sampleGenerationTiming(timing, 32, 0)).toEqual({ generationDurationMs: 500, generationOutputTokens: 31 });
  });

  it('subtracts hidden reasoning and the first token from API output', () => {
    expect(sampleGenerationTiming(validTiming, 132, 100)).toEqual({
      generationDurationMs: 500,
      generationOutputTokens: 31,
    });
  });

  it.each([undefined, null, '64', NaN, Infinity, -Infinity, -1, 0, 64.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid API output tokens: %s', (output) => {
      expect(sampleGenerationTiming(validTiming, output, 0)).toBeUndefined();
    },
  );

  it.each([undefined, null, '0', NaN, Infinity, -Infinity, -1, 0.5, 65, Number.MAX_SAFE_INTEGER + 1])(
    'rejects missing or invalid reasoning details: %s', (reasoning) => {
      expect(sampleGenerationTiming(validTiming, 64, reasoning)).toBeUndefined();
    },
  );

  it.each([
    { textDeltaCount: 0 },
    { textDeltaCount: 1 },
    { textDeltaCount: 2.5 },
    { textDeltaCount: NaN },
    { textDeltaCount: Infinity },
    { firstTextDeltaAt: undefined },
    { firstTextDeltaAt: NaN },
    { firstTextDeltaAt: Infinity },
    { firstTextDeltaAt: -1 },
    { lastTextDeltaAt: undefined },
    { lastTextDeltaAt: NaN },
    { lastTextDeltaAt: Infinity },
    { lastTextDeltaAt: -1 },
    { lastTextDeltaAt: 99 },
    { lastTextDeltaAt: 599 },
    { hasOtherOutput: true },
  ])('rejects insufficient or unattributable timing: %j', (patch) => {
    expect(sampleGenerationTiming({ ...validTiming, ...patch }, 64, 0)).toBeUndefined();
  });

  it.each([[31, 0], [64, 33], [64, 64], [1, 0]])(
    'requires at least 32 body tokens for output=%s reasoning=%s', (output, reasoning) => {
      expect(sampleGenerationTiming(validTiming, output, reasoning)).toBeUndefined();
    },
  );

  it('excludes the reproduced 27-output / 15-reasoning / 11-ms spike', () => {
    expect(sampleGenerationTiming({ ...validTiming, lastTextDeltaAt: 111 }, 27, 15)).toBeUndefined();
  });
});
