import { describe, expect, it } from 'vitest';
import { keepsSubagentTaskRow } from './subagentVisibility.js';

describe('keepsSubagentTaskRow', () => {
  it('keeps running work and endings that need a look', () => {
    expect(keepsSubagentTaskRow({ status: 'running' })).toBe(true);
    expect(keepsSubagentTaskRow({ status: 'failed' })).toBe(true);
    expect(keepsSubagentTaskRow({ status: 'partial' })).toBe(true);
  });

  it('keeps interrupted work so it can be inspected and restarted', () => {
    expect(keepsSubagentTaskRow({ status: 'killed', interrupted: true })).toBe(true);
  });

  it('drops completed and deliberate kills', () => {
    expect(keepsSubagentTaskRow({ status: 'completed' })).toBe(false);
    expect(keepsSubagentTaskRow({ status: 'killed' })).toBe(false);
    expect(keepsSubagentTaskRow({ status: 'killed', interrupted: false })).toBe(false);
  });
});
