import { describe, expect, it } from 'vitest';
import { getErrorStackLines } from './agentTurnLogItems.js';

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
