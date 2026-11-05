import { describe, expect, it, vi } from 'vitest';
import type {
  PluginPanelActionInput,
  PluginPanelActionResult,
  PluginPanelHandler,
  PluginPanelView,
  PluginPanelViewInput,
} from '@packages/mica-plugin/index.js';
import { replaceQuickButtons, type QuickButton } from './buttons.js';
import {
  ADD_ACTION,
  CLEAR_ACTION,
  DIALOG_ACTION,
  REMOVE_ACTION,
  RUN_ACTION,
  absolutePath,
  createPanelHandler,
} from './panel.js';

/** 宿主接口允许 `view` / `action` 返回 Promise，测试里统一按同步值用。 */
type Handler = {
  view(input: PluginPanelViewInput): PluginPanelView;
  action(input: PluginPanelActionInput): Promise<PluginPanelActionResult>;
};

function harness(initial: QuickButton[] = [], options: { cwd?: string; browser?: 'ok' | 'fail' } = {}) {
  let buttons = initial;
  const openBrowser = vi.fn(async () =>
    options.browser === 'fail' ? { ok: false as const, error: '受控浏览器不可用' } : { ok: true as const },
  );
  const raw: PluginPanelHandler = createPanelHandler({
    read: () => buttons,
    write: (next) => {
      buttons = next;
    },
    cwd: () => options.cwd,
    openBrowser: openBrowser as never,
  });
  const handler: Handler = {
    view: (input) => raw.view(input) as PluginPanelView,
    action: async (input) => (await raw.action(input)) || {},
  };
  return { handler, openBrowser, buttons: () => buttons };
}

/** 动作的回包里可能有那句话，也可能什么都没回。 */
function messageOf(result: PluginPanelActionResult): string {
  return String(result.message || '');
}

describe('快捷按钮面板 view', () => {
  it('hands the row to the quick bar and lists it for editing', () => {
    const { handler } = harness(
      replaceQuickButtons([
        { id: 'doc', label: '打开需求单', kind: 'open', url: 'https://example.com/1' },
        { id: 'ask', label: '追问', kind: 'compose', text: '再查一下日志' },
      ]),
    );
    const view = handler.view({ role: 'default' });

    // 输入框上方那一排：id 同时是点击时回传的 key
    expect(view.shortcuts).toEqual([
      { id: 'doc', label: '打开需求单', action: RUN_ACTION, key: 'doc' },
      { id: 'ask', label: '追问', action: RUN_ACTION, key: 'ask' },
    ]);
    expect(view.subtitle).toContain('2 个按钮');
    const list = view.sections?.[0];
    expect(list?.items?.map((item) => item.label)).toEqual(['打开需求单', '追问']);
    expect(list?.items?.[0].value).toBe('打开网页 · https://example.com/1（受控浏览器）');
    expect(list?.items?.[0].actions?.[0].id).toBe(REMOVE_ACTION);
  });

  it('gives an empty state and no buttons when the session has none', () => {
    const { handler } = harness();
    const view = handler.view({ role: 'default' });
    expect(view.shortcuts).toEqual([]);
    expect(view.sections?.[0].items).toEqual([]);
    expect(view.sections?.[0].empty).toContain('让模型建一个');
    // 空的时候不画「清空」：一个只会回「本来就没有」的按钮
    expect(view.sections?.[0].actions).toBeUndefined();
  });

  it('always offers the manual form, with relative paths resolved against the session', () => {
    const { handler } = harness([], { cwd: '/Users/me/project' });
    const form = handler.view({ role: 'default' }).sections?.[1];
    expect(form?.fields?.map((field) => field.key)).toEqual(['label', 'kind', 'value']);
    expect(form?.fields?.[2].action?.id).toBe(ADD_ACTION);
    expect(form?.fields?.[2].hint).toContain('/Users/me/project');
  });
});

