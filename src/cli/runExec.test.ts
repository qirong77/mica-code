import { describe, expect, it } from 'vitest';
import type { CodexExecEvent } from '@packages/mica-runtime/index.js';
import { runExec } from './runExec.js';

describe('runExec lifecycle', () => {
  it('does not start a session or model request when the external signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const events: CodexExecEvent[] = [];

    const result = await runExec({
      prompt: 'should not run',
      signal: controller.signal,
      writer: { write: (event) => events.push(event) },
    });

    expect(result).toMatchObject({ status: 'aborted', exitCode: 130, sessionId: '' });
    expect(events).toEqual([]);
  });
});
