import { afterEach, describe, expect, it, vi } from 'vitest';
import { micaCommands } from '@packages/mica-commands/index.js';
import type { PluginContext, PluginStatusItem } from '@packages/mica-plugin/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import { getToolIcon } from '@packages/mica-ui/agentTurnLogItems.js';
import { parseTodoInput, TodoPlugin } from './TodoPlugin.js';

describe('parseTodoInput', () => {
  it('normalizes a valid replacement list', () => {
    const parsed = parseTodoInput({
      todos: [{ content: '  Run tests  ', activeForm: '  Running tests  ', status: 'in_progress' }],
    });

    expect(parsed).toEqual({
      ok: true,
      items: [{ content: 'Run tests', activeForm: 'Running tests', status: 'in_progress' }],
    });
  });

  it('rejects multiple in-progress items', () => {
    const parsed = parseTodoInput({
      todos: [
        { content: 'One', activeForm: 'Doing one', status: 'in_progress' },
        { content: 'Two', activeForm: 'Doing two', status: 'in_progress' },
      ],
    });

    expect(parsed).toEqual({ ok: false, message: 'only one todo may be in_progress at a time' });
  });

  it('rejects empty text and unknown fields', () => {
    expect(parseTodoInput({ todos: [{ content: '', activeForm: 'Working', status: 'pending' }] })).toEqual({
      ok: false,
      message: 'todos[0].content must not be empty',
    });
    expect(parseTodoInput({ todos: [], visible: true })).toEqual({
      ok: false,
      message: 'unknown input field: visible',
    });
  });
});

describe('TodoPlugin', () => {
  const disposeCallbacks: Array<() => void | Promise<void>> = [];

  it('uses a dedicated tool-call icon', () => {
    expect(getToolIcon('TodoWrite')).toBe('📝');
  });

  afterEach(async () => {
    for (const dispose of disposeCallbacks.splice(0).reverse()) await dispose();
  });

  it('registers the tool, status component, and command', async () => {
    const commands = new micaCommands.CommandRegistry();
    const upsert = vi.fn<(item: PluginStatusItem) => void>();
    const remove = vi.fn<(id: string) => boolean>(() => true);
    const ctx = {
      pluginId: 'builtin.todo',
      commands,
      ui: {
        submit: vi.fn(),
        showMessage: vi.fn(),
        status: { upsert, remove },
      },
      onDispose: (dispose: () => void | Promise<void>) => disposeCallbacks.push(dispose),
    } as unknown as PluginContext;

    new TodoPlugin().setup(ctx);

    expect(upsert).toHaveBeenCalledWith({
      id: 'builtin.todo.list',
      component: expect.any(Function),
    });
    expect(commands.resolve('/todo show')?.command.name).toBe('todo');
    expect(micaTools.getDefinitions().some((tool) => tool.name === 'TodoWrite')).toBe(true);

    const result = await micaTools.execute('TodoWrite', {
      todos: [
        { content: 'Inspect code', activeForm: 'Inspecting code', status: 'completed' },
        { content: 'Run tests', activeForm: 'Running tests', status: 'in_progress' },
      ],
    });
    expect(result).toBe('Todo list updated: 2 total, 1 completed, 0 pending. Current: Running tests');

    await commands.execute('/todo hide');
    expect(ctx.ui?.showMessage).toHaveBeenCalledWith('Todo list hidden. Use /todo show to restore it.');

    for (const dispose of disposeCallbacks.splice(0).reverse()) await dispose();
    expect(remove).toHaveBeenCalledWith('builtin.todo.list');
    expect(micaTools.getDefinitions().some((tool) => tool.name === 'TodoWrite')).toBe(false);
  });

  it('returns a validation error without replacing the list', async () => {
    const ctx = {
      pluginId: 'builtin.todo',
      commands: new micaCommands.CommandRegistry(),
      onDispose: (dispose: () => void | Promise<void>) => disposeCallbacks.push(dispose),
    } as unknown as PluginContext;
    new TodoPlugin().setup(ctx);

    const result = await micaTools.execute('TodoWrite', {
      todos: [{ content: 'Test', activeForm: 'Testing', status: 'unknown' }],
    });

    expect(result).toContain('TodoWrite 输入校验失败');
    expect(result).toContain('status must be pending, in_progress, or completed');
  });
});
