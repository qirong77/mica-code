import { describe, expect, it } from 'vitest';
import { formatStructuredSubagentResult, parseStructuredSubagentResult } from './result.js';

describe('subagent long-result parsing', () => {
  it.each(['word', 'braces', 'fence'] as const)('bounds parent output for a 512 KiB %s result', (shape) => {
    const raw =
      shape === 'word'
        ? 'a'.repeat(512_000)
        : shape === 'braces'
          ? '{'.repeat(512_000)
          : `\x60\x60\x60json${' '.repeat(512_000)}x`;
    const start = performance.now();
    const parsed = parseStructuredSubagentResult(raw);
    const rendered = formatStructuredSubagentResult({ type: 'Explore', description: 'pressure', result: raw });
    console.info(
      'subagent result pressure',
      JSON.stringify({ shape, chars: raw.length, elapsedMs: performance.now() - start }),
    );
    expect(parsed.raw).toBe(raw.trim());
    expect(parsed.summary.length).toBeLessThanOrEqual(2_000);
    expect(parsed.files_touched).toEqual([]);
    expect(rendered.length).toBeLessThan(9_000);
  });
});
