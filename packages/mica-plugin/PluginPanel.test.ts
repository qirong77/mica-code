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

  it('accepts a password field and drops unknown field types', () => {
    const view = normalizePluginPanelView({
      title: 'ssh',
      sections: [
        {
          title: '添加服务器',
          fields: [
            { key: 'password', label: '口令', type: 'password', value: '' },
            { key: 'alias', label: '别名', type: 'text', value: 'test' },
            { key: 'weird', label: '未知', type: 'secret', value: 'x' },
          ],
        },
      ],
    });
    expect(view.sections?.[0].fields?.map((field) => field.type ?? 'text')).toEqual(['password', 'text', 'text']);
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

  it('keeps a prose body and row-level wrap / link', () => {
    const view = normalizePluginPanelView({
      title: '需求开发',
      sections: [
        {
          title: '需求描述',
          subtitle: '评审只读提交，不动工作区',
          text: '一句话讲清这次要做什么。\n\n以及这次明确不做什么。',
          rows: [
            { label: '一句话', value: '一段很长的说明', wrap: true },
            { label: '测试环境', value: 'https://example.com/x', link: 'https://example.com/x' },
            { label: '状态', value: '就绪' },
          ],
        },
      ],
    });
    const section = view.sections?.[0];
    expect(section?.subtitle).toBe('评审只读提交，不动工作区');
    expect(section?.text).toContain('明确不做什么');
    expect(section?.rows?.[0].wrap).toBe(true);
    expect(section?.rows?.[1].link).toBe('https://example.com/x');
    // 没声明的一律不带：默认单行省略、默认不是链接。
    expect(section?.rows?.[2].wrap).toBeUndefined();
    expect(section?.rows?.[2].link).toBeUndefined();
  });

  it('一块只有正文的 section 也算有内容', () => {
    const view = normalizePluginPanelView({
      title: 'x',
      sections: [{ title: '结论', text: '这次改动只动了插件面板。' }, { text: '' }],
    });
    expect(view.sections).toHaveLength(1);
    expect(view.sections?.[0].text).toBe('这次改动只动了插件面板。');
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

  it('最多 12 块 section，多出来的截掉（有插件要用满 9 块）', () => {
    const view = normalizePluginPanelView({
      sections: Array.from({ length: 13 }, (_, i) => ({ title: `第 ${i + 1} 块` })),
    });
    expect(view.sections?.length).toBe(12);
    expect(view.sections?.at(-1)?.title).toBe('第 12 块');
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

  it('carries "只放进输入框" only when it is explicitly false', () => {
    expect(
      normalizePluginPanelActionResult({ newSession: { prompt: '去更新页面', send: false } }),
    ).toEqual({ newSession: { prompt: '去更新页面', send: false } });
    // 认不出的值退回默认（发送）：插件笔误不该让一段话默默躺在输入框里没人发现。
    expect(normalizePluginPanelActionResult({ newSession: { prompt: '复盘', send: 'no' } })).toEqual({
      newSession: { prompt: '复盘' },
    });
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

describe('normalizePluginPanelView shortcut states', () => {
  it('normalizes optional fields and rejects malformed entries', () => {
    const view = normalizePluginPanelView({ shortcutStates: {
      check: { badge: ' 运行中 ', disabled: true, disabledReason: ' 等待完成 ', extra: 1 },
      enabled: { disabled: false },
      invalid: { badge: 3, disabled: 'true', disabledReason: false },
      'bad key': { badge: 'x' },
      array: [],
    } });
    expect(view.shortcutStates).toEqual({
      check: { badge: '运行中', disabled: true, disabledReason: '等待完成' },
      enabled: { disabled: false },
    });
    expect(normalizePluginPanelView({ shortcutStates: [] }).shortcutStates).toBeUndefined();
  });

  it('limits state count and text length and handles special object keys', () => {
    const entries = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`id${i}`, { badge: 'x'.repeat(20), disabledReason: 'y'.repeat(210) }]));
    const states = normalizePluginPanelView({ shortcutStates: entries }).shortcutStates!;
    expect(Object.keys(states)).toHaveLength(40);
    expect(states.id0.badge).toBe(`${'x'.repeat(11)}…`);
    expect(states.id0.disabledReason).toBe(`${'y'.repeat(199)}…`);
    const special = normalizePluginPanelView({ shortcutStates: JSON.parse('{"__proto__":{"badge":"x"},"constructor":{"disabled":true}}') }).shortcutStates!;
    expect(Object.keys(special)).toEqual(['constructor']);
    expect(special.constructor).toEqual({ disabled: true });
  });
});

describe('normalizePluginPanelView menus', () => {
  it('keeps dynamic menu items with their action and key', () => {
    const view = normalizePluginPanelView({
      title: 'x',
      menus: {
        reviews: [
          { label: 'sass · demand-a', detail: 'diff master', action: 'review.open', key: 'w1' },
          { label: '没有动作' },
        ],
      },
    });
    expect(view.menus?.reviews).toEqual([
      { label: 'sass · demand-a', detail: 'diff master', action: 'review.open', key: 'w1' },
    ]);
  });

  it('drops menus that are not an object of arrays', () => {
    expect(normalizePluginPanelView({ title: 'x', menus: 'nope' }).menus).toBeUndefined();
    expect(normalizePluginPanelView({ title: 'x', menus: { a: 'nope' } }).menus).toBeUndefined();
  });
});

describe('normalizePluginPanelActionResult openReview', () => {
  it('keeps the repository, base, head and label', () => {
    const result = normalizePluginPanelActionResult({
      openReview: {
        cwd: '/tmp/wt/mica-code',
        base: 'main',
        head: 'demand-1102',
        label: 'mica · demand-1102',
      },
    });
    expect(result.openReview).toEqual({
      cwd: '/tmp/wt/mica-code',
      base: 'main',
      head: 'demand-1102',
      label: 'mica · demand-1102',
    });
  });

  it('leaves the base out when the plugin does not name one, and rejects a result without a path', () => {
    // 不补 `master`：仓库的默认分支可能是 `main`，编一个会让宿主落进「无法解析基线」。
    expect(normalizePluginPanelActionResult({ openReview: { cwd: '/tmp/a' } }).openReview).toEqual({
      cwd: '/tmp/a',
    });
    expect(normalizePluginPanelActionResult({ openReview: { base: 'master' } }).openReview).toBeUndefined();
  });
});
