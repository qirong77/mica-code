import { describe, expect, it } from 'vitest';
import {
  QUICK_BUTTON_LIMIT,
  QUICK_BUTTON_STALE_MS,
  formatQuickButtons,
  isStaleQuickButton,
  newButtonId,
  normalizeQuickButton,
  normalizeQuickButtonsState,
  removeQuickButton,
  replaceQuickButtons,
  upsertQuickButton,
  type QuickButton,
} from './buttons.js';

const open = (label = '打开需求单'): Record<string, unknown> => ({
  label,
  kind: 'open',
  url: 'https://example.com/demand/1',
});

describe('stale buttons', () => {
  const button: QuickButton = { id: 'a', label: 'A', kind: 'compose', text: 'a' };
  const now = 2 * QUICK_BUTTON_STALE_MS;

  it('requires model provenance and a valid update time beyond seven days', () => {
    expect(isStaleQuickButton({ ...button, source: 'model', updatedAt: now - QUICK_BUTTON_STALE_MS - 1 }, now)).toBe(
      true,
    );
    expect(isStaleQuickButton({ ...button, source: 'model', updatedAt: now - QUICK_BUTTON_STALE_MS }, now)).toBe(false);
    expect(isStaleQuickButton({ ...button, source: 'model' }, now)).toBe(false);
    expect(isStaleQuickButton({ ...button, updatedAt: 0 }, now)).toBe(false);
    expect(isStaleQuickButton({ ...button, source: 'model', updatedAt: NaN }, now)).toBe(false);
    expect(isStaleQuickButton({ ...button, source: 'model', updatedAt: now + 1 }, now)).toBe(false);
  });

  it('retains valid metadata and drops invalid timestamps', () => {
    expect(normalizeQuickButton({ ...button, source: 'model', createdAt: 1, updatedAt: 2 })).toMatchObject({
      source: 'model',
      createdAt: 1,
      updatedAt: 2,
    });
    expect(normalizeQuickButton({ ...button, source: 'model', createdAt: -1, updatedAt: 'bad' })).toEqual({
      ...button,
      source: 'model',
    });
  });
});

describe('normalizeQuickButton', () => {
  it('keeps each kind with its payload and fills the default target', () => {
    expect(normalizeQuickButton({ id: 'open-1', ...open() })).toEqual({
      id: 'open-1',
      label: '打开需求单',
      kind: 'open',
      url: 'https://example.com/demand/1',
      target: 'browser',
    });
    expect(
      normalizeQuickButton({
        id: 'open-2',
        label: '系统浏览器',
        kind: 'open',
        url: 'https://a.com',
        target: 'external',
      }),
    ).toMatchObject({ target: 'external' });
    expect(normalizeQuickButton({ id: 'say', label: '追问', kind: 'compose', text: '再查一下日志' })).toEqual({
      id: 'say',
      label: '追问',
      kind: 'compose',
      text: '再查一下日志',
    });
    expect(
      normalizeQuickButton({ id: 'job', label: '跑测试', kind: 'session', text: '跑一遍单测', role: '需求开发' }),
    ).toMatchObject({ role: '需求开发' });
    expect(normalizeQuickButton({ id: 'file', label: '看日志', kind: 'path', path: '/tmp/a.log' })).toEqual({
      id: 'file',
      label: '看日志',
      kind: 'path',
      path: '/tmp/a.log',
    });
  });

  it('rejects a button that would do nothing when clicked', () => {
    // 只认 http(s)：`javascript:` / `file:` 交给浏览器等于页面自己执行一段脚本
    expect(normalizeQuickButton({ id: 'x', label: 'x', kind: 'open', url: 'javascript:alert(1)' })).toBeNull();
    expect(normalizeQuickButton({ id: 'x', label: 'x', kind: 'open', url: 'file:///etc/passwd' })).toBeNull();
    expect(normalizeQuickButton({ id: 'x', label: 'x', kind: 'compose', text: '   ' })).toBeNull();
    expect(normalizeQuickButton({ id: 'x', label: 'x', kind: 'path' })).toBeNull();
    expect(normalizeQuickButton({ id: 'x', label: 'x', kind: 'shell' })).toBeNull();
    // id 同时是页面上的 key 与点击时回传的 key
    expect(normalizeQuickButton({ id: 'Bad Id', label: 'x', kind: 'compose', text: 'a' })).toBeNull();
    expect(normalizeQuickButton({ id: 'ok', label: '   ', kind: 'compose', text: 'a' })).toBeNull();
  });

  it('trims long labels to what fits in a button', () => {
    const button = normalizeQuickButton({ id: 'ok', label: '打'.repeat(30), kind: 'compose', text: 'a' });
    expect(button?.label).toHaveLength(12);
  });
});

