import { describe, expect, it, vi } from 'vitest';
import { handleScrollInput } from '../shared/commandInput.js';

describe('handleScrollInput', () => {
  it.each([
    [{ upArrow: true }, -1],
    [{ downArrow: true }, 1],
    [{ pageUp: true }, -7],
    [{ pageDown: true }, 7],
  ] as const)('scrolls for navigation key %o', (key, expectedOffset) => {
    const scrollBy = vi.fn();

    expect(handleScrollInput({ getViewportHeight: () => 8, scrollBy }, key)).toBe(true);
    expect(scrollBy).toHaveBeenCalledWith(expectedOffset);
  });

  it('does not consume unrelated input', () => {
    const scrollBy = vi.fn();

    expect(handleScrollInput({ getViewportHeight: () => 8, scrollBy }, {})).toBe(false);
    expect(scrollBy).not.toHaveBeenCalled();
  });

  it('consumes a scroll key before the view ref is mounted', () => {
    expect(handleScrollInput(null, { downArrow: true })).toBe(true);
  });
});
