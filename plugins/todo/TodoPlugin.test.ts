import { afterEach, describe, expect, it, vi } from 'vitest';
import { micaCommands } from '@packages/mica-commands/index.js';
import {
  micaPlugin,
  type PluginContext,
  type PluginPromptSection,
  type PluginStatusItem,
} from '@packages/mica-plugin/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { micaTools, type MicaTool, type ToolExecuteCallbacks } from '@packages/mica-tools/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import { TodoPlugin } from './TodoPlugin.js';

describe('TodoPlugin', () => {
  const disposeCallbacks: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const dispose of disposeCallbacks.splice(0).reverse()) await dispose();
    vi.restoreAllMocks();
  });

  it('registers the tool, status component, and command', async () => {
    const harness = createTodoHarness(disposeCallbacks);

    expect(harness.upsert).toHaveBeenCalledWith({ id: 'todo.list', component: expect.any(Function) });
    expect(harness.commands.resolve('/todo show')?.command.name).toBe('todo');
    expect(harness.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'todo_write' }), {
      icon: '📝',
      primaryAgentOnly: true,
    });

    const description = micaTools.getDefinitions().find((tool) => tool.name === 'todo_write')?.description ?? '';
    expect(description).toContain('the complete list on every call');
    expect(description).toContain('Only call it when the list actually changes');

    const result = await micaTools.execute('todo_write', {
      todos: [
        { content: 'Inspect code', status: 'completed' },
        { content: 'Run tests', status: 'in_progress' },
      ],
    });
    expect(result).toBe(['TODO 清单已更新：1/2 完成，剩 1 项。', '- [>] Run tests'].join('\n'));

    await harness.commands.execute('/todo hide');
    expect(harness.showMessage).toHaveBeenCalledWith('Todo list hidden. Use /todo show to restore it.');

    for (const dispose of disposeCallbacks.splice(0).reverse()) await dispose();
    expect(harness.remove).toHaveBeenCalledWith('todo.list');
    expect(micaTools.getDefinitions().some((tool) => tool.name === 'todo_write')).toBe(false);
  });

  it('contributes the plan guidance as a prompt section that goes away with the tool', async () => {
    const harness = createTodoHarness(disposeCallbacks);
    const rendered = harness.promptSections.render();

    expect(rendered).toContain('# 计划');
    expect(rendered).toContain('`todo_write`');
    // 与工具描述同源：段落不能和 schema 说相反的话。
    expect(rendered).toContain('只在清单确实变化时重发整份清单');

    for (const dispose of disposeCallbacks.splice(0).reverse()) await dispose();
    expect(harness.promptSections.size).toBe(0);
  });

  it('accepts a list with several in-progress items instead of failing the call', async () => {
    createTodoHarness(disposeCallbacks);

    const result = await micaTools.execute('todo_write', {
      todos: [
        { content: 'One', status: 'in_progress' },
        { content: 'Two', status: 'in_progress' },
      ],
    });

    expect(result).toContain('0/2 完成');
    expect(result).toContain('同时只保留一项 in_progress');
  });

  it('rejects only input that is structurally not a list', async () => {
    createTodoHarness(disposeCallbacks);

    const result = await micaTools.execute('todo_write', { todos: 'nope' });
    expect(result).toContain('todo_write 输入校验失败');
    expect(result).toContain('参数 todos 应为 array 类型');
  });

  it('clears retained todo state when the session is cleared', async () => {
    const harness = createTodoHarness(disposeCallbacks);

    await micaTools.execute('todo_write', {
      todos: [{ content: 'Test', status: 'pending' }],
    });
    harness.events.publish({ type: 'session:cleared' });
    await harness.commands.execute('/todo show');

    expect(harness.showMessage).toHaveBeenCalledWith('Todo list is empty.');
  });

  it('clears retained todo state after resume and rewind replace the session history', async () => {
    const harness = createTodoHarness(disposeCallbacks);

    for (const reason of ['resume', 'rewind'] as const) {
      await micaTools.execute('todo_write', { todos: [{ content: 'Old task', status: 'pending' }] });
      harness.events.publish({ type: 'session:invalidated', reason });
      await harness.commands.execute('/todo show');
      expect(harness.showMessage).toHaveBeenLastCalledWith('Todo list is empty.');
    }
  });

  it('never marks leftover items completed when the turn finishes', async () => {
    const harness = createTodoHarness(disposeCallbacks);

    await micaTools.execute('todo_write', {
      todos: [
        { content: 'Done thing', status: 'completed' },
        { content: 'Unfinished work', status: 'pending' },
      ],
    });
    await harness.hooks.emit('turn:after', {
      input: micaRuntime.createRuntimeInput('test', 'ui'),
      elapsedMs: 10,
      hasError: false,
      outcome: 'completed',
    });
    await harness.commands.execute('/todo show');

    // 回归点：正常结束的 turn 不证明剩余项做完了，回显必须仍然报告未完成。
    expect(harness.showMessage).toHaveBeenLastCalledWith(
      ['TODO 清单已更新：1/2 完成，剩 1 项。', '- [ ] Unfinished work'].join('\n'),
    );
  });

  it('clears the list through the /todo command', async () => {
    const harness = createTodoHarness(disposeCallbacks);

    await micaTools.execute('todo_write', { todos: [{ content: 'Test', status: 'pending' }] });
    await harness.commands.execute('/todo clear');
    expect(harness.showMessage).toHaveBeenCalledWith('Todo list cleared.');

    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith('Todo list is empty.');
  });

  it('drops the previous plan when a new turn starts', async () => {
    const harness = createTodoHarness(disposeCallbacks);

    await micaTools.execute('todo_write', { todos: [{ content: 'Old plan', status: 'pending' }] });
    await harness.hooks.emit('turn:after', {
      input: micaRuntime.createRuntimeInput('done', 'ui'),
      elapsedMs: 10,
      hasError: false,
      outcome: 'completed',
    });

    // 回归点：新一轮开始而模型没写计划时，屏幕上不能还挂着上一轮的计划。
    await harness.hooks.emit('turn:before', {
      runtime: {},
      input: micaRuntime.createRuntimeInput('unrelated question', 'ui'),
    });

    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith('Todo list is empty.');
  });

  it('keeps the plan readable through /todo show after the turn ended', async () => {
    const harness = createTodoHarness(disposeCallbacks);

    await micaTools.execute('todo_write', {
      todos: [
        { content: 'Done', status: 'completed' },
        { content: 'Left over', status: 'in_progress' },
      ],
    });
    await harness.hooks.emit('turn:after', {
      input: micaRuntime.createRuntimeInput('done', 'ui'),
      elapsedMs: 10,
      hasError: false,
      outcome: 'completed',
    });

    // 面板收起后仍能手动查看，且不会把 in_progress 报成已完成。
    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith(
      ['TODO 清单已更新：1/2 完成，剩 1 项。', '- [ ] Left over'].join('\n'),
    );
  });

  it('isolates plans, tool writes, and turn lifecycle by opaque owner across session switches', async () => {
    const harness = createTodoHarness(disposeCallbacks, true);
    const ownerA = {};
    const ownerB = {};
    harness.setOwner(ownerA);
    await micaTools.execute('todo_write', { todos: [{ content: 'A plan', status: 'in_progress' }] });

    // 后台 B 的事件即使在 A 被选中时到达，也只能影响 B。
    await harness.hooks.emit('turn:before', {
      owner: ownerB,
      runtime: {},
      input: micaRuntime.createRuntimeInput('B starts', 'ui'),
    });
    harness.events.publish({ type: 'session:cleared', owner: ownerB });
    harness.events.publish({ type: 'session:invalidated', reason: 'resume', owner: ownerB });
    await harness.hooks.emit('turn:after', {
      owner: ownerB,
      input: micaRuntime.createRuntimeInput('B ends', 'ui'),
      elapsedMs: 10,
      hasError: false,
      outcome: 'completed',
    });
    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith('TODO 清单已更新：0/1 完成，剩 1 项。\n- [>] A plan');

    // 工具归属来自 callbacks.context，不能取当前界面的 A。
    const callbacks = { context: harness.contextFor(ownerB) } as ToolExecuteCallbacks;
    await micaTools.execute('todo_write', { todos: [{ content: 'B plan', status: 'in_progress' }] }, callbacks);
    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith('TODO 清单已更新：0/1 完成，剩 1 项。\n- [>] A plan');
    harness.setOwner(ownerB);
    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith('TODO 清单已更新：0/1 完成，剩 1 项。\n- [>] B plan');

    await harness.commands.execute('/todo clear');
    harness.setOwner(ownerA);
    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith('TODO 清单已更新：0/1 完成，剩 1 项。\n- [>] A plan');
  });

  it('renders the selected owner with independent visibility and idle in-progress projection', async () => {
    vi.spyOn(micaUi, 'useScheduleState').mockImplementation((store) => store.get());
    const harness = createTodoHarness(disposeCallbacks, true);
    const render = harness.upsert.mock.calls[0]?.[0].component as () => unknown;
    const expectItem = (content: string, status: string) => {
      expect(render()).toMatchObject({
        props: { children: [expect.anything(), [{ props: { item: { content, status } } }]] },
      });
    };
    const ownerA = {};
    const ownerB = {};
    harness.setOwner(ownerA);
    await micaTools.execute('todo_write', { todos: [{ content: 'A plan', status: 'in_progress' }] });
    expectItem('A plan', 'in_progress');
    harness.setOwner(ownerB);
    await micaTools.execute('todo_write', { todos: [{ content: 'B plan', status: 'in_progress' }] });
    expectItem('B plan', 'in_progress');
    await harness.commands.execute('/todo hide');
    expect(render()).toBeNull();

    harness.setOwner(ownerA);
    expectItem('A plan', 'in_progress');
    await harness.hooks.emit('turn:after', {
      owner: ownerA,
      input: micaRuntime.createRuntimeInput('A ends', 'ui'),
      elapsedMs: 10,
      hasError: false,
      outcome: 'completed',
    });
    expect(render()).toBeNull();
    await harness.commands.execute('/todo show');
    expectItem('A plan', 'pending');
    await harness.hooks.emit('turn:before', {
      owner: ownerA,
      runtime: {},
      input: micaRuntime.createRuntimeInput('A starts again', 'ui'),
    });
    expect(render()).toBeNull();

    harness.setOwner(ownerB);
    expect(render()).toBeNull();
    await harness.commands.execute('/todo show');
    expectItem('B plan', 'in_progress');
  });

  it('uses the current owner for unscoped events and releases only a disposed owner', async () => {
    const harness = createTodoHarness(disposeCallbacks, true);
    const ownerA = {};
    const ownerB = {};
    harness.setOwner(ownerA);
    await micaTools.execute('todo_write', { todos: [{ content: 'A plan', status: 'in_progress' }] });
    harness.setOwner(ownerB);
    await micaTools.execute('todo_write', { todos: [{ content: 'B plan', status: 'in_progress' }] });
    await harness.hooks.emit('turn:after', {
      input: micaRuntime.createRuntimeInput('B ends', 'ui'),
      elapsedMs: 10,
      hasError: false,
      outcome: 'completed',
    });
    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith('TODO 清单已更新：0/1 完成，剩 1 项。\n- [ ] B plan');

    harness.events.publish({ type: 'session:disposed', owner: ownerA });
    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith('TODO 清单已更新：0/1 完成，剩 1 项。\n- [ ] B plan');
    harness.setOwner(ownerA);
    await harness.commands.execute('/todo show');
    expect(harness.showMessage).toHaveBeenLastCalledWith('Todo list is empty.');
  });
});

