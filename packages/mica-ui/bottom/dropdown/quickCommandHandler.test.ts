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

  it('shows hidden commands when only one parent command name matches', () => {
    const gitDiffAction = vi.fn();
    const baseAction = vi.fn();
    quickCommands.set([
      { name: 'git-diff-context', description: 'send git diff context', action: gitDiffAction },
      {
        name: 'git-diff-context-base',
        description: 'send git diff from a base branch',
        hidden: true,
        hiddenMenuParent: 'git-diff-context',
        action: baseAction,
      },
      { name: 'commit', description: 'analyze git changes', action: vi.fn() },
    ]);

    showQuickCommands('git');
    expect(state.get().items.map((item) => item.label)).toEqual(['/git-diff-context', '/git-diff-context-base']);

    state.set({ ...state.get(), selectedIndex: 1 });
    expect(handleDropdownKey({ return: true })).toBe(true);
    expect(gitDiffAction).not.toHaveBeenCalled();
    expect(baseAction).toHaveBeenCalledWith(undefined);
  });

  it('does not show hidden commands when multiple parent command names match', () => {
    quickCommands.set([
      { name: 'git-diff-context', description: 'send git diff context', action: vi.fn() },
      {
        name: 'git-diff-context-base',
        description: 'send git diff from a base branch',
        hidden: true,
        hiddenMenuParent: 'git-diff-context',
        action: vi.fn(),
      },
      { name: 'git-status', description: 'show git status', action: vi.fn() },
    ]);

    showQuickCommands('git');
    expect(state.get().items.map((item) => item.label)).toEqual(['/git-diff-context', '/git-status']);
  });

  it('selects a hidden command when the query matches it directly', () => {
    const gitDiffAction = vi.fn();
    const baseAction = vi.fn();
    quickCommands.set([
      { name: 'git-diff-context', description: 'send git diff context', action: gitDiffAction },
      {
        name: 'git-diff-context-base',
        description: 'send git diff from a base branch',
        hidden: true,
        hiddenMenuParent: 'git-diff-context',
        action: baseAction,
      },
    ]);

    showQuickCommands('git-diff-context-base');
    expect(state.get().items.map((item) => item.label)).toEqual(['/git-diff-context-base']);
    expect(state.get().selectedIndex).toBe(0);

    expect(handleDropdownKey({ return: true })).toBe(true);
    expect(gitDiffAction).not.toHaveBeenCalled();
    expect(baseAction).toHaveBeenCalledWith(undefined);
  });

  it('runs hidden menu items with their configured arg', () => {
    const action = vi.fn();
    quickCommands.set([
      {
        name: 'log',
        description: 'show log',
        hiddenMenuItems: [{ arg: 'export', description: 'export logs' }],
        action,
      },
    ]);

    showQuickCommands('log');
    state.set({ ...state.get(), selectedIndex: 1 });

    expect(handleDropdownKey({ return: true })).toBe(true);
    expect(action).toHaveBeenCalledWith('export');
    expect(state.get().visible).toBe(false);
  });

  it('supports dynamic hidden menu items', () => {
    const action = vi.fn();
    quickCommands.set([
      {
        name: 'mcp',
        description: 'show mcp servers',
        hiddenMenuItems: () => [{ arg: 'reconnect cooper', description: 'reconnect cooper' }],
        action,
      },
    ]);

    showQuickCommands('mcp');
    expect(state.get().items.map((item) => item.label)).toEqual(['/mcp', '/mcp reconnect cooper']);

    state.set({ ...state.get(), selectedIndex: 1 });
    expect(handleDropdownKey({ tab: true })).toBe(true);
    expect(action).toHaveBeenCalledWith('reconnect cooper');
  });
});
