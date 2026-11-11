import { describe, expect, it } from 'vitest';
import { keepsBackgroundTaskRow } from './backgroundTaskVisibility.js';

describe('keepsBackgroundTaskRow', () => {
  it('keeps active tasks so the row can show progress', () => {
    expect(keepsBackgroundTaskRow({ status: 'starting' })).toBe(true);
    expect(keepsBackgroundTaskRow({ status: 'running' })).toBe(true);
  });

  it('drops killed tasks: model kills and host cleanup are already explained', () => {
    expect(keepsBackgroundTaskRow({ status: 'killed', exitCode: null })).toBe(false);
  });

  it('hides all ended tasks regardless of exit status', () => {
    expect(keepsBackgroundTaskRow({ status: 'finished', exitCode: 0 })).toBe(false);
    expect(keepsBackgroundTaskRow({ status: 'finished', exitCode: 2 })).toBe(false);
    expect(keepsBackgroundTaskRow({ status: 'failed' })).toBe(false);
    expect(keepsBackgroundTaskRow({ status: 'unknown_exited' })).toBe(false);
  });
});