describe('normalizeQuickButtonsState', () => {
  it('reads the stored row and drops entries that cannot be rendered', () => {
    const state = normalizeQuickButtonsState({
      version: 99,
      buttons: [
        { id: 'a', ...open('A') },
        { id: 'a', label: '重复', kind: 'open', url: 'https://b.com' },
        { id: 'b', label: '坏的', kind: 'open', url: 'not-a-url' },
        'nope',
        { id: 'c', label: 'C', kind: 'path', path: '/tmp/c' },
      ],
    });
    expect(state.version).toBe(1);
    expect(state.buttons.map((button) => button.id)).toEqual(['a', 'c']);
  });

  it('tolerates a missing or foreign state', () => {
    expect(normalizeQuickButtonsState(undefined).buttons).toEqual([]);
    expect(normalizeQuickButtonsState('nope').buttons).toEqual([]);
    expect(normalizeQuickButtonsState({ buttons: 'nope' }).buttons).toEqual([]);
  });

  it('caps the row at the limit', () => {
    const buttons = Array.from({ length: QUICK_BUTTON_LIMIT + 3 }, (_, index) => ({
      id: `b${index}`,
      label: `B${index}`,
      kind: 'compose',
      text: 'x',
    }));
    expect(normalizeQuickButtonsState({ buttons }).buttons).toHaveLength(QUICK_BUTTON_LIMIT);
  });
});

describe('upsertQuickButton', () => {
  it('derives an id from the label, or falls back to a numbered one', () => {
    expect(newButtonId('Open Demand', new Set())).toBe('open-demand');
    expect(newButtonId('打开需求单', new Set())).toBe('button-1');
    expect(newButtonId('打开需求单', new Set(['button-1']))).toBe('button-2');
    // 同一句话建第二枚按钮：slug 撞了就往后排
    expect(newButtonId('Open Demand', new Set(['open-demand']))).toBe('open-demand-1');
  });

  it('appends, and replaces when the id already exists', () => {
    const first = upsertQuickButton([], { label: 'Open', kind: 'compose', text: '一句话' });
    expect(first.created).toBe(true);
    expect(first.buttons.map((button) => button.id)).toEqual(['open']);

    const second = upsertQuickButton(first.buttons, {
      id: 'open',
      label: '换掉',
      kind: 'compose',
      text: '另一句',
    });
    expect(second.created).toBe(false);
    expect(second.buttons).toHaveLength(1);
    expect(second.buttons[0]).toMatchObject({ id: 'open', label: '换掉', text: '另一句' });
  });

  it('refuses to grow past the limit but still allows updating in place', () => {
    let buttons: QuickButton[] = [];
    for (let index = 0; index < QUICK_BUTTON_LIMIT; index += 1) {
      buttons = upsertQuickButton(buttons, { label: `B${index}`, kind: 'compose', text: 'x' }).buttons;
    }
    expect(() => upsertQuickButton(buttons, { label: '再一个', kind: 'compose', text: 'x' })).toThrow(/最多/);
    expect(upsertQuickButton(buttons, { id: buttons[0].id, label: '改', kind: 'compose', text: 'y' }).created).toBe(
      false,
    );
  });

  it('rejects a malformed button with a message the model can act on', () => {
    expect(() => upsertQuickButton([], { label: 'x', kind: 'open' })).toThrow(/url/);
    expect(() => upsertQuickButton([], { label: 'x', kind: 'compose' })).toThrow(/text/);
    expect(() => upsertQuickButton([], { label: '', kind: 'compose', text: 'a' })).toThrow(/label/);
    expect(() => upsertQuickButton([], { label: 'x', kind: 'nope' })).toThrow(/kind/);
  });
});

describe('replaceQuickButtons / removeQuickButton', () => {
  it('replaces the whole row', () => {
    const next = replaceQuickButtons([{ label: 'A', kind: 'compose', text: 'a' }]);
    expect(next).toHaveLength(1);
  });

  it('rejects the whole batch when one entry is malformed', () => {
    // 半排落盘会让「模型说建了两个、页面只有一个」变成一次静默的部分失败
    expect(() => replaceQuickButtons([{ label: 'A', kind: 'compose', text: 'a' }, { label: 'B' }])).toThrow();
  });

  it('removes by id and leaves the rest alone', () => {
    const buttons = replaceQuickButtons([
      { id: 'a', label: 'A', kind: 'compose', text: 'a' },
      { id: 'b', label: 'B', kind: 'compose', text: 'b' },
    ]);
    expect(removeQuickButton(buttons, 'a').map((button) => button.id)).toEqual(['b']);
    expect(removeQuickButton(buttons, 'zzz')).toHaveLength(2);
  });
});

