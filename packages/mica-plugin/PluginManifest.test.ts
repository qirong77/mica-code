import { describe, expect, it } from 'vitest';
import { parsePluginManifest } from './PluginManifest.js';

function base(extra: Record<string, unknown> = {}) {
  return { id: 'demo', name: 'Demo', version: '1.0.0', ...extra };
}

describe('parsePluginManifest desktop checks', () => {
  it('reads the declared run requirements in declaration order', () => {
    const result = parsePluginManifest(base({ desktop: { checks: ['screen-recording', 'accessibility'] } }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.desktopChecks).toEqual(['screen-recording', 'accessibility']);
  });

  it('defaults to no checks when the plugin declares nothing', () => {
    const result = parsePluginManifest(base());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.desktopChecks).toEqual([]);
  });

  it('rejects unknown check ids so a broken manifest shows up in the config page', () => {
    const unknownCheck = parsePluginManifest(base({ desktop: { checks: ['telepathy'] } }));
    expect(unknownCheck.ok).toBe(false);
    if (!unknownCheck.ok) expect(unknownCheck.error).toContain('未知检查项');

    const notArray = parsePluginManifest(base({ desktop: { checks: 'accessibility' } }));
    expect(notArray.ok).toBe(false);
    if (!notArray.ok) expect(notArray.error).toContain('必须是数组');
  });

  it('dedupes repeated check ids instead of rendering the row twice', () => {
    const result = parsePluginManifest(base({ desktop: { checks: ['accessibility', 'accessibility'] } }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.desktopChecks).toEqual(['accessibility']);
  });
});

describe('parsePluginManifest desktop entry', () => {
  it('reads the sidebar label a plugin asks for', () => {
    const result = parsePluginManifest(base({ desktop: { entry: { label: '连接' } } }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.desktopEntry).toEqual({ label: '连接' });
  });

  it('falls back to the plugin name when the label is empty or missing', () => {
    const blank = parsePluginManifest(base({ desktop: { entry: { label: '  ' } } }));
    expect(blank.ok).toBe(true);
    if (blank.ok) expect(blank.manifest.desktopEntry).toEqual({ label: 'Demo' });

    const absent = parsePluginManifest(base({ desktop: { entry: {} } }));
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.manifest.desktopEntry).toEqual({ label: 'Demo' });
  });

  it('keeps entry and checks independent under the same desktop section', () => {
    const result = parsePluginManifest(
      base({ desktop: { checks: ['accessibility'], entry: { label: '连接' } } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.desktopChecks).toEqual(['accessibility']);
    expect(result.manifest.desktopEntry).toEqual({ label: '连接' });
  });

  it('rejects a malformed entry instead of silently dropping the sidebar row', () => {
    const notObject = parsePluginManifest(base({ desktop: { entry: 'servers' } }));
    expect(notObject.ok).toBe(false);
    if (!notObject.ok) expect(notObject.error).toContain('desktop.entry');

    const badLabel = parsePluginManifest(base({ desktop: { entry: { label: 42 } } }));
    expect(badLabel.ok).toBe(false);
    if (!badLabel.ok) expect(badLabel.error).toContain('label');
  });

  it('has no sidebar entry by default', () => {
    const result = parsePluginManifest(base());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.desktopEntry).toBeNull();
  });
});

describe('parsePluginManifest desktop page', () => {
  it('turns the entry into a full page when desktop.page is declared', () => {
    const result = parsePluginManifest(
      base({ desktop: { entry: { label: 'Schedule' }, page: { title: '排期' } } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.desktopPage).toEqual({ title: '排期' });
  });

  it('accepts page: true and falls back to the entry label as the title', () => {
    const result = parsePluginManifest(base({ desktop: { entry: { label: 'Schedule' }, page: true } }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.desktopPage).toEqual({ title: 'Schedule' });
  });

  it('refuses a page without an entry: nothing would open it', () => {
    const result = parsePluginManifest(base({ desktop: { page: true } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('desktop.entry');
  });

  it('leaves the page off by default', () => {
    const result = parsePluginManifest(base({ desktop: { entry: { label: '连接' } } }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.desktopPage).toBeNull();
  });
});

describe('parsePluginManifest desktop panel', () => {
  it('reads the panel label and the roles it is bound to', () => {
    const result = parsePluginManifest(base({ desktop: { panel: { label: '需求开发', roles: ['需求开发', ' 辅助 '] } } }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.desktopPanel).toEqual({
        label: '需求开发',
        roles: ['需求开发', '辅助'],
        display: 'drawer',
        shortcuts: [],
      });
    }
  });

  it('falls back to the plugin name and treats a missing role list as "any role"', () => {
    const blank = parsePluginManifest(base({ desktop: { panel: { label: ' ' } } }));
    expect(blank.ok).toBe(true);
    if (blank.ok)
      expect(blank.manifest.desktopPanel).toEqual({
        label: 'Demo',
        roles: [],
        display: 'drawer',
        shortcuts: [],
      });
  });

  it('reads the display form and rejects an unknown one', () => {
    const modal = parsePluginManifest(base({ desktop: { panel: { display: 'modal' } } }));
    expect(modal.ok).toBe(true);
    if (modal.ok) expect(modal.manifest.desktopPanel?.display).toBe('modal');

    const bad = parsePluginManifest(base({ desktop: { panel: { display: 'sheet' } } }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('display');
  });

  it('dedupes roles so the same role cannot render twice', () => {
    const result = parsePluginManifest(base({ desktop: { panel: { roles: ['需求开发', '需求开发'] } } }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.desktopPanel?.roles).toEqual(['需求开发']);
  });

  it('rejects a malformed panel instead of silently hiding the entry', () => {
    const notObject = parsePluginManifest(base({ desktop: { panel: 'demand-dev' } }));
    expect(notObject.ok).toBe(false);
    if (!notObject.ok) expect(notObject.error).toContain('desktop.panel');

    const badRoles = parsePluginManifest(base({ desktop: { panel: { roles: '需求开发' } } }));
    expect(badRoles.ok).toBe(false);
    if (!badRoles.ok) expect(badRoles.error).toContain('roles');
  });

  it('has no panel by default', () => {
    const result = parsePluginManifest(base());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.desktopPanel).toBeNull();
  });

  it('keeps the quick-bar shortcuts in declaration order', () => {
    const result = parsePluginManifest(
      base({
        desktop: {
          panel: {
            roles: ['需求开发'],
            shortcuts: [
              { label: '立刻检查', action: 'check.now' },
              { label: '频道设置', section: '频道设置' },
            ],
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.desktopPanel?.shortcuts).toEqual([
        { label: '立刻检查', action: 'check.now' },
        { label: '频道设置', section: '频道设置' },
      ]);
    }
  });

  it('rejects a shortcut that could not do anything when clicked', () => {
    const noTarget = parsePluginManifest(
      base({ desktop: { panel: { shortcuts: [{ label: '立刻检查' }] } } }),
    );
    expect(noTarget.ok).toBe(false);
    if (!noTarget.ok) expect(noTarget.error).toContain('action 或 section');

    const both = parsePluginManifest(
      base({ desktop: { panel: { shortcuts: [{ label: '立刻检查', action: 'a', section: 'b' }] } } }),
    );
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.error).toContain('不能同时');
  });
});

describe('parsePluginManifest requirements', () => {
  it('accepts the skills and desktop capability names', () => {
    const result = parsePluginManifest(base({ requires: ['skills', 'desktop', 'settings'] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.requires).toEqual(['skills', 'desktop', 'settings']);
  });

  it('rejects capability names the host can never provide', () => {
    const result = parsePluginManifest(base({ requires: ['teleport'] }));
    expect(result.ok).toBe(false);
  });
});

describe('parsePluginManifest icon', () => {
  it('keeps the declared icon name', () => {
    const result = parsePluginManifest(base({ icon: 'list-checks' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.icon).toBe('list-checks');
  });

  it('leaves the icon empty so the interface can fall back to its default', () => {
    const result = parsePluginManifest(base());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.icon).toBe('');
  });

  it('rejects names the interface could never resolve', () => {
    for (const icon of ['ListChecks', 'list_checks', 'list--checks', 'list checks', '图标']) {
      expect(parsePluginManifest(base({ icon })).ok).toBe(false);
    }
  });
});

describe('parsePluginManifest llm', () => {
  it('expands the llm declaration into ordinary settings fields', () => {
    const result = parsePluginManifest(base({ llm: { label: '起标题模型', modelPlaceholder: 'gpt-4o-mini' } }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 没声明就是「跟内核默认」：不能归一成 false，否则默认复用会话模型会失效。
    expect(result.manifest.llm).toMatchObject({ label: '起标题模型', reuseByDefault: undefined });
    // 字段进同一个 settings 列表：存储、校验、按会话覆盖因此只有一条路径。
    expect(result.manifest.settings.map((field) => field.key)).toEqual([
      'useMainProvider',
      'baseUrl',
      'apiKey',
      'protocol',
      'model',
    ]);
    expect(result.manifest.settings.find((field) => field.key === 'model')?.placeholder).toBe('gpt-4o-mini');
  });

  it('refuses a second declaration of the same keys', () => {
    const result = parsePluginManifest(
      base({
        llm: {},
        settings: [{ key: 'baseUrl', label: '地址', type: 'text' }],
      }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('baseUrl');
  });

  it('rejects wrong types instead of rendering an unusable form', () => {
    const wrongBool = parsePluginManifest(base({ llm: { required: 'yes' } }));
    expect(wrongBool.ok).toBe(false);

    const wrongString = parsePluginManifest(base({ llm: { label: 42 } }));
    expect(wrongString.ok).toBe(false);
  });

  it('is null when the plugin does not call a model', () => {
    const result = parsePluginManifest(base());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.llm).toBeNull();
  });
});

describe('parsePluginManifest status rows', () => {
  it('defaults a row to text and keeps link as written', () => {
    const result = parsePluginManifest(
      base({
        status: [
          { key: 'phoneUrl', label: '手机链接', type: 'link' },
          { key: 'bridge', label: '本机桥' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.status).toEqual([
      { key: 'phoneUrl', label: '手机链接', type: 'link' },
      { key: 'bridge', label: '本机桥', type: 'text' },
    ]);
  });

  it('is empty when the plugin declares nothing', () => {
    const result = parsePluginManifest(base());
    if (result.ok) expect(result.manifest.status).toEqual([]);
  });

  // 声明写错会让页面画出一行取不到值的状态，宁可加载阶段就报出来
  it('rejects rows without a key or with an unknown type', () => {
    expect(parsePluginManifest(base({ status: [{ label: '缺 key' }] })).ok).toBe(false);
    expect(parsePluginManifest(base({ status: [{ key: 'a', label: 'A', type: 'chart' }] })).ok).toBe(false);
    expect(parsePluginManifest(base({ status: [{ key: 'a' }] })).ok).toBe(false);
    expect(parsePluginManifest(base({ status: 'phoneUrl' })).ok).toBe(false);
  });

  it('rejects duplicate keys', () => {
    const result = parsePluginManifest(
      base({
        status: [
          { key: 'a', label: 'A' },
          { key: 'a', label: 'B' },
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe('parsePluginManifest settings-page actions', () => {
  it('keeps declared buttons in order with a neutral default tone', () => {
    const result = parsePluginManifest(
      base({
        actions: [
          { key: 'register', label: '注册到中转机', description: '拿回手机链接', tone: 'primary' },
          { key: 'test-connection', label: '测试连接' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.actions).toEqual([
      { key: 'register', label: '注册到中转机', description: '拿回手机链接', tone: 'primary' },
      { key: 'test-connection', label: '测试连接', description: '', tone: 'neutral' },
    ]);
  });

  it('is empty when the plugin declares nothing', () => {
    const result = parsePluginManifest(base());
    if (result.ok) expect(result.manifest.actions).toEqual([]);
  });

  // 页面按 key 找处理器：重复的 key 会让其中一个按钮永远没反应，加载阶段就报出来
  it('rejects broken declarations', () => {
    expect(parsePluginManifest(base({ actions: 'register' })).ok).toBe(false);
    expect(parsePluginManifest(base({ actions: [{ label: '缺 key' }] })).ok).toBe(false);
    expect(parsePluginManifest(base({ actions: [{ key: 'Register It', label: 'x' }] })).ok).toBe(false);
    expect(parsePluginManifest(base({ actions: [{ key: 'a' }] })).ok).toBe(false);
    expect(parsePluginManifest(base({ actions: [{ key: 'a', label: 'A', tone: 'loud' }] })).ok).toBe(false);
    expect(
      parsePluginManifest(
        base({
          actions: [
            { key: 'a', label: 'A' },
            { key: 'a', label: 'B' },
          ],
        }),
      ).ok,
    ).toBe(false);
  });
});

describe('parsePluginManifest desktop session menu', () => {
  it('reads the declared items in order', () => {
    const result = parsePluginManifest(
      base({
        desktop: { sessionMenu: [{ label: '复制会话', action: 'copy' }] },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.desktopSessionMenu).toEqual([{ label: '复制会话', action: 'copy' }]);
  });

  it('is empty when the plugin declares nothing', () => {
    const result = parsePluginManifest(base());
    if (result.ok) expect(result.manifest.desktopSessionMenu).toEqual([]);
  });

  // 只给文案的菜单项点了没反应，只给 id 的在菜单上看不出来
  it('rejects items without a label or action', () => {
    expect(parsePluginManifest(base({ desktop: { sessionMenu: [{ label: '复制' }] } })).ok).toBe(false);
    expect(parsePluginManifest(base({ desktop: { sessionMenu: [{ action: 'copy' }] } })).ok).toBe(false);
    expect(parsePluginManifest(base({ desktop: { sessionMenu: { label: '复制' } } })).ok).toBe(false);
  });

  // 两个菜单项跑到同一个分支等于其中一个做了另一件事
  it('rejects duplicate action ids', () => {
    const result = parsePluginManifest(
      base({
        desktop: {
          sessionMenu: [
            { label: '复制', action: 'copy' },
            { label: '再复制', action: 'copy' },
          ],
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('keeps panel and session menu independent under the same desktop section', () => {
    const result = parsePluginManifest(
      base({ desktop: { panel: { label: '面板' }, sessionMenu: [{ label: '复制', action: 'copy' }] } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.desktopPanel?.label).toBe('面板');
    expect(result.manifest.desktopSessionMenu).toHaveLength(1);
  });
});

describe('parsePluginManifest skills', () => {
  it('reads relative skill directories in declaration order and drops repeats', () => {
    const result = parsePluginManifest(base({ skills: ['skills', 'skills', 'skills/solo'] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.skills).toEqual(['skills', 'skills/solo']);
  });

  it('defaults to none so a plugin without skills reads the same as before', () => {
    const result = parsePluginManifest(base());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.skills).toEqual([]);
  });

  it('rejects paths that leave the plugin directory', () => {
    // 绝对路径能让一份插件指向机器上任意目录，`..` 能爬出插件目录——两者都让
    // 「这个插件带了什么」变得不可读，而这正是 plugin.json 存在的意义。
    const absolute = parsePluginManifest(base({ skills: ['/Users/me/skills'] }));
    expect(absolute.ok).toBe(false);
    if (!absolute.ok) expect(absolute.error).toContain('相对插件目录');

    const escaping = parsePluginManifest(base({ skills: ['../elsewhere'] }));
    expect(escaping.ok).toBe(false);
    if (!escaping.ok) expect(escaping.error).toContain('插件目录之外');

    const notArray = parsePluginManifest(base({ skills: 'skills' }));
    expect(notArray.ok).toBe(false);
    if (!notArray.ok) expect(notArray.error).toContain('必须是数组');
  });
});
