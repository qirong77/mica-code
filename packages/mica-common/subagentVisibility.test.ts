import { describe, expect, it } from 'vitest';
import { keepsSubagentTaskRow } from './subagentVisibility.js';

describe('keepsSubagentTaskRow', () => {
  it('lists only running work and hides every terminal state', () => {
    expect(keepsSubagentTaskRow({ status: 'running' })).toBe(true);
    expect(keepsSubagentTaskRow({ status: 'completed' })).toBe(false);
    expect(keepsSubagentTaskRow({ status: 'failed' })).toBe(false);
    expect(keepsSubagentTaskRow({ status: 'partial' })).toBe(false);
    expect(keepsSubagentTaskRow({ status: 'killed' })).toBe(false);
  });
});
