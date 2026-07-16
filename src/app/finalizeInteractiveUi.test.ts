import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { micaUi } from '@packages/mica-ui/index.js';
import { finalizeInteractiveUi } from './finalizeInteractiveUi.js';

describe('finalizeInteractiveUi', () => {
  it('replaces interactive chrome with conversation history before unmounting', () => {
    const rerender = vi.fn();
    const unmount = vi.fn();

    finalizeInteractiveUi({ rerender, unmount });

    expect(rerender).toHaveBeenCalledOnce();
    const finalFrame = rerender.mock.calls[0]?.[0] as React.ReactElement;
    expect(finalFrame.type).toBe(micaUi.Conversation);
    expect(rerender.mock.invocationCallOrder[0]).toBeLessThan(unmount.mock.invocationCallOrder[0] ?? 0);
    expect(unmount).toHaveBeenCalledOnce();
  });

  it('does nothing when no renderer was mounted', () => {
    expect(() => finalizeInteractiveUi(null)).not.toThrow();
  });
});
