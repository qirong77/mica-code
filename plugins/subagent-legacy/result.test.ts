import { describe, expect, it } from 'vitest';
import { formatStructuredSubagentResult, parseStructuredSubagentResult } from './result.js';

describe('subagentResult', () => {
  it('finds JSON inside prose or fences and ignores incomplete wrappers', () => {
    for (const input of ['prefix {"summary":"found"} suffix', '```json\n{"summary":"found"}\n```']) {
      expect(parseStructuredSubagentResult(input).summary).toBe('found');
    }
    expect(parseStructuredSubagentResult('```json\n  {').summary).toContain('```json');
  });

  it('extracts bounded distinct paths at segment boundaries', () => {
    const input = 'src/a.ts ./src/b.ts ../lib/c.ts /tmp/d.ts C:/repo/e.ts src/a.ts';
    expect(parseStructuredSubagentResult(input).files_touched).toEqual([
      'src/a.ts',
      './src/b.ts',
      '../lib/c.ts',
      '/tmp/d.ts',
      'C:/repo/e.ts',
    ]);
    expect(parseStructuredSubagentResult(`src/${'a'.repeat(10_000)}`).files_touched[0]!.length).toBeLessThanOrEqual(
      400,
    );
  });

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

  it('keeps the caller-supplied status when the payload does not declare one', () => {
    const text = formatStructuredSubagentResult({
      type: 'Tester',
      description: 'run the unit tests',
      result: 'one test failed',
      status: 'partial',
    });

    expect(text).toContain('Status: partial');
  });

  it('does not promote a failed or partial run based on its untrusted JSON payload', () => {
    for (const status of ['failed', 'partial'] as const) {
      const text = formatStructuredSubagentResult({
        type: 'Tester',
        description: 'verify',
        status,
        result: JSON.stringify({ status: 'completed', summary: 'done' }),
      });
      expect(text).toContain(`Status: ${status}`);
    }
  });

  it('keeps the host-reported error outside the raw result budget', () => {
    const text = formatStructuredSubagentResult({
      type: 'Explore',
      description: 'inspect loader',
      result: 'a'.repeat(60_000),
      status: 'failed',
      error: '429 rate limit exceeded after 3 retries',
    });

    expect(text).toContain('## Error');
    expect(text).toContain('429 rate limit exceeded after 3 retries');
    expect(text.indexOf('## Error')).toBeLessThan(text.indexOf('## Raw result'));
    expect(text.length).toBeLessThan(9_000);
  });
});
