import { describe, expect, it } from 'vitest';
import {
  PluginPanelRegistry,
  normalizePluginPanelAction,
  normalizePluginPanelActionResult,
  normalizePluginPanelView,
} from './PluginPanel.js';

describe('normalizePluginPanelView', () => {
  it('keeps rows, items, fields and actions', () => {
    const view = normalizePluginPanelView({
      title: '需求开发',
      subtitle: '角色：需求开发',
      status: { label: '轮询中', tone: 'ok' },
      sections: [
        {
          title: '频道',
          rows: [{ label: '上次检查', value: '2026-10-01 10:00:00' }],
          items: [{ key: 'group:A', label: '群 A', value: '群 · 未读', actions: [{ id: 'remove', label: '删除' }] }],
          fields: [{ key: 'target', label: '群名', type: 'number', value: '5' }],
          actions: [{ id: 'add', label: '添加', tone: 'primary' }],
        },
      ],
    });
    expect(view.title).toBe('需求开发');
    expect(view.status).toEqual({ label: '轮询中', tone: 'ok' });
    expect(view.sections?.[0].items?.[0].actions?.[0].id).toBe('remove');
    expect(view.sections?.[0].fields?.[0].type).toBe('number');
    expect(view.sections?.[0].actions?.[0].tone).toBe('primary');
  });

  it('keeps the auto-commit action only when the section has fields', () => {
    const view = normalizePluginPanelView({
      title: 'x',
      sections: [
        { title: '设置', fields: [{ key: 'n', label: '每多少轮' }], commit: 'settings.save' },
        { title: '动作', actions: [{ id: 'go', label: '执行' }], commit: 'ignored' },
      ],
    });
    expect(view.sections?.[0].commit).toBe('settings.save');
    expect(view.sections?.[1].commit).toBeUndefined();
  });

  it('falls back to the plugin name and drops malformed entries', () => {
    const view = normalizePluginPanelView(
      {
        title: '   ',
        status: { label: '', tone: 'nope' },
        sections: [
          { rows: [{ label: '' }], items: [{ key: '', label: 'x' }], fields: [{ key: 'k' }], actions: [{ id: '' }] },
          { title: '只有标题' },
        ],
      },
      '需求开发',
    );
    expect(view.title).toBe('需求开发');
    expect(view.status).toBeUndefined();
    expect(view.sections).toEqual([{ title: '只有标题' }]);
  });

  it('truncates long text and caps lists', () => {
    const longText = 'x'.repeat(1000);
    const view = normalizePluginPanelView({
      title: 'T',
      sections: [
        {
          title: 'S',
          rows: Array.from({ length: 100 }, () => ({ label: 'l', value: longText })),
          actions: Array.from({ length: 20 }, (_, index) => ({ id: `a${index}`, label: 'b' })),
        },
      ],
    });
    expect(view.sections?.[0].rows?.length).toBe(40);
    expect(view.sections?.[0].actions?.length).toBe(8);
    expect(view.sections?.[0].rows?.[0].value?.endsWith('…')).toBe(true);
  });

  it('survives non-object input', () => {
    expect(normalizePluginPanelView(null, '插件').title).toBe('插件');
    expect(normalizePluginPanelView('nope', '插件').sections).toBeUndefined();
  });
});

