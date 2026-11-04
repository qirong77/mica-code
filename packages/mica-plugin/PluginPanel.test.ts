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

  it('keeps a table: columns, text cells, check cells and row actions', () => {
    const view = normalizePluginPanelView({
      title: 'ssh',
      sections: [
        {
          title: '服务器',
          table: {
            columns: [
              { key: 'name', label: '名称' },
              { key: 'address', label: '地址', grow: true },
              { key: 'actions', label: '操作', actions: true },
              { key: 'session', label: '添加到会话' },
            ],
            rows: [
              {
                key: 'test',
                cells: {
                  name: { text: 'test', tone: 'accent' },
                  address: { text: 'root@10.0.0.1:22' },
                  session: { check: { checked: true, action: 'toggle-session' } },
                },
                actions: [{ id: 'edit', label: '编辑' }],
              },
            ],
          },
        },
      ],
    });
    const table = view.sections?.[0].table;
    expect(table?.columns.map((column) => column.key)).toEqual(['name', 'address', 'actions', 'session']);
    expect(table?.columns[1].grow).toBe(true);
    expect(table?.columns[2].actions).toBe(true);
    expect(table?.rows[0].cells.session?.check).toEqual({ checked: true, action: 'toggle-session' });
    expect(table?.rows[0].actions?.[0].id).toBe('edit');
  });

  it('keeps a cell’s second line (address, path) next to its main text', () => {
    const view = normalizePluginPanelView({
      title: 'ssh',
      sections: [
        {
          title: '服务器',
          table: {
            columns: [{ key: 'server', label: '服务器', grow: true }],
            rows: [{ key: 'test', cells: { server: { text: 'test', sub: 'root@10.0.0.1:22' } } }],
          },
        },
      ],
    });
    expect(view.sections?.[0].table?.rows[0].cells.server).toEqual({
      text: 'test',
      sub: 'root@10.0.0.1:22',
    });
  });

  it('drops a table that cannot be rendered, and unknown columns', () => {
    // 只有列没有行：画出来是个空表头，插件该用 empty 说话。
    const empty = normalizePluginPanelView({
      title: 'x',
      sections: [{ title: 't', empty: '还没有', table: { columns: [{ key: 'a', label: 'A' }], rows: [] } }],
    });
    expect(empty.sections?.[0].table).toBeUndefined();
    expect(empty.sections?.[0].empty).toBe('还没有');

    // 没声明的列不认；一个格子都没有的行整行丢掉。
    const partial = normalizePluginPanelView({
      title: 'x',
      sections: [
        {
          title: 't',
          table: {
            columns: [{ key: 'a', label: 'A' }],
            rows: [
              { key: 'r1', cells: { a: { text: 'hello' }, ghost: { text: '看不见' } } },
              { key: 'r2', cells: { ghost: { text: '整行都看不见' } } },
            ],
          },
        },
      ],
    });
    expect(partial.sections?.[0].table?.rows.map((row) => row.key)).toEqual(['r1']);
    expect(partial.sections?.[0].table?.rows[0].cells).toEqual({ a: { text: 'hello' } });

    // 勾选框没有动作 = 点不动的复选框，当成空格子。
    const noAction = normalizePluginPanelView({
      title: 'x',
      sections: [
        {
          title: 't',
          table: { columns: [{ key: 'c', label: 'C' }], rows: [{ key: 'r', cells: { c: { check: { checked: true } } } }] },
        },
      ],
    });
    expect(noAction.sections?.[0].table).toBeUndefined();
  });

  it('keeps the section a status bar points at', () => {
    const view = normalizePluginPanelView({
      title: 'ssh',
      statusBar: { label: 'prod', tone: 'ok', detail: '已连接', section: '服务器' },
    });
    expect(view.statusBar).toEqual({ label: 'prod', tone: 'ok', detail: '已连接', section: '服务器' });
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

  it('keeps select options and switch fields, trimming what it cannot render', () => {
    const view = normalizePluginPanelView({
      title: 'ssh',
      sections: [
        {
          title: '连接设置',
          fields: [
            {
              key: 'auth',
              label: '认证方式',
              type: 'select',
              value: 'password',
              options: [
                { value: 'password', label: '密码连接' },
                { value: 'key', label: 'SSH 私钥连接' },
                { value: '', label: '空值会被丢掉' },
                { value: 'extra', label: 'x'.repeat(200) },
              ],
            },
            { key: 'enabled', label: '让模型使用', type: 'switch', value: 'true' },
            { key: 'broken', label: '没有选项的 select', type: 'select' },
          ],
        },
      ],
    });
    const fields = view.sections?.[0].fields ?? [];
    expect(fields[0]).toMatchObject({ type: 'select', value: 'password' });
    expect(fields[0].options?.map((option) => option.value)).toEqual(['password', 'key', 'extra']);
    expect(fields[0].options?.[2].label.length).toBeLessThanOrEqual(60);
    expect(fields[1]).toMatchObject({ type: 'switch', value: 'true' });
    // 没有选项的 select 渲染出来是个点不动的下拉，退回普通文本框。
    expect(fields[2].type).toBe('text');
  });

  it('keeps a status line with a bounded label and tone', () => {
    const view = normalizePluginPanelView({
      title: 'ssh',
      statusBar: { label: 'SSH 已启用', detail: 'test, prod', tone: 'ok' },
    });
    expect(view.statusBar).toEqual({ label: 'SSH 已启用', detail: 'test, prod', tone: 'ok' });

    const noLabel = normalizePluginPanelView({ title: 'x', statusBar: { detail: 'only detail' } });
    expect(noLabel.statusBar).toBeUndefined();

    const badTone = normalizePluginPanelView({ title: 'x', statusBar: { label: 'ok', tone: 'purple' } });
    expect(badTone.statusBar?.tone).toBeUndefined();
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

  it('keeps a QR-only dialog and the "go configure" button', () => {
    const result = normalizePluginPanelActionResult({
      dialog: {
        title: '手机访问',
        qr: { value: 'https://mica.example.com/?t=0123456789abcdef', caption: '扫码打开' },
        configure: { label: '去插件页面配置' },
      },
    });
    expect(result.dialog).toEqual({
      title: '手机访问',
      columns: [],
      rows: [],
      qr: { value: 'https://mica.example.com/?t=0123456789abcdef', caption: '扫码打开' },
      configure: { label: '去插件页面配置' },
    });
    // `configure: true` 与 `{}` 一样，只是没写自定义文案
    expect(
      normalizePluginPanelActionResult({ dialog: { title: '手机访问', text: '还没接入', configure: true } })
        ?.dialog?.configure
    ).toEqual({});
  });

  it('keeps the "open panel" button next to "go configure"', () => {
    const result = normalizePluginPanelActionResult({
      dialog: {
        title: '手机访问',
        text: '还没接入',
        configure: { label: '去插件页面配置' },
        panel: { label: '首次部署' },
      },
    });
    expect(result.dialog?.configure).toEqual({ label: '去插件页面配置' });
    expect(result.dialog?.panel).toEqual({ label: '首次部署' });
  });

  it('drops a QR block without content', () => {
    expect(normalizePluginPanelActionResult({ dialog: { title: '手机访问', qr: { value: '  ' } } })).toEqual({});
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

  it('keeps the form only when the plugin asks for it', () => {
    expect(normalizePluginPanelActionResult({ keepDrafts: true }).keepDrafts).toBe(true);
    // 只认字面 true：`"true"` / 1 这类真值不当成「保留表单」，否则一个手滑的结果会让
    // 提交过的表单看起来没生效。
    expect(normalizePluginPanelActionResult({ keepDrafts: 'true' }).keepDrafts).toBeUndefined();
    expect(normalizePluginPanelActionResult({ message: 'ok' }).keepDrafts).toBeUndefined();
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
  it('keeps a menu table with columns and clickable rows', () => {
    const view = normalizePluginPanelView({
      title: 'x',
      menus: {
        reviews: {
          columns: [
            { key: 'project', label: '项目' },
            { key: 'branch', label: '分支', grow: true },
          ],
          rows: [
            {
              action: 'review.open',
              key: 'sass',
              cells: { project: { text: 'sass' }, branch: { text: 'demand-a' } },
            },
            { action: 'review.open', cells: { branch: { text: '缺项目名' } } },
            { key: 'no-action', cells: { project: { text: '点不动' } } },
          ],
        },
      },
    });
    expect(view.menus?.reviews.columns).toEqual([
      { key: 'project', label: '项目' },
      { key: 'branch', label: '分支', grow: true },
    ]);
    expect(view.menus?.reviews.rows).toEqual([
      {
        action: 'review.open',
        key: 'sass',
        cells: { project: { text: 'sass' }, branch: { text: 'demand-a' } },
      },
    ]);
  });

  it('drops menus that are not a table with columns and rows', () => {
    expect(normalizePluginPanelView({ title: 'x', menus: 'nope' }).menus).toBeUndefined();
    expect(normalizePluginPanelView({ title: 'x', menus: { a: 'nope' } }).menus).toBeUndefined();
    expect(
      normalizePluginPanelView({ title: 'x', menus: { a: { columns: [], rows: [] } } }).menus,
    ).toBeUndefined();
    expect(
      normalizePluginPanelView({
        title: 'x',
        menus: { a: { columns: [{ key: 'c', label: '列' }], rows: [] } },
      }).menus,
    ).toBeUndefined();
  });

  it('keeps a text preview menu, and text wins over a half-built table', () => {
    const view = normalizePluginPanelView({
      title: 'x',
      menus: {
        description: { text: '  需求：违章处置线上化\n目标：…  ' },
        both: { text: '只看正文', columns: [{ key: 'c', label: '列' }], rows: [] },
        blank: { text: '   ' },
      },
    });
    expect(view.menus?.description).toEqual({
      text: '需求：违章处置线上化\n目标：…',
      columns: [],
      rows: [],
    });
    expect(view.menus?.both.text).toBe('只看正文');
    expect(view.menus?.blank).toBeUndefined();
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
