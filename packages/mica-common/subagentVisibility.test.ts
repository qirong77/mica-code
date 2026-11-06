import { describe, expect, it } from 'vitest';
import { keepsSubagentTaskRow } from './subagentVisibility.js';

describe('keepsSubagentTaskRow', () => {
  it('keeps only running work', () => {
    expect(keepsSubagentTaskRow({ status: 'running' })).toBe(true);
    expect(keepsSubagentTaskRow({ status: 'failed' })).toBe(false);
    expect(keepsSubagentTaskRow({ status: 'partial' })).toBe(false);
    expect(keepsSubagentTaskRow({ status: 'killed', interrupted: true })).toBe(false);
    expect(keepsSubagentTaskRow({ status: 'completed' })).toBe(false);
    expect(keepsSubagentTaskRow({ status: 'killed' })).toBe(false);
  });
});