function createTodoHarness(disposeCallbacks: Array<() => void | Promise<void>>, withOwners = false) {
  const commands = new micaCommands.CommandRegistry();
  const hooks = new micaPlugin.HookRegistry();
  const events = new micaRuntime.RuntimeEventBus();
  const promptSections = new micaPlugin.PluginPromptSections();
  const showMessage = vi.fn();
  const upsert = vi.fn<(item: PluginStatusItem) => void>();
  const remove = vi.fn<(id: string) => boolean>(() => true);
  const registerTool = vi.fn((tool: MicaTool) => {
    micaTools.registerRuntime(tool);
    return { dispose: () => micaTools.unregisterRuntime(tool) };
  });
  let currentOwner: unknown;
  const contextOwners = new Map<unknown, unknown>();
  const ctx = {
    pluginId: 'todo',
    commands,
    hooks,
    events,
    session: withOwners ? { captureOwner: (context?: unknown) => contextOwners.get(context) ?? currentOwner } : undefined,
    tools: { register: registerTool },
    prompt: { section: (section: PluginPromptSection) => promptSections.add('todo', section) },
    ui: { submit: vi.fn(), showMessage, status: { upsert, remove } },
    onDispose: (dispose: () => void | Promise<void>) => disposeCallbacks.push(dispose),
  } as unknown as PluginContext;

  new TodoPlugin().setup(ctx);
  return {
    commands,
    events,
    hooks,
    promptSections,
    registerTool,
    remove,
    showMessage,
    upsert,
    setOwner(owner: unknown) {
      currentOwner = owner;
    },
    contextFor(owner: unknown) {
      const context = {};
      contextOwners.set(context, owner);
      return context;
    },
  };
}
