import { describe, expect, it } from 'vitest';
import { getWorkingStatusDisplay, getWorkingStatusTotalElapsed } from './workingStatusDisplay.js';

describe('getWorkingStatusDisplay', () => {
  it('labels connecting as waiting for the model', () => {
    expect(getWorkingStatusDisplay({ type: 'connecting' })).toMatchObject({
      text: 'waiting_model',
      spinning: true,
    });
  });

  it('formats total elapsed time from the turn start', () => {
    const startedAt = Date.parse('2024-01-01T00:00:00.000Z');
    const now = Date.parse('2024-01-01T00:01:13.000Z');

    expect(getWorkingStatusTotalElapsed({ type: 'thinking', startedAt, moduleStartedAt: now - 5000 }, now)).toBe(
      '1m 13s',
    );
  });

  it('does not show total elapsed time when no turn is active', () => {
    expect(getWorkingStatusTotalElapsed({ type: 'completed', elapsedMs: 73000 }, Date.now())).toBe('');
  });
});
