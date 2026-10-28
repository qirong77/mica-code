import { describe, expect, it } from 'vitest';
import {
  MAX_TODOS,
  formatTodoSummary,
  parseTodoInput,
  projectTodoSnapshot,
  resolveTodoPanel,
  summarizeTodoProgress,
  type TodoItem,
} from './todoState.js';

describe('parseTodoInput', () => {
  it('normalizes a valid list and keeps the active form optional', () => {
    const parsed = parseTodoInput({
      todos: [
        { content: '  Run   tests  ', activeForm: ' Running tests ', status: 'in_progress' },
        { content: 'Update docs', status: 'pending' },
      ],
    });

    expect(parsed).toEqual({
      ok: true,
      notes: [],
      items: [
        { id: 'Run tests', content: 'Run tests', activeForm: 'Running tests', status: 'in_progress' },
        { id: 'Update docs', content: 'Update docs', activeForm: undefined, status: 'pending' },
      ],
    });
  });

  it('demotes extra in-progress items instead of rejecting the call', () => {
    const parsed = parseTodoInput({
      todos: [
        { content: 'One', status: 'in_progress' },
        { content: 'Two', status: 'in_progress' },
        { content: 'Three', status: 'in_progress' },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items.map((item) => item.status)).toEqual(['in_progress', 'pending', 'pending']);
    expect(parsed.notes).toEqual(['同时只保留一项 in_progress，其余 2 项已按 pending 处理']);
  });

  it('ignores unknown fields, blank content and illegal status', () => {
    const parsed = parseTodoInput({
      todos: [
        { content: '   ', status: 'pending' },
        { content: 'Real task', status: 'bogus', priority: 'high' },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].status).toBe('pending');
    expect(parsed.notes).toContain('todos[0] 缺少 content，已忽略');
    expect(parsed.notes).toContain('todos[1].status 不合法，已按 pending 处理');
  });

  it('truncates instead of failing when the list is too long', () => {
    const todos = Array.from({ length: MAX_TODOS + 3 }, (_, index) => ({
      content: `Step ${index}`,
      status: 'pending',
    }));
    const parsed = parseTodoInput({ todos });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items).toHaveLength(MAX_TODOS);
    expect(parsed.notes).toEqual([`清单超过 ${MAX_TODOS} 项，后 3 项已忽略`]);
  });

  it('derives unique ids from content and honours an explicit one', () => {
    const parsed = parseTodoInput({
      todos: [
        { content: 'Same', status: 'pending' },
        { content: 'Same', status: 'pending' },
        { id: 'custom', content: 'Other', status: 'pending' },
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.items.map((item) => item.id)).toEqual(['Same', 'Same#2', 'custom']);
  });

  it('only fails when the input is not a todo list at all', () => {
    expect(parseTodoInput({})).toEqual({ ok: false, message: 'todo_write 需要 todos 数组' });
    expect(parseTodoInput({ todos: 'nope' })).toEqual({ ok: false, message: 'todo_write 需要 todos 数组' });
    expect(parseTodoInput(null)).toEqual({ ok: false, message: 'todo_write 需要对象入参' });
  });
});

describe('summarizeTodoProgress', () => {
  it('counts completed and picks the active item', () => {
    const progress = summarizeTodoProgress([
      { id: 'a', content: 'A', status: 'completed' },
      { id: 'b', content: 'B', status: 'in_progress' },
      { id: 'c', content: 'C', status: 'pending' },
    ]);

    expect(progress).toEqual({ total: 3, completed: 1, remaining: 2, active: expect.objectContaining({ id: 'b' }) });
  });
});

describe('resolveTodoPanel', () => {
  const items: TodoItem[] = [
    { id: 'a', content: 'A', status: 'completed' },
    { id: 'b', content: 'B', activeForm: 'Doing B', status: 'in_progress' },
    { id: 'c', content: 'C', status: 'pending' },
  ];

  it('shows the list untouched while its turn is running', () => {
    expect(resolveTodoPanel({ items, turnId: 'turn-1' }, { running: true, open: true, turnId: 'turn-1' })).toEqual({
      items,
      visible: true,
    });
  });

  it('hides the list once its turn ends and nobody reopens it', () => {
    // 回归点：turn 结束后不能再把上一轮的计划留在屏幕上。
    expect(resolveTodoPanel({ items, turnId: 'turn-1' }, { running: false, open: false, turnId: 'turn-1' })).toEqual({
      items: [],
      visible: false,
    });
  });

  it('hides a stale snapshot from an earlier turn even while the next one runs', () => {
    // 回归点：新的一轮开始时，历史里上一轮的 todo_write 不得重新冒出来。
    expect(resolveTodoPanel({ items, turnId: 'turn-1' }, { running: true, open: true, turnId: 'turn-2' })).toEqual({
      items: [],
      visible: false,
    });
  });

  it('only needs the running flag when the caller owns a single list', () => {
    expect(resolveTodoPanel({ items, turnId: null }, { running: true, open: true }).visible).toBe(true);
    expect(resolveTodoPanel({ items, turnId: null }, { running: false, open: false }).visible).toBe(false);
  });

  it('hides empty lists and respects the hidden flag', () => {
    expect(
      resolveTodoPanel({ items: [], turnId: 'turn-1' }, { running: true, open: true, turnId: 'turn-1' }).visible,
    ).toBe(false);
    expect(
      resolveTodoPanel({ items, turnId: 'turn-1' }, { running: true, open: true, turnId: 'turn-1', hidden: true })
        .visible,
    ).toBe(false);
  });

  it('keeps a fully completed list visible while the turn still runs', () => {
    const done: TodoItem[] = [{ id: 'a', content: 'A', status: 'completed' }];
    expect(
      resolveTodoPanel({ items: done, turnId: 'turn-1' }, { running: true, open: true, turnId: 'turn-1' }).visible,
    ).toBe(true);
  });

  it('pauses in-progress items when the panel is opened outside a turn', () => {
    // `/todo show` 打开的是刚结束那一轮：条目可以看，但不能假装还在跑。
    const panel = resolveTodoPanel({ items, turnId: 'turn-1' }, { running: false, open: true, turnId: 'turn-1' });
    expect(panel.visible).toBe(true);
    expect(panel.items.map((item) => item.status)).toEqual(['completed', 'pending', 'pending']);
  });
});

describe('projectTodoSnapshot', () => {
  it('uses the last parsable record', () => {
    const snapshot = projectTodoSnapshot([
      { input: { todos: [{ content: 'Old', status: 'pending' }] }, turnId: 'turn-1' },
      { input: { todos: [{ content: 'New', status: 'in_progress' }] }, turnId: 'turn-2' },
      { input: { todos: 'broken' }, turnId: 'turn-3' },
    ]);

    expect(snapshot.turnId).toBe('turn-2');
    expect(snapshot.items.map((item) => item.content)).toEqual(['New']);
  });

  it('returns an empty snapshot when nothing parses', () => {
    expect(projectTodoSnapshot([{ input: null }])).toEqual({ items: [], turnId: null });
  });
});

describe('formatTodoSummary', () => {
  it('lists only the remaining items', () => {
    const summary = formatTodoSummary([
      { id: 'a', content: 'Done thing', status: 'completed' },
      { id: 'b', content: 'Run tests', status: 'in_progress' },
      { id: 'c', content: 'Update docs', status: 'pending' },
    ]);

    expect(summary).toBe(['TODO 清单已更新：1/3 完成，剩 2 项。', '- [>] Run tests', '- [ ] Update docs'].join('\n'));
  });

  it('reports completion without listing items', () => {
    expect(formatTodoSummary([{ id: 'a', content: 'A', status: 'completed' }])).toBe(
      'TODO 清单已更新：1/1 完成。全部结束。',
    );
    expect(formatTodoSummary([])).toBe('TODO 清单已清空。');
  });
});
