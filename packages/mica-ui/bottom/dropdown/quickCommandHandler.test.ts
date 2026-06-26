import { beforeEach, describe, expect, it, vi } from 'vitest';
import { disabled as inputDisabled } from '../../input/state.js';
import { handleDropdownKey, hideQuickCommands, showQuickCommands } from './quickCommandHandler.js';
import { inputValue, quickCommands, rawInputValue, selection, state } from './state.js';

function resetDropdownState() {
  state.set({ visible: false, items: [], selectedIndex: 0 });
  selection.set(null);
  inputValue.set('');
  rawInputValue.set('');
  quickCommands.set([
    { name: 'agents', description: 'show agents', action: vi.fn() },
    { name: 'model', description: 'switch model', action: vi.fn() },
  ]);
  inputDisabled.set(false);
}

describe('quick command dropdown', () => {
  beforeEach(() => {
    resetDropdownState();
  });

  it('does not take ownership of the terminal input disabled state', () => {
    showQuickCommands('agents');

    expect(state.get().visible).toBe(true);
    expect(inputDisabled.get()).toBe(false);

    hideQuickCommands();

    expect(state.get().visible).toBe(false);
    expect(inputDisabled.get()).toBe(false);
  });

  it('does not clear an externally disabled input when closing', () => {
    inputDisabled.set(true);

    showQuickCommands('agents');
    hideQuickCommands();

    expect(inputDisabled.get()).toBe(true);
  });

  it('lets escape close an empty result dropdown', () => {
    showQuickCommands('missing');

    expect(state.get()).toMatchObject({ visible: true, items: [] });
    expect(handleDropdownKey({ escape: true })).toBe(true);
    expect(state.get().visible).toBe(false);
  });

  it('consumes navigation and submit keys while empty results are visible', () => {
    showQuickCommands('missing');

    expect(handleDropdownKey({ downArrow: true })).toBe(true);
    expect(handleDropdownKey({ upArrow: true })).toBe(true);
    expect(handleDropdownKey({ tab: true })).toBe(true);
    expect(handleDropdownKey({ return: true })).toBe(true);
    expect(state.get().visible).toBe(true);
  });
});
