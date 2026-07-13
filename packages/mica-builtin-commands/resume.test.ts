import { describe, expect, it } from 'vitest';
import { formatResumeSessionTitle } from './resume.js';

describe('formatResumeSessionTitle', () => {
  it('prefixes sessions whose last turn did not complete', () => {
    expect(formatResumeSessionTitle({ title: 'Fix checkout', uncompleted: true })).toBe(
      '（uncompleted）Fix checkout',
    );
  });

  it('keeps completed session titles unchanged', () => {
    expect(formatResumeSessionTitle({ title: 'Fix checkout', uncompleted: false })).toBe('Fix checkout');
  });
});
