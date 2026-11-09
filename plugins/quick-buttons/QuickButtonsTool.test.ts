import { describe, expect, it, vi } from 'vitest';
import { QUICK_BUTTON_LIMIT, QUICK_BUTTON_STALE_MS, readQuickButtons, type QuickButton } from './buttons.js';
import { QUICK_BUTTONS_TOOL_NAME, QuickButtonsTool } from './QuickButtonsTool.js';

function harness(initial: QuickButton[] = [], options: { desktop?: boolean } = {}) {
  let buttons = initial;
  const tool = new QuickButtonsTool(
    {
      read: () => buttons,
      write: (next) => {
        buttons = next;
      },
    },
    { desktop: options.desktop ?? true },
  );
  return { tool, buttons: () => buttons };
}

describe('quick_buttons 工具', () => {
  it('timestamps model writes and preserves creation time on updates', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const { tool, buttons } = harness();
      await tool.execute({ operation: 'set', buttons: [{ id: 'a', label: 'A', kind: 'compose', text: 'a' }] });
      expect(buttons()[0]).toMatchObject({ source: 'model', createdAt: 1000, updatedAt: 1000 });
      clock.mockReturnValue(2000);
      await tool.execute({ operation: 'add', buttons: [{ id: 'a', label: 'B', kind: 'compose', text: 'b' }] });
      expect(buttons()[0]).toMatchObject({ source: 'model', createdAt: 1000, updatedAt: 2000 });
      clock.mockReturnValue(3000);
      await tool.execute({ operation: 'set', buttons: [{ id: 'a', label: 'C', kind: 'compose', text: 'c' }] });
      expect(buttons()[0]).toMatchObject({ source: 'model', createdAt: 1000, updatedAt: 3000 });
    } finally {
      clock.mockRestore();
    }
  });

  it('lists and explicitly clears only stale model buttons', async () => {
    const now = 2 * QUICK_BUTTON_STALE_MS;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const base = { label: 'A', kind: 'compose' as const, text: 'a' };
      const { tool, buttons } = harness([
        { ...base, id: 'old', source: 'model', updatedAt: now - QUICK_BUTTON_STALE_MS - 1 },
        { ...base, id: 'recent', source: 'model', updatedAt: now - QUICK_BUTTON_STALE_MS },
        { ...base, id: 'unknown', source: 'model' },
        { ...base, id: 'manual', updatedAt: 0 },
        { ...base, id: 'legacy' },
      ]);
      expect((await tool.execute({ operation: 'list' })).match(/可能过时/g)).toHaveLength(1);
      expect(buttons()).toHaveLength(5);
      expect(await tool.execute({ operation: 'clear_stale' })).toContain('已清理 1 个');
      expect(buttons().map((button) => button.id)).toEqual(['recent', 'unknown', 'manual', 'legacy']);
      expect(await tool.execute({ operation: 'clear_stale' })).toContain('已清理 0 个');
    } finally {
      clock.mockRestore();
    }
  });

  it('is a session-scoped tool with the expected name', () => {
    const { tool } = harness();
    expect(tool.name).toBe(QUICK_BUTTONS_TOOL_NAME);
    expect(tool.input_schema.required).toEqual(['operation']);
  });

  it('replaces the whole row on set and reports what is there now', async () => {
    const { tool, buttons } = harness();
    const text = await tool.execute({
      operation: 'set',
      buttons: [
        { label: '打开需求单', kind: 'open', url: 'https://example.com/1' },
        { label: '追问', kind: 'compose', text: '再查一下日志' },
      ],
    });
    expect(buttons().map((button) => button.id)).toEqual(['button-1', 'button-2']);
    expect(buttons().map((button) => button.style)).toEqual([{ color: 'accent' }, { color: 'accent' }]);
    expect(text).toContain('显示在输入框上方');
    expect(text).toContain('打开需求单 · 打开网页');
  });

  it('defaults set and add to accent while preserving explicit styles and action payloads', async () => {
    const { tool, buttons } = harness();
    const first = { id: 'ask', label: 'Ask', kind: 'compose', text: 'Continue' };
    const second = {
      id: 'report',
      label: 'Report',
      kind: 'path',
      path: '/tmp/report.md',
      style: { icon: 'file-text', shape: 'soft', iconOnly: true },
    };
    const third = {
      id: 'retry',
      label: 'Retry',
      kind: 'compose',
      text: 'Check again',
      style: { color: 'warn', shape: 'plain' },
    };
    await tool.execute({ operation: 'set', buttons: [first] });
    await tool.execute({ operation: 'add', buttons: [second, third] });
    expect(buttons()).toMatchObject([
      { ...first, style: { color: 'accent' } },
      { ...second, style: { ...second.style, color: 'accent' } },
      third,
    ]);
  });

  it('appends on add and updates in place when the id repeats', async () => {
    const { tool, buttons } = harness([{ id: 'say', label: '追问', kind: 'compose', text: 'a' }]);
    await tool.execute({ operation: 'add', buttons: [{ label: '看日志', kind: 'path', path: '/tmp/a.log' }] });
    expect(buttons()).toHaveLength(2);

    await tool.execute({
      operation: 'add',
      buttons: [{ id: 'say', label: '换个说法', kind: 'compose', text: 'b' }],
    });
    expect(buttons()).toHaveLength(2);
    expect(buttons()[0]).toMatchObject({ id: 'say', label: '换个说法', text: 'b' });
  });

  it('removes by id and complains about an id that is not there', async () => {
    const { tool, buttons } = harness([{ id: 'say', label: '追问', kind: 'compose', text: 'a' }]);
    await tool.execute({ operation: 'remove', id: 'say' });
    expect(buttons()).toEqual([]);
    await expect(tool.execute({ operation: 'remove', id: 'say' })).rejects.toThrow(/没有 id/);
  });

  it('clears the row', async () => {
    const { tool, buttons } = harness([{ id: 'say', label: '追问', kind: 'compose', text: 'a' }]);
    const text = await tool.execute({ operation: 'clear' });
    expect(buttons()).toEqual([]);
    expect(text).toContain('已清空 1 个快捷按钮');
  });

  it('lists without touching anything', async () => {
    const { tool, buttons } = harness([{ id: 'say', label: '追问', kind: 'compose', text: 'a' }]);
    expect(await tool.execute({ operation: 'list' })).toContain('追问');
    expect(buttons()).toHaveLength(1);
  });

  it('speaks to the CLI instead of pretending there are buttons', async () => {
    const { tool } = harness([], { desktop: false });
    const text = await tool.execute({
      operation: 'set',
      buttons: [{ label: '打开需求单', kind: 'open', url: 'https://example.com/1' }],
    });
    expect(text).toContain('没有输入框上方的按钮');
    expect(text).toContain('https://example.com/1');
  });

  it('explains the limit instead of silently dropping the extra button', async () => {
    const { tool } = harness();
    const buttons = Array.from({ length: QUICK_BUTTON_LIMIT }, (_, index) => ({
      label: `B${index}`,
      kind: 'compose',
      text: 'x',
    }));
    await tool.execute({ operation: 'set', buttons });
    await expect(
      tool.execute({ operation: 'add', buttons: [{ label: '再来一个', kind: 'compose', text: 'y' }] }),
    ).rejects.toThrow(/最多/);
  });

  it('rejects an unknown operation and an empty button list', async () => {
    const { tool } = harness();
    await expect(tool.execute({ operation: 'rename' })).rejects.toThrow(/operation/);
    await expect(tool.execute({ operation: 'set', buttons: [] })).rejects.toThrow(/buttons/);
  });

  it('writes plain JSON that reads back through the same normalizer', async () => {
    const { tool, buttons } = harness();
    await tool.execute({
      operation: 'set',
      buttons: [{ label: '跑测试', kind: 'session', text: '跑一遍单测', role: '需求开发' }],
    });
    expect(readQuickButtons({ version: 1, buttons: buttons() })).toEqual(buttons());
  });
});