describe('formatQuickButtons', () => {
  const buttons = replaceQuickButtons([
    { id: 'open', label: '打开需求单', kind: 'open', url: 'https://example.com/1' },
    { id: 'ask', label: '追问', kind: 'compose', text: '再查一下\n日志' },
  ]);

  it('speaks of the row above the composer when the host has one', () => {
    const text = formatQuickButtons(buttons, { desktop: true });
    expect(text).toContain('显示在输入框上方');
    expect(text).toContain('打开需求单 · 打开网页 → https://example.com/1（受控浏览器）');
    // 一行一枚按钮：正文里的换行压成空格，否则工具结果会散成好几行
    expect(text).toContain('追问 · 放进输入框 → 再查一下 日志');
  });

  it('hands over the links themselves in a host without buttons', () => {
    const text = formatQuickButtons(buttons, { desktop: false });
    expect(text).toContain('没有输入框上方的按钮');
    expect(text).toContain('https://example.com/1');
  });

  it('says the row is empty instead of printing a dangling heading', () => {
    expect(formatQuickButtons([], { desktop: true })).toContain('没有快捷按钮');
    expect(formatQuickButtons([], { desktop: false })).toContain('没有快捷按钮');
  });
});

describe('按钮外观规格（style）', () => {
  const base = { id: 'open', label: '打开', kind: 'open', url: 'https://example.com/1' };

  it('只保留枚举里的图标 / 颜色 / 形状，其余当没写', () => {
    expect(normalizeQuickButton({ ...base, style: { icon: 'globe', color: 'accent' } })).toMatchObject({
      style: { icon: 'globe', color: 'accent' },
    });
    expect(normalizeQuickButton({ ...base, style: { color: 'purple', shape: 'round' } })).toBeTruthy();
    // 认不出的值整份丢掉：宁可画默认按钮，也不要画一颗「看着像主操作」的普通按钮
    expect(normalizeQuickButton({ ...base, style: { color: 'purple' } })?.style).toBeUndefined();
    expect(normalizeQuickButton({ ...base, style: { shape: 'text' } })?.style).toBeUndefined();
    expect(normalizeQuickButton({ ...base, style: { iconOnly: false } })?.style).toBeUndefined();
  });

  it('keeps iconOnly only when there is an icon to draw', () => {
    expect(normalizeQuickButton({ ...base, style: { icon: 'external', iconOnly: true } })?.style).toEqual({
      icon: 'external',
      iconOnly: true,
    });
  });
});

describe('弹窗按钮（kind: dialog）', () => {
  const dialogButton = (dialog: unknown) =>
    normalizeQuickButton({ id: 'pick', label: '看候选', kind: 'dialog', dialog });

  it('keeps the content the host knows how to draw', () => {
    const button = dialogButton({
      title: '两条候选',
      text: '按修改时间排的',
      items: [{ label: '需求单 A', value: '昨天', url: 'https://example.com/a' }, { label: '需求单 B' }],
      actions: [
        { label: '打开 A', kind: 'open', url: 'https://example.com/a', tone: 'primary' },
        { label: '追问', kind: 'compose', text: '按 A 继续说' },
      ],
    });
    expect(button?.dialog).toEqual({
      title: '两条候选',
      text: '按修改时间排的',
      items: [{ label: '需求单 A', value: '昨天', url: 'https://example.com/a' }, { label: '需求单 B' }],
      actions: [
        { label: '打开 A', kind: 'open', url: 'https://example.com/a', target: 'browser', tone: 'primary' },
        { label: '追问', kind: 'compose', text: '按 A 继续说' },
      ],
    });
  });

  it('drops rows and buttons that could not do anything', () => {
    const button = dialogButton({
      title: '问一句',
      text: '内容',
      items: [{ label: '' }, { label: '好', url: 'javascript:alert(1)' }, { label: '保留' }],
      actions: [
        { label: '坏的', kind: 'open', url: 'nope' },
        { label: '套娃', kind: 'dialog', dialog: { title: 'x', text: 'y' } },
        { label: '好的', kind: 'path', path: '/tmp/a' },
      ],
    });
    expect(button?.dialog?.items).toEqual([{ label: '好' }, { label: '保留' }]);
    expect(button?.dialog?.actions).toEqual([{ label: '好的', kind: 'path', path: '/tmp/a' }]);
  });

  it('needs a title and at least one block of content', () => {
    expect(dialogButton({ text: '没有标题' })).toBeNull();
    expect(dialogButton({ title: '只有标题' })).toBeNull();
    expect(dialogButton({ title: '只有按钮', actions: [{ label: '看', kind: 'path', path: '/tmp/a' }] })).toBeTruthy();
  });

  it('prefers markdown over plain text when both are given', () => {
    const button = dialogButton({ title: 'x', text: '一段话', markdown: '- 一条' });
    expect(button?.dialog?.markdown).toBe('- 一条');
    expect(button?.dialog?.text).toBeUndefined();
  });

  it('summarises the popup in one line for the tool result', () => {
    const buttons = replaceQuickButtons([
      {
        label: '看候选',
        kind: 'dialog',
        dialog: {
          title: '两条候选',
          items: [{ label: 'A' }, { label: 'B' }],
          actions: [{ label: '打开 A', kind: 'path', path: '/tmp/a' }],
        },
      },
    ]);
    expect(formatQuickButtons(buttons, { desktop: true })).toContain('看候选 · 弹窗 → 两条候选 · 2 项 · 1 个按钮');
  });
});
