import { beforeEach, describe, expect, it, vi } from 'vitest';
import { disabled as inputDisabled } from '../../input/state.js';
import { handleDropdownKey, hideQuickCommands, showQuickCommands, setSelectEmitter } from './quickCommandHandler.js';
import { inputValue, quickCommands, rawInputValue, selection, state } from './state.js';
import { agentStatusItems, backgroundTaskItems } from '../../panels/state.js';

function resetDropdownState() {
  state.set({ visible: false, items: [], selectedIndex: 0 });
  selection.set(null);
  inputValue.set('');
  rawInputValue.set('');
  backgroundTaskItems.set([]);
  agentStatusItems.set([]);
  quickCommands.set([
    { name: 'agents', description: 'show agents', action: vi.fn() },
    { name: 'model', description: 'switch model', action: vi.fn() },
  ]);
  inputDisabled.set(false);
}

describe('quick command dropdown', () => {
  beforeEach(() => {
    resetDropdownState();
    setSelectEmitter(() => {});
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

  it('shows completion items when only one command matches', () => {
    quickCommands.set([
      {
        name: 'log',
        description: 'show log',
        completionItems: [{ arg: 'export', description: 'export logs' }],
        action: vi.fn(),
      },
      { name: 'list', description: 'show list', action: vi.fn() },
    ]);

    showQuickCommands('log');
    expect(state.get().items.map((item) => item.label)).toEqual(['/log', '/log export']);
  });

  it('prioritizes /task when active background tasks exist', () => {
    quickCommands.set([
      { name: 'model', description: 'switch model', action: vi.fn() },
      { name: 'task', description: 'show tasks', action: vi.fn() },
    ]);
    backgroundTaskItems.set([
      {
        id: 'task-1',
        command: 'npm run dev',
        cwd: '/tmp/project',
        shell: '/bin/sh',
        outputPath: '/tmp/task-1.out',
        outputSize: 10,
        status: 'running',
        startedAt: '2026-01-02T03:04:05.000Z',
      },
    ]);

    showQuickCommands('');

    expect(state.get().items.map((item) => item.label)).toEqual(['/task', '/model']);
  });

  it('prioritizes /task when a background agent exists', () => {
    quickCommands.set([
      { name: 'model', description: 'switch model', action: vi.fn() },
      { name: 'task', description: 'show tasks', action: vi.fn() },
    ]);
    agentStatusItems.set([
      {
        id: 'agent-1',
        index: 1,
        title: 'current agent',
        cwd: '/tmp/project',
        providerName: 'provider',
        model: 'model',
        status: { type: 'idle' },
        current: true,
        startedAt: '2026-01-02T03:04:05.000Z',
        updatedAt: '2026-01-02T03:04:05.000Z',
      },
      {
        id: 'agent-2',
        index: 2,
        title: 'background agent',
        cwd: '/tmp/project',
        providerName: 'provider',
        model: 'model',
        status: { type: 'thinking' },
        current: false,
        startedAt: '2026-01-02T03:04:05.000Z',
        updatedAt: '2026-01-02T03:04:05.000Z',
      },
    ]);

    showQuickCommands('');

    expect(state.get().items.map((item) => item.label)).toEqual(['/task', '/model']);
  });

  it('does not prioritize /task for the current agent alone', () => {
    quickCommands.set([
      { name: 'model', description: 'switch model', action: vi.fn() },
      { name: 'task', description: 'show tasks', action: vi.fn() },
    ]);
    agentStatusItems.set([
      {
        id: 'agent-1',
        index: 1,
        title: 'current agent',
        cwd: '/tmp/project',
        providerName: 'provider',
        model: 'model',
        status: { type: 'idle' },
        current: true,
        startedAt: '2026-01-02T03:04:05.000Z',
        updatedAt: '2026-01-02T03:04:05.000Z',
      },
    ]);

    showQuickCommands('');

    expect(state.get().items.map((item) => item.label)).toEqual(['/model', '/task']);
  });

  it('keeps exact and prefix matches ahead of task priority', () => {
    quickCommands.set([
      { name: 'model', description: 'switch model', action: vi.fn() },
      { name: 'task', description: 'show tasks', action: vi.fn() },
    ]);
    backgroundTaskItems.set([
      {
        id: 'task-1',
        command: 'npm run dev',
        cwd: '/tmp/project',
        shell: '/bin/sh',
        outputPath: '/tmp/task-1.out',
        outputSize: 10,
        status: 'running',
        startedAt: '2026-01-02T03:04:05.000Z',
      },
    ]);

    showQuickCommands('mo');

    expect(state.get().items.map((item) => item.label)).toEqual(['/model']);
  });

  it('filters completion items by argument text', () => {
    quickCommands.set([
      {
        name: 'mcp',
        description: 'show mcp servers',
        completionItems: () => [{ arg: 'reconnect cooper', description: 'reconnect cooper' }],
        action: vi.fn(),
      },
    ]);

    showQuickCommands('mcp reconnect');
    expect(state.get().items.map((item) => item.label)).toEqual(['/mcp', '/mcp reconnect cooper']);
  });

  it('runs command with typed arguments on enter', () => {
    const action = vi.fn();
    quickCommands.set([{ name: 'log', description: 'show log', action }]);

    showQuickCommands('log export');
    expect(handleDropdownKey({ return: true })).toBe(true);
    expect(action).toHaveBeenCalledWith('export');
  });

  it('runs selected completion on enter', () => {
    const action = vi.fn();
    quickCommands.set([
      {
        name: 'task',
        description: 'show tasks',
        completionItems: [{ arg: 'clear', description: 'clear idle tasks' }],
        action,
      },
    ]);

    showQuickCommands('task');
    state.set({ ...state.get(), selectedIndex: 1 });

    expect(handleDropdownKey({ return: true })).toBe(true);
    expect(action).toHaveBeenCalledWith('clear');
  });

  it('emits selected completion text on tab', () => {
    const emit = vi.fn();
    setSelectEmitter(emit);
    quickCommands.set([
      {
        name: 'task',
        description: 'show tasks',
        completionItems: [{ arg: 'clear', description: 'clear idle tasks' }],
        action: vi.fn(),
      },
    ]);

    showQuickCommands('task');
    state.set({ ...state.get(), selectedIndex: 1 });

    expect(handleDropdownKey({ tab: true })).toBe(true);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ insertText: '/task clear' }));
    expect(state.get().visible).toBe(true);
  });
});
