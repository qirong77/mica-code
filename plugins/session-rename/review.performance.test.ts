import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import { buildTranscript } from './transcript.js';
import { messageText, sessionMarkdown } from '../session-copy/markdown.js';
import { emptyTagStore, resolveTagTokens } from '../session-tags/tags.js';

// Opt in to reproducible timing samples; correctness is covered by the regular regression tests.
describe.skipIf(process.env.MICA_PLUGIN_REVIEW_BENCH !== '1')('session plugin performance samples', () => {
  it('samples bounded title context, full exports, malformed image references and tag commands', () => {
    const sample = (name: string, size: number, run: () => unknown) => {
      run();
      const timings: number[] = [];
      for (let index = 0; index < 5; index += 1) {
        const start = performance.now();
        run();
        timings.push(performance.now() - start);
      }
      timings.sort((a, b) => a - b);
      console.info(JSON.stringify({ name, size, medianMs: Number(timings[2]!.toFixed(3)) }));
    };
    for (const size of [20_000, 80_000]) {
      const history: MicaUiConversationMessage[] = Array.from({ length: size }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        content: `message ${index}: ${'context '.repeat(75)}`,
      }));
      expect(buildTranscript(history, { maxMessages: 12 })).toHaveLength(12);
      sample('title-history', size, () => buildTranscript(history, { maxMessages: 12 }));
      sample('copy-history', size, () => sessionMarkdown({ title: 'Review' }, history));
    }
    for (const size of [2_000, 8_000]) {
      const text = '[Image]('.repeat(size);
      expect(messageText(text)).toBe(text);
      sample('copy-unclosed-images', size, () => messageText(text));
    }
    const store = emptyTagStore();
    for (const size of [200, 800]) {
      const tokens = Array.from({ length: size }, () => 'unknown');
      sample('tags-unknown', size, () => resolveTagTokens(store, tokens));
    }
  });
});
