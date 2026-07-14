import { describe, expect, it } from 'vitest';
import { initMcp } from './service.js';

describe('initMcp', () => {
  it('rejects an already-aborted headless initialization', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(initMcp({ signal: controller.signal })).rejects.toThrow('cancelled');
  });
});
