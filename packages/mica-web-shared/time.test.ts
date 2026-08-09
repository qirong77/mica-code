import { describe, expect, it } from 'vitest';
import { relativeTimeShort } from './time.js';

describe('relativeTimeShort', () => {
  it('accepts numeric timestamps as numbers or serialized strings', () => {
    const now = 1_800_000_000_000;
    const timestamp = now - 5 * 60_000;

    expect(relativeTimeShort(timestamp, now)).toBe('5m');
    expect(relativeTimeShort(String(timestamp), now)).toBe('5m');
  });

  it('accepts ISO timestamps and rejects invalid values', () => {
    const now = Date.parse('2026-08-07T10:00:00.000Z');

    expect(relativeTimeShort('2026-08-07T08:00:00.000Z', now)).toBe('2h');
    expect(relativeTimeShort('invalid', now)).toBe('');
  });
});