describe('快捷按钮面板动作', () => {
  it('opens a page in the controlled browser', async () => {
    const { handler, openBrowser } = harness(
      replaceQuickButtons([{ id: 'doc', label: '打开需求单', kind: 'open', url: 'https://example.com/1' }]),
    );
    const result = await handler.action({ action: RUN_ACTION, key: 'doc' });
    expect(openBrowser).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://example.com/1', label: '打开需求单' }),
    );
    expect(result).toEqual({ message: '已在受控浏览器打开' });
  });

  it('falls back to the system browser when the controlled one is unavailable', async () => {
    const { handler } = harness(
      replaceQuickButtons([{ id: 'doc', label: '打开需求单', kind: 'open', url: 'https://example.com/1' }]),
      { browser: 'fail' },
    );
    const result = await handler.action({ action: RUN_ACTION, key: 'doc' });
    expect(result).toMatchObject({ openExternal: 'https://example.com/1' });
    expect(result.message).toContain('系统浏览器');
  });

  it('never asks the browser for an explicit system-browser button', async () => {
    const { handler, openBrowser } = harness(
      replaceQuickButtons([
        { id: 'ext', label: '在 Chrome 里看', kind: 'open', url: 'https://a.com', target: 'external' },
      ]),
    );
    expect(await handler.action({ action: RUN_ACTION, key: 'ext' })).toEqual({
      openExternal: 'https://a.com',
    });
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it('translates the other kinds into what the host can do', async () => {
    const { handler } = harness(
      replaceQuickButtons([
        { id: 'ask', label: '追问', kind: 'compose', text: '再查一下日志' },
        { id: 'job', label: '跑测试', kind: 'session', text: '跑一遍单测', role: '需求开发' },
        { id: 'file', label: '看日志', kind: 'path', path: '/tmp/a.log' },
      ]),
    );
    expect(await handler.action({ action: RUN_ACTION, key: 'ask' })).toMatchObject({
      compose: '再查一下日志',
    });
    expect(await handler.action({ action: RUN_ACTION, key: 'job' })).toEqual({
      newSession: { prompt: '跑一遍单测', role: '需求开发' },
    });
    expect(await handler.action({ action: RUN_ACTION, key: 'file' })).toEqual({
      openPath: { path: '/tmp/a.log' },
    });
  });

  it('says so when the button is already gone or the action is unknown', async () => {
    const { handler } = harness();
    expect(await handler.action({ action: RUN_ACTION, key: 'nope' })).toEqual({
      message: '这个按钮已经删掉了',
    });
    expect(messageOf(await handler.action({ action: 'nope' }))).toContain('不认识');
  });

  it('adds one from the form and clears the drafts so the row is ready for the next', async () => {
    const harnessed = harness([], { cwd: '/Users/me/project' });
    const result = await harnessed.handler.action({
      action: ADD_ACTION,
      values: { label: '看日志', kind: 'path', value: 'logs/a.log' },
    });
    expect(result).toEqual({ message: '已添加「看日志」' });
    expect(harnessed.buttons()).toEqual([
      expect.objectContaining({ label: '看日志', kind: 'path', path: '/Users/me/project/logs/a.log' }),
    ]);
  });

  it('keeps the drafts when the form cannot be turned into a button', async () => {
    const harnessed = harness();
    expect(await harnessed.handler.action({ action: ADD_ACTION, values: { label: '', value: 'x' } })).toMatchObject({
      keepDrafts: true,
    });
    expect(await harnessed.handler.action({ action: ADD_ACTION, values: { label: 'x', value: '' } })).toMatchObject({
      keepDrafts: true,
    });
    expect(
      await harnessed.handler.action({ action: ADD_ACTION, values: { label: 'x', kind: 'open', value: 'not-a-url' } }),
    ).toMatchObject({ keepDrafts: true });
    expect(harnessed.buttons()).toEqual([]);
  });

  it('removes one and clears them all', async () => {
    const harnessed = harness(
      replaceQuickButtons([
        { id: 'a', label: 'A', kind: 'compose', text: 'a' },
        { id: 'b', label: 'B', kind: 'compose', text: 'b' },
      ]),
    );
    expect(await harnessed.handler.action({ action: REMOVE_ACTION, key: 'a' })).toEqual({ message: '已删除' });
    expect(harnessed.buttons().map((button) => button.id)).toEqual(['b']);
    expect(messageOf(await harnessed.handler.action({ action: CLEAR_ACTION }))).toContain('已清空');
    expect(harnessed.buttons()).toEqual([]);
    expect(messageOf(await harnessed.handler.action({ action: CLEAR_ACTION }))).toContain('本来就没有');
  });
});

describe('absolutePath', () => {
  it('keeps absolute paths and expands the home shorthand', () => {
    expect(absolutePath('/tmp/a', '/Users/me')).toBe('/tmp/a');
    expect(absolutePath('~/a.log', '/Users/me')).toMatch(/\/a\.log$/);
    expect(absolutePath('docs/a.md', '/Users/me/project')).toBe('/Users/me/project/docs/a.md');
  });
});

describe('按钮外观与弹窗', () => {
  it('把外观规格原样交给快捷条（颜色 / 图标由宿主按主题画）', () => {
    const { handler } = harness(
      replaceQuickButtons([
        {
          id: 'doc',
          label: '打开',
          kind: 'open',
          url: 'https://example.com/1',
          style: { icon: 'globe', color: 'accent', shape: 'soft' },
        },
      ]),
    );
    expect(handler.view({ role: 'default' }).shortcuts?.[0]).toEqual({
      id: 'doc',
      label: '打开',
      action: RUN_ACTION,
      key: 'doc',
      style: { icon: 'globe', color: 'accent', shape: 'soft' },
    });
  });

  it('弹窗按钮把内容翻成宿主那份 dialog（标题 / 两列表格 / 底部按钮）', async () => {
    const { handler } = harness(
      replaceQuickButtons([
        {
          id: 'pick',
          label: '看候选',
          kind: 'dialog',
          dialog: {
            title: '两条候选',
            subtitle: '按修改时间',
            markdown: '- 需求单 A\n- 需求单 B',
            items: [{ label: '需求单 A', value: '昨天', url: 'https://example.com/a' }],
            note: '选一个继续',
            actions: [
              { label: '打开 A', kind: 'open', url: 'https://example.com/a', target: 'external', tone: 'primary' },
              { label: '追问', kind: 'compose', text: '按 A 继续说' },
            ],
          },
        },
      ]),
    );
    const result = await handler.action({ action: RUN_ACTION, key: 'pick' });
    expect(result.dialog).toEqual({
      title: '两条候选',
      subtitle: '按修改时间',
      markdown: '- 需求单 A\n- 需求单 B',
      columns: ['名称', '内容'],
      rows: [[{ text: '需求单 A' }, { text: '昨天', link: 'https://example.com/a' }]],
      note: '选一个继续',
      actions: [
        { id: DIALOG_ACTION, key: 'pick:0', label: '打开 A', tone: 'primary' },
        { id: DIALOG_ACTION, key: 'pick:1', label: '追问' },
      ],
    });
  });

  it('点弹窗里的按钮时按坐标找回那一颗，并走同一套落点', async () => {
    const harnessed = harness(
      replaceQuickButtons([
        {
          id: 'pick',
          label: '看候选',
          kind: 'dialog',
          dialog: {
            title: '两条候选',
            text: '选一个',
            actions: [
              { label: '打开 A', kind: 'open', url: 'https://example.com/a', target: 'external' },
              { label: '追问', kind: 'compose', text: '按 A 继续说' },
            ],
          },
        },
      ]),
    );
    expect(await harnessed.handler.action({ action: DIALOG_ACTION, key: 'pick:0' })).toEqual({
      openExternal: 'https://example.com/a',
    });
    expect(await harnessed.handler.action({ action: DIALOG_ACTION, key: 'pick:1' })).toMatchObject({
      compose: '按 A 继续说',
    });
  });

  it('弹窗里的「打开」默认仍走受控浏览器', async () => {
    const harnessed = harness(
      replaceQuickButtons([
        {
          id: 'pick',
          label: '看候选',
          kind: 'dialog',
          dialog: {
            title: 'x',
            text: 'y',
            actions: [{ label: '打开', kind: 'open', url: 'https://example.com/b' }],
          },
        },
      ]),
    );
    await harnessed.handler.action({ action: DIALOG_ACTION, key: 'pick:0' });
    expect(harnessed.openBrowser).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com/b' }));
  });

  it('坐标过期时说清楚，而不是默默什么都不做', async () => {
    const { handler } = harness();
    expect(await handler.action({ action: DIALOG_ACTION, key: 'gone:0' })).toMatchObject({
      message: expect.stringContaining('不在弹窗里'),
    });
  });
});
