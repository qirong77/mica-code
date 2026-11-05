import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConfigWebPlugin } from '../../src/shared/types.js';
import { setConfigWebClient } from '../api.js';
import type { ConfigWebClient } from '../api.js';
import { PluginActionsGroup, PluginCard, PluginDetail, pluginRunningStatus } from './PluginsPage.js';

it('插件详情建立窄屏布局所需的页面容器', () => {
  const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const detail = styles.match(/\.plugin-detail\s*\{([^}]*)\}/)?.[1] ?? '';
  expect(detail).toMatch(/container-type:\s*inline-size/);
  expect(detail).toMatch(/container-name:\s*page/);
  expect(styles).toMatch(/@container page \(max-width: 980px\)\s*\{\s*\.plugin-columns\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
});

function plugin(overrides: Partial<ConfigWebPlugin> = {}): ConfigWebPlugin {
  return {
    id: 'todo',
    name: 'Todo',
    version: '1.0.0',
    description: '本轮计划',
    icon: 'list-checks',
    source: 'official',
    state: 'enabled',
    location: 'plugins/todo',
    manifestFile: 'plugins/todo/plugin.json',
    settings: { fields: [], values: {} },
    llm: null,
    desktopChecks: [],
    desktopEntry: null,
    desktopPage: null,
    status: [],
    attention: null,
    actions: [],
    desktopPanel: null,
    desktopSessionMenu: [],
    logFile: '',
    health: null,
    ...overrides,
  } as ConfigWebPlugin;
}

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

describe('插件目录卡片', () => {
  const noop = () => {};

  it('运行出错时悬停就能看到插件自己上报的那条', () => {
    const html = render(
      createElement(PluginCard, {
        plugin: plugin({
          loadStatus: 'loaded',
          health: { level: 'error', message: '连不上中转机', hint: '检查中转机地址', at: '2026-11-01T00:00:00.000Z' },
        }),
        canToggle: true,
        busy: false,
        onOpen: noop,
        onToggle: noop,
      }),
    );
    expect(html).toContain('运行出错');
    expect(html).toContain('连不上中转机');
    expect(html).toContain('检查中转机地址');
  });

  it('启停开关是卡片里那个按钮的兄弟节点，不是它的子节点', () => {
    const html = render(
      createElement(PluginCard, { plugin: plugin(), canToggle: true, busy: false, onOpen: noop, onToggle: noop }),
    );
    // 按钮里再套按钮是非法嵌套：开关必须排在 </button> 之后
    expect(html).toContain('plugin-card-open');
    expect(html.indexOf('plugin-card-toggle')).toBeGreaterThan(html.indexOf('</button>'));
    expect(html.indexOf('<button')).toBe(html.lastIndexOf('<button'));
  });

  it('开关反映当前的启用状态，停用的卡片压暗', () => {
    const enabled = render(
      createElement(PluginCard, { plugin: plugin(), canToggle: true, busy: false, onOpen: noop, onToggle: noop }),
    );
    expect(enabled).toContain('checked=""');
    expect(enabled).not.toContain('is-inactive');

    const disabled = render(
      createElement(PluginCard, {
        plugin: plugin({ state: 'disabled' }),
        canToggle: true,
        busy: false,
        onOpen: noop,
        onToggle: noop,
      }),
    );
    expect(disabled).toContain('is-inactive');
    expect(disabled).not.toContain('checked=""');
    // 停用态只掉颜色：卡片本身还是那张卡
    expect(disabled).toContain('plugin-card-open');
  });

  it('宿主不支持启停时不画开关，卡片照样能点开', () => {
    const html = render(
      createElement(PluginCard, { plugin: plugin(), canToggle: false, busy: false, onOpen: noop, onToggle: noop }),
    );
    expect(html).not.toContain('ui-switch');
    expect(html).toContain('plugin-card-open');
  });

  it('装配成功的卡片不再说一遍「已加载」：那是右上角开关在说的话', () => {
    const html = render(
      createElement(PluginCard, {
        plugin: plugin({ loadStatus: 'loaded', loadHost: 'tui' }),
        canToggle: true,
        busy: false,
        onOpen: noop,
        onToggle: noop,
      }),
    );
    // 启停是开关的语义：卡片上再说一遍，就是两个控件说同一件事
    expect(html).not.toContain('已启用');
    expect(html).not.toContain('已加载');
    // 既没有异常结论、也没有设置项与运行条件时，脚注整行都不画
    expect(html).not.toContain('plugin-card-status');
    expect(html).not.toContain('plugin-card-foot');
  });

  it('正常加载的卡片仍会显示设置项数量', () => {
    const html = render(
      createElement(PluginCard, {
        plugin: plugin({
          loadStatus: 'loaded',
          settings: { fields: [{}, {}] as never, values: {}, issues: [] },
        }),
        canToggle: true,
        busy: false,
        onOpen: noop,
        onToggle: noop,
      }),
    );
    expect(html).toContain('plugin-card-foot');
    expect(html).toContain('2 项设置');
    expect(html).not.toContain('已加载');
    expect(html).not.toContain('plugin-card-status');
  });

  it('装配结论不是「已加载」时，脚注连宿主一起说', () => {
    const html = render(
      createElement(PluginCard, {
        plugin: plugin({ loadStatus: 'skipped', loadHost: 'tui' }),
        canToggle: true,
        busy: false,
        onOpen: noop,
        onToggle: noop,
      }),
    );
    expect(html).toContain('plugin-card-status');
    // 跨宿主的跳过不是故障：结论要连写它的宿主一起读
    expect(html).toContain('已跳过');
    expect(html).toContain('TUI');
  });

  it('停用的卡片脚注说「已停用」，不保留上一次装配的结论', () => {
    const html = render(
      createElement(PluginCard, {
        plugin: plugin({ state: 'disabled', loadStatus: 'loaded', loadHost: 'app-server' }),
        canToggle: true,
        busy: false,
        onOpen: noop,
        onToggle: noop,
      }),
    );
    expect(html).toContain('已停用');
    expect(html).not.toContain('已加载');
  });
});

describe('插件详情页', () => {
  const noop = () => {};

  it('hero 只留一个开关，不再并排一枚状态标签', () => {
    const html = render(
      createElement(PluginDetail, {
        plugin: plugin({ loadStatus: 'loaded', loadHost: 'tui' }),
        busy: false,
        canToggle: true,
        canSettings: true,
        loading: false,
        error: null,
        notice: null,
        onBack: noop,
        onRefresh: noop,
        onToggleEnabled: noop,
        onSaved: noop,
      }),
    );
    // 一个开关就是一个 ui-switch-track；两个说明旁边还挂着那枚标签
    expect(html.match(/ui-switch-track/g)).toHaveLength(1);
    expect(html).not.toContain('已启用');
    expect(html).toContain('已加载');
  });

  it('日志这一行是可点的路径链接，目录那行保持纯文本', () => {
    // 只声明要验的两个动作：其余数据操作这一页不会碰
    setConfigWebClient({
      revealPath: async () => ({ ok: true }),
      openPathInEditor: async () => ({ ok: true }),
    } as unknown as ConfigWebClient);
    try {
      const html = render(
        createElement(PluginDetail, {
          plugin: plugin({
            location: 'plugins/todo',
            logFile: '/Users/me/Library/Logs/mica/plugin-todo-20261103.jsonl',
          }),
          busy: false,
          canToggle: true,
          canSettings: true,
          loading: false,
          error: null,
          notice: null,
          onBack: noop,
          onRefresh: noop,
          onToggleEnabled: noop,
          onSaved: noop,
        }),
      );
      expect(html).toContain('class="path-link"');
      expect(html).toContain('/Users/me/Library/Logs/mica/plugin-todo-20261103.jsonl');
      // 只有日志那一行：官方插件的目录是仓库里的相对路径，装好的应用里不存在
      expect(html.match(/class="path-link"/g)).toHaveLength(1);
    } finally {
      setConfigWebClient(null);
    }
  });

  // 有的插件没有侧栏入口（清单只写 desktop.page）：它的整页只能从这张卡打开，
  // 所以详情里必须有那枚按钮——浏览器宿主画不出来，那时不出现。
  it('声明了整页就去详情里给一个打开它的按钮，宿主接不了则不画', () => {
    const openPage = () => {};
    const withPage = (extra: Record<string, unknown>) =>
      render(
        createElement(PluginDetail, {
          plugin: plugin({ desktopPage: { title: '标签' } }),
          busy: false,
          canToggle: true,
          canSettings: true,
          loading: false,
          error: null,
          notice: null,
          onBack: noop,
          onRefresh: noop,
          onToggleEnabled: noop,
          onSaved: noop,
          ...extra,
        }),
      );
    expect(withPage({ onOpenPluginPage: openPage })).toContain('>打开标签<');
    expect(withPage({})).not.toContain('>打开标签<');
  });
});

describe('运行结论', () => {
  it('停用优先于上一次的装配结论', () => {
    expect(pluginRunningStatus(plugin({ state: 'disabled', loadStatus: 'loaded' }))).toEqual({
      label: '已停用',
      tone: 'default',
    });
  });

  it('装配成功连宿主一起说', () => {
    expect(pluginRunningStatus(plugin({ loadStatus: 'loaded', loadHost: 'app-server' }))).toEqual({
      label: '已加载 · 会话宿主（app-server）',
      tone: 'green',
    });
  });

  it('被宿主跳过', () => {
    expect(pluginRunningStatus(plugin({ loadStatus: 'skipped' }))).toEqual({ label: '已跳过', tone: 'default' });
  });

  it('没有装配记录', () => {
    expect(pluginRunningStatus(plugin())).toEqual({ label: '尚未加载', tone: 'default' });
  });

  it('插件上报出错：装配是成功的，说的是运行故障', () => {
    const status = pluginRunningStatus(
      plugin({ health: { level: 'error', message: '连不上中转机', at: '2026-11-01T00:00:00.000Z' } }),
    );
    // 开关亮着、脚注写「加载失败」会让人以为插件没装上：装配与运行是两件事。
    expect(status).toEqual({ label: '运行出错', tone: 'red' });
  });

  it('装配失败才是「加载失败」', () => {
    expect(pluginRunningStatus(plugin({ loadStatus: 'failed' }))).toEqual({ label: '加载失败', tone: 'red' });
  });

  it('插件上报待配置', () => {
    const status = pluginRunningStatus(
      plugin({ health: { level: 'warn', message: '还没填地址', at: '2026-11-01T00:00:00.000Z' } }),
    );
    expect(status).toEqual({ label: '待配置', tone: 'blue' });
  });
});

describe('插件动作', () => {
  const noop = () => {};
  const actions = [
    { key: 'sync', label: '更新中转机页面', description: '比一次版本，落后时上传当前构建', tone: 'neutral' as const },
  ];

  // 一行一件事：说明是按钮左边那一条短句（放不下就省略，全文进 tooltip），
  // 不把按钮讲成一整段话——那读起来像说明书，不像设置项。
  it('说明与按钮同一行，全文进 tooltip', () => {
    const html = render(createElement(PluginActionsGroup, { plugin: plugin({ actions }), values: {}, onDone: noop }));
    expect(html).toContain('plugin-action-note');
    expect(html).toContain('title="比一次版本，落后时上传当前构建"');
    expect(html).toContain('>更新中转机页面<');
    expect(html).not.toContain('plugin-action-hint');
  });
});