describe('normalizePluginPanelAction', () => {
  it('keeps the one-line answer an action can give', () => {
    expect(normalizePluginPanelActionResult({ message: '  先添加频道  ' })).toEqual({
      message: '先添加频道',
    });
  });

  it('treats anything else as "said nothing"', () => {
    expect(normalizePluginPanelActionResult(undefined)).toEqual({});
    expect(normalizePluginPanelActionResult({ message: 42 })).toEqual({});
    expect(normalizePluginPanelActionResult({ message: 'x'.repeat(300) }).message?.length).toBe(120);
  });

  it('carries text meant for the composer without sending it', () => {
    expect(normalizePluginPanelActionResult({ compose: '  看一眼群消息  ' })).toEqual({
      compose: '看一眼群消息',
    });
    expect(normalizePluginPanelActionResult({ compose: '   ' })).toEqual({});
  });

  it('carries a new-session task and defaults to asking first', () => {
    expect(normalizePluginPanelActionResult({ newSession: { prompt: '复盘' } })).toEqual({
      newSession: { prompt: '复盘' },
    });
    expect(
      normalizePluginPanelActionResult({
        newSession: { prompt: '复盘', role: ' 需求开发 ', cwd: '/tmp/w', confirm: false },
      }),
    ).toEqual({ newSession: { prompt: '复盘', role: '需求开发', cwd: '/tmp/w', confirm: false } });
  });

  it('drops a new-session task without a prompt', () => {
    expect(normalizePluginPanelActionResult({ newSession: { role: '需求开发' } })).toEqual({});
    expect(normalizePluginPanelActionResult({ newSession: { prompt: '   ' } })).toEqual({});
    expect(normalizePluginPanelActionResult({ newSession: '复盘' })).toEqual({});
  });

  it('keeps a dialog table with its columns, cells and links', () => {
    const result = normalizePluginPanelActionResult({
      dialog: {
        title: '需求环境',
        subtitle: '这个会话',
        columns: ['类型', '链接'],
        rows: [
          ['PRD', { text: 'https://a/prd', link: 'https://a/prd' }],
          [{ text: '未填写', tone: 'muted' }, ''],
        ],
        note: '在面板里填写',
      },
    });
    expect(result.dialog).toEqual({
      title: '需求环境',
      columns: ['类型', '链接'],
      rows: [
        [{ text: 'PRD' }, { text: 'https://a/prd', link: 'https://a/prd' }],
        [{ text: '未填写', tone: 'muted' }, { text: '' }],
      ],
      subtitle: '这个会话',
      note: '在面板里填写',
    });
  });

  it('drops a dialog without a title, body or columns', () => {
    expect(normalizePluginPanelActionResult({ dialog: { rows: [['a']] } })).toEqual({});
    expect(normalizePluginPanelActionResult({ dialog: { title: '表', columns: [], rows: [] } })).toEqual({});
    expect(normalizePluginPanelActionResult({ dialog: 'PRD' })).toEqual({});
  });

  it('keeps a prose-only dialog without a table', () => {
    const result = normalizePluginPanelActionResult({
      dialog: { title: '需求描述', text: '这个需求是给客服加一个入口。\n改完之后新建单据更快。' },
    });
    expect(result.dialog).toEqual({
      title: '需求描述',
      columns: [],
      rows: [],
      text: '这个需求是给客服加一个入口。\n改完之后新建单据更快。',
    });
  });

  it('trims cells to the column count and drops empty rows', () => {
    const result = normalizePluginPanelActionResult({
      dialog: {
        title: '表',
        columns: ['A', 'B'],
        rows: [['1', '2', '多余'], ['', ''], 'not-a-row', ['只有一格']],
      },
    });
    expect(result.dialog?.rows).toEqual([
      [{ text: '1' }, { text: '2' }],
      [{ text: '只有一格' }, { text: '' }],
    ]);
  });

  it('keeps action, key and string values only', () => {
    const action = normalizePluginPanelAction({ action: 'channel.add', key: 12, values: { a: 'x', b: 3, c: '  y  ' } });
    expect(action).toEqual({ action: 'channel.add', values: { a: 'x', c: 'y' } });
  });

  it('rejects a missing action id', () => {
    expect(normalizePluginPanelAction({})).toBeNull();
    expect(normalizePluginPanelAction({ action: '  ' })).toBeNull();
  });
});

describe('plugin panel openPath', () => {
  it('carries an absolute path and an optional line', () => {
    const result = normalizePluginPanelActionResult({
      openPath: { path: '/Users/me/.mica/plugins/demand-dev/skills/x/SKILL.md', line: 12.7 },
    });
    expect(result.openPath).toEqual({
      path: '/Users/me/.mica/plugins/demand-dev/skills/x/SKILL.md',
      line: 12,
    });
  });

  it('accepts a bare string and drops a path-less object', () => {
    expect(normalizePluginPanelActionResult({ openPath: '/tmp/a.md' }).openPath).toEqual({
      path: '/tmp/a.md',
    });
    expect(normalizePluginPanelActionResult({ openPath: { line: 3 } }).openPath).toBeUndefined();
    expect(normalizePluginPanelActionResult({ openPath: '   ' }).openPath).toBeUndefined();
  });

  it('carries focus only when the plugin explicitly asks for it', () => {
    expect(
      normalizePluginPanelActionResult({ openPath: { path: '/tmp/a.md', focus: true } }).openPath
    ).toEqual({ path: '/tmp/a.md', focus: true });
    // 只认真正的 true：字符串 "true"、1 这类都不能让宿主悄悄切到「只开编辑器」
    expect(
      normalizePluginPanelActionResult({ openPath: { path: '/tmp/a.md', focus: 'true' } }).openPath
    ).toEqual({ path: '/tmp/a.md' });
    expect(
      normalizePluginPanelActionResult({ openPath: { path: '/tmp/a.md', focus: false } }).openPath
    ).toEqual({ path: '/tmp/a.md' });
  });
});

describe('PluginPanelRegistry', () => {
  it('registers one panel per plugin and replaces on re-register', () => {
    const registry = new PluginPanelRegistry();
    const first = { view: () => ({ title: 'a' }), action: () => {} };
    const second = { view: () => ({ title: 'b' }), action: () => {} };
    registry.add('p', first);
    const registration = registry.add('p', second);
    expect(registry.get('p')).toBe(second);
    expect(registry.ids()).toEqual(['p']);
    registration.dispose();
    expect(registry.get('p')).toBeNull();
  });

  it('dispose of a replaced handler does not remove the replacement', () => {
    const registry = new PluginPanelRegistry();
    const first = registry.add('p', { view: () => ({ title: 'a' }), action: () => {} });
    registry.add('p', { view: () => ({ title: 'b' }), action: () => {} });
    first.dispose();
    expect(registry.get('p')).not.toBeNull();
  });
});
