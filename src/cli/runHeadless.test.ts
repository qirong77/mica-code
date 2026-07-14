import { describe, expect, it } from 'vitest';
import type { RunJsonEvent } from '@packages/mica-runtime/index.js';
import { runHeadless } from './runHeadless.js';

describe('runHeadless lifecycle', () => {
  it('does not start a session or model request when the external signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const events: RunJsonEvent[] = [];

    const result = await runHeadless({
      prompt: 'should not run',
      signal: controller.signal,
      writer: { write: (event) => events.push(event) },
    });

    expect(result).toMatchObject({ status: 'aborted', exitCode: 130, sessionId: '' });
    expect(events).toEqual([]);
  });
});
