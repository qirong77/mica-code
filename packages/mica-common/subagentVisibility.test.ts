import { describe, expect, it } from 'vitest';
import { keepsSubagentTaskRow } from './subagentVisibility.js';

describe('keepsSubagentTaskRow', () => {
  it('keeps unfinished or actionable work and hides normal completion', () => {
    expect(keepsSubagentTaskRow({ status: 'running' })).toBe(true);
    expect(keepsSubagentTaskRow({ status: 'failed' })).toBe(true);
    expect(keepsSubagentTaskRow({ status: 'partial' })).toBe(true);
    expect(keepsSubagentTaskRow({ status: 'killed', interrupted: true })).toBe(true);
    expect(keepsSubagentTaskRow({ status: 'completed' })).toBe(false);
    expect(keepsSubagentTaskRow({ status: 'killed' })).toBe(false);
  });
});
