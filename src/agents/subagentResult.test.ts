import { describe, expect, it } from 'vitest';
import { formatStructuredSubagentResult, parseStructuredSubagentResult } from './subagentResult.js';

describe('subagentResult', () => {
  it('parses json object results', () => {
    const parsed = parseStructuredSubagentResult(
      JSON.stringify({
        summary: 'done',
        findings: ['a'],
        files_touched: ['src/a.ts'],
        risks: ['none'],
        next_actions_for_parent: ['review'],
      }),
    );

    expect(parsed.summary).toBe('done');
    expect(parsed.findings).toEqual(['a']);
    expect(parsed.files_touched).toEqual(['src/a.ts']);
  });

  it('formats free-text results into a stable parent-facing summary', () => {
    const text = formatStructuredSubagentResult({
      type: 'Explore',
      description: 'inspect loader',
      result: 'Found packages/mica-config/config.ts and packages/mica-config/index.ts',
    });

    expect(text).toContain('Subagent: Explore');
    expect(text).toContain('## Summary');
    expect(text).toContain('packages/mica-config/config.ts');
  });
});
