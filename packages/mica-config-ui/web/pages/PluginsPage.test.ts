import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConfigWebPlugin } from '../../src/shared/types.js';
import { PluginCard } from './PluginsPage.js';

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
});
