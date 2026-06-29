import { describe, expect, it } from 'vitest';
import { getWorkingStatusDisplay } from './workingStatusDisplay.js';

describe('getWorkingStatusDisplay', () => {
  it('labels connecting as waiting for the model', () => {
    expect(getWorkingStatusDisplay({ type: 'connecting' })).toMatchObject({
      text: 'waiting_model',
      spinning: true,
    });
  });
});
