import { describe, expect, it } from 'vitest';
import { QUICK_BUTTON_LIMIT, readQuickButtons, type QuickButton } from './buttons.js';
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
    expect(text).toContain('显示在输入框上方');
    expect(text).toContain('打开需求单 · 打开网页');
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
