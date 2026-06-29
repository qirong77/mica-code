import { describe, expect, it } from 'vitest';
import { RUN_SHELL_VERBOSE_LOG_THRESHOLD_MS, getErrorStackLines, shouldShowToolOutput } from './agentTurnLogItems.js';

describe('agent turn error log items', () => {
  it('skips multiline error message lines when extracting stack frames', () => {
    const error = new Error('Request failed: {\n  "error": "bad request"\n}');
    error.stack = `${error.name}: ${error.message}\n    at request (/repo/client.ts:10:3)\n    at run (/repo/runtime.ts:20:5)`;

    expect(getErrorStackLines(error)).toEqual([
      '    at request (/repo/client.ts:10:3)',
      '    at run (/repo/runtime.ts:20:5)',
    ]);
  });

  it('returns an empty stack for non-error values', () => {
    expect(getErrorStackLines('plain failure')).toEqual([]);
  });
});

describe('run shell tool output logs', () => {
  it('hides command output at or below the verbose threshold', () => {
    expect(
      shouldShowToolOutput({
        toolName: 'run_shell',
        output: '[stdout]\nfast output',
        elapsedMs: RUN_SHELL_VERBOSE_LOG_THRESHOLD_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldShowToolOutput({
        toolName: 'run_shell',
        output: '[stdout]\nfast output',
        elapsedMs: RUN_SHELL_VERBOSE_LOG_THRESHOLD_MS,
      }),
    ).toBe(false);
  });

  it('shows command output once the verbose threshold is exceeded', () => {
    expect(
      shouldShowToolOutput({
        toolName: 'run_shell',
        output: '[stdout]\nslow output',
        elapsedMs: RUN_SHELL_VERBOSE_LOG_THRESHOLD_MS + 1,
      }),
    ).toBe(true);
  });
});
