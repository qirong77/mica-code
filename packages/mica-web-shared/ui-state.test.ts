import { describe, expect, it } from 'vitest';
import {
  applyUiStatePatch,
  isUiStateKey,
  sanitizeUiStateKeys,
  uiStateChangeSet,
  uiStateValuesEqual,
} from './ui-state.js';

describe('mica-web-shared ui-state', () => {
  describe('isUiStateKey', () => {
    it('accepts plain string keys and rejects prototypes and empties', () => {
      expect(isUiStateKey('drafts')).toBe(true);
      expect(isUiStateKey('layout.sidebarWidth')).toBe(true);
      expect(isUiStateKey('')).toBe(false);
      expect(isUiStateKey('__proto__')).toBe(false);
      expect(isUiStateKey('constructor')).toBe(false);
      expect(isUiStateKey('a'.repeat(129))).toBe(false);
      expect(isUiStateKey(null)).toBe(false);
      expect(isUiStateKey(42)).toBe(false);
    });
  });

  describe('uiStateValuesEqual', () => {
    it('compares objects by content, since JSON round-trips lose identity', () => {
      expect(uiStateValuesEqual({ a: 1 }, { a: 1 })).toBe(true);
      expect(uiStateValuesEqual({ a: 1 }, { a: 2 })).toBe(false);
      expect(uiStateValuesEqual([1, 2], [1, 2])).toBe(true);
    });

    it('treats null, undefined and missing keys as different', () => {
      expect(uiStateValuesEqual(null, undefined)).toBe(false);
      expect(uiStateValuesEqual('x', 'x')).toBe(true);
    });
  });

  describe('applyUiStatePatch', () => {
    it('returns null when nothing actually changed', () => {
      const current = { layout: { width: 200 } };
      expect(applyUiStatePatch(current, { layout: { width: 200 } })).toBeNull();
      expect(applyUiStatePatch(current, {})).toBeNull();
      expect(applyUiStatePatch(current, null)).toBeNull();
    });

    it('merges whole keys and never mutates the input table', () => {
      const current = { layout: { width: 200 }, drafts: { a: 'hi' } };
      const next = applyUiStatePatch(current, { layout: { width: 260 } });
      expect(next).toEqual({ layout: { width: 260 }, drafts: { a: 'hi' } });
      expect(current).toEqual({ layout: { width: 200 }, drafts: { a: 'hi' } });
    });

    it('deletes keys with null and ignores reserved names', () => {
      const current = { drafts: { a: 'hi' }, layout: { width: 200 } };
      const next = applyUiStatePatch(current, { drafts: null, __proto__: { polluted: true } });
      expect(next).toEqual({ layout: { width: 200 } });
      expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
    });

    it('starts from an empty table when there is no current state', () => {
      expect(applyUiStatePatch(null, { layout: { width: 1 } })).toEqual({ layout: { width: 1 } });
    });
  });

  describe('uiStateChangeSet', () => {
    it('reports only the keys whose value changed, plus deletions as null', () => {
      const before = { layout: { width: 200 }, drafts: { a: 'hi' }, files: { root: '/x' } };
      const after = { layout: { width: 260 }, drafts: { a: 'hi' } };
      expect(uiStateChangeSet(before, after)).toEqual({ layout: { width: 260 }, files: null });
    });
  });

  describe('sanitizeUiStateKeys', () => {
    it('drops unknown shapes and null values, keeping the rest', () => {
      expect(sanitizeUiStateKeys({ layout: { width: 1 }, bad: null, __proto__: 1 })).toEqual({
        layout: { width: 1 },
      });
      expect(sanitizeUiStateKeys(null)).toEqual({});
      expect(sanitizeUiStateKeys(['layout'])).toEqual({});
    });
  });
});
