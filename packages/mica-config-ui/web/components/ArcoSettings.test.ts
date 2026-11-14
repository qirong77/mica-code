import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ArcoAction, arcoPopupContainer, ArcoSettings, Select } from './ArcoSettings.js';
import { ProviderEditor } from './ProviderEditor.js';
import { PROVIDER_PROTOCOLS } from '@packages/mica-config/providerProtocol.js';
import { providerProtocolLabel } from '../labels.js';

const BASE_RAW = {
  id: 'example',
  api_base: 'https://api.example.com',
  api_key: 'example-key',
  protocol: 'openai_chat_completions',
  models: ['example-chat'],
};

function renderProvider(overrides: Partial<Parameters<typeof ProviderEditor>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(ArcoSettings, {
      children: createElement(ProviderEditor, {
        raw: BASE_RAW,
        index: 0,
        errorFor: () => undefined,
        removable: true,
        expanded: true,
        hasError: false,
        onChange: () => {},
        onToggleExpanded: () => {},
        onRemove: () => {},
        ...overrides,
      }),
    }),
  );
}

describe('Arco 配置页试验', () => {
  it('只换基础控件，保留服务商折叠行与字段骨架', () => {
    const html = renderProvider();
    for (const name of ['entry-row', 'entry-row-head', 'entry-row-body', 'setting-row']) {
      expect(html).toContain(name);
    }
    for (const name of ['arco-btn', 'arco-input', 'arco-select', 'arco-tag']) {
      expect(html).toContain(name);
    }
    expect(html).toContain('type="password"');
    expect(html).toContain('aria-label="服务商 1 API Key"');
    expect(html).toContain('aria-label="显示明文"');
    expect(html).toContain('aria-label="移除模型 example-chat"');
    // 协议是下拉框：收起态只显示当前取值，四个取值都由同一份人读名称渲染。
    expect(html).toContain('aria-label="服务商 1 协议"');
    for (const protocol of PROVIDER_PROTOCOLS) {
      const one = renderProvider({ raw: { ...BASE_RAW, protocol } });
      expect(one).toContain(`title="${providerProtocolLabel(protocol)}"`);
    }
  });

  it('仍默认收起；错误强制展开并交给 Arco 显示输入错误', () => {
    expect(renderProvider({ expanded: false })).not.toContain('entry-row-body');
    const html = renderProvider({ expanded: false, hasError: true, errorFor: () => '必填' });
    expect(html).toContain('entry-row-body');
    expect(html).toContain('arco-input-error');
    expect(html).toContain('待修正');
  });

  it('禁用时不能移除模型，且删除服务商按钮仍有可访问名称', () => {
    const html = renderProvider({ disabled: true });
    expect(html).not.toContain('aria-label="移除模型 example-chat"');
    expect(html).toContain('aria-label="删除服务商"');
    expect(html).toContain('arco-btn-disabled');
  });

  it('Arco 下拉能显示空字符串选项，不把它当作缺省值', () => {
    const html = renderToStaticMarkup(
      createElement(ArcoSettings, {
        children: createElement(Select, {
          value: '',
          options: [{ value: '', label: '跟随配置列表第一项' }],
        }),
      }),
    );
    expect(html).toContain('跟随配置列表第一项');
  });

  it('不引入全局 reset 或改变公共页面骨架', () => {
    const source = readFileSync(new URL('./ArcoSettings.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../arco-settings.css', import.meta.url), 'utf8');
    expect(source).toContain("node.closest('.mica-config-ui')");
    expect(css).not.toContain('dist/css/arco.css');
    expect(css).not.toContain("@import '@arco-design/web-react/es/style/index.css'");
    expect(css).toContain('@scope (.mica-config-ui)');
    expect(css).not.toMatch(/(?:^|[\n,])\s*(?:body|\.page-frame|\.app-shell)\s*\{/);
  });

  it('App 与配置页都提供完整的开关底色和状态 token，弹层不依赖配置页容器', () => {
    const css = readFileSync(new URL('../arco-settings.css', import.meta.url), 'utf8');
    expect(css).toContain('body.mica-arco-theme {');
    expect(css).toContain('@layer theme, base, mica-arco, components, utilities;');
    expect(css).toContain('--mica-arco-accent: var(--color-accent)');
    expect(css).toContain('--mica-arco-accent: var(--accent)');
    const tokens = css.match(/body\.mica-arco-theme,\s*\.mica-config-ui\s*\{([^}]+)\}/)?.[1];
    expect(tokens).toBeDefined();
    for (const token of ['color-bg-white', 'color-white', 'color-border', 'color-fill-4', 'primary-6', 'gray-6']) {
      expect(tokens).toContain(`--${token}:`);
    }
    expect(tokens).toContain('--color-bg-white: #fff');
    expect(tokens).not.toContain('--color-bg-white: var(--accent-contrast)');
    expect(css).not.toMatch(/\.arco-switch[^{}]*\{/);
    expect(css).not.toMatch(/\.arco-checkbox-mask[^{}]*\{/);
    expect(css).toContain(".arco-icon[fill='currentColor']");
  });

  it('删除旧控件皮肤，并让原生字体与 reset 规则避开 Arco 及其内部元素', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    for (const selector of [
      'ui-button',
      'ui-button-accent',
      'ui-tag',
      'ui-tag-green',
      'text-input',
      'config-stepper',
      'config-segment',
      'config-chip',
    ]) {
      expect(css).not.toMatch(new RegExp(`^\\s*\\.${selector}(?=[\\s:{.])[^{}]*\\{`, 'm'));
    }
    const nativeOnly =
      ":not(:where([class^='arco-'], [class*=' arco-'])):not(:where([class^='arco-'], [class*=' arco-']):not(.arco-settings) *)";
    expect(css).toContain(`:is(button, input, textarea)${nativeOnly}`);
    expect(css).toContain(`:focus-visible${nativeOnly}`);
    expect(css).not.toMatch(/\.data-table\s+(?:th|td)[^{}]*\{/);
  });

  it('标准动作使用 Arco 状态并透传原生事件、尺寸与锚点属性', () => {
    const html = renderToStaticMarkup(
      createElement(ArcoAction, {
        appearance: 'outline',
        tone: 'danger',
        'aria-label': '关闭面板',
        'aria-pressed': true,
        'data-anchor': 'panel',
        className: 'panel-action',
        style: { width: 24 },
        children: '关闭',
      }),
    );
    expect(html).toContain('arco-btn-outline');
    expect(html).toContain('arco-btn-status-danger');
    expect(html).toContain('aria-label="关闭面板"');
    expect(html).toContain('data-anchor="panel"');
    expect(html).toContain('width:24px');
    expect(html).toContain('panel-action');
    const themed = {} as Element;
    expect(arcoPopupContainer({ closest: () => themed } as unknown as HTMLElement)).toBe(themed);
  });

  it('纯图标入口在默认和激活状态都使用 Arco 的无文字内边距规格', () => {
    for (const active of [false, true]) {
      const html = renderToStaticMarkup(
        createElement(ArcoAction, {
          iconOnly: true,
          'aria-label': '会话笔记',
          'aria-pressed': active,
          'aria-expanded': active,
          className: 'grid size-6 place-items-center',
          children: createElement('svg', { width: 14, height: 14 }),
        }),
      );
      expect(html).toContain('arco-btn-icon-only');
      expect(html).toContain(`arco-btn-${active ? 'secondary' : 'text'}`);
      expect(html).toContain('grid size-6 place-items-center');
      expect(html).toContain('aria-label="会话笔记"');
      expect(html).not.toMatch(/\siconOnly=/);
    }
  });

  it('普通导航和文字动作使用主题中性色，不将整页入口染成强调色', () => {
    const css = readFileSync(new URL('../arco-settings.css', import.meta.url), 'utf8');
    const neutral = css.match(
      /\.mica-arco-action:not\(\.mica-arco-action-accent\):is\(\.arco-btn-text, \.arco-btn-outline\),\s*\.ui-button\.arco-btn-text\s*\{([^}]+)\}/,
    )?.[1];
    expect(neutral).toContain('--primary-6: from var(--color-text-1) r g b');
    expect(neutral).toContain('--color-primary-light-3: var(--color-text-4)');
    expect(neutral).not.toContain('--mica-arco-accent');
    for (const token of ['text', 'bg', 'panel', 'raised', 'accent', 'danger', 'warning', 'success']) {
      expect(css).toMatch(new RegExp(`--mica-arco-${token}: var\\(--color-`));
    }
  });

  it('动作继承宿主文字规格，纯图标使用双轴居中而不是文字基线', () => {
    const css = readFileSync(new URL('../arco-settings.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.mica-arco-action\s*\{\s*font: inherit;/);
    const icon = css.match(/\.mica-arco-action\.arco-btn-icon-only\s*\{([^}]+)\}/)?.[1];
    expect(icon).toContain('display: inline-flex');
    expect(icon).toContain('align-items: center');
    expect(icon).toContain('justify-content: center');
    expect(css).toMatch(/\.mica-arco-action\.arco-btn-text[^{}]+\{\s*color: inherit;/);
    expect(css).toContain("@import '@arco-design/web-react/es/Popover/style/index.css' layer(mica-arco)");
  });

  it('次要信息和禁用值使用独立语义，浅色实心按钮不直接复用链接蓝', () => {
    const css = readFileSync(new URL('../arco-settings.css', import.meta.url), 'utf8');
    expect(css).toContain('--color-text-3: var(--mica-arco-text-faint)');
    expect(css).toContain('--color-text-4: var(--mica-arco-text-disabled)');
    const light = css.match(
      /html\[data-appearance='light'\] :is\(body\.mica-arco-theme, \.mica-config-ui\)\s*\{([^}]+)\}/,
    )?.[1];
    expect(light).toContain('--mica-arco-text-faint: var(--mica-arco-text-soft)');
    expect(light).toContain('--mica-arco-text-disabled: color-mix(');
    expect(light).toContain('--mica-arco-accent-solid: color-mix(in srgb, var(--mica-arco-accent) 90%, #000)');
    expect(css).toContain('--primary-6: from var(--mica-arco-accent-solid) r g b');
  });

  it('标准控件由 Arco small / mini 负责尺寸，不再按设置页容器重写按钮和输入高度', () => {
    const css = readFileSync(new URL('../arco-settings.css', import.meta.url), 'utf8');
    expect(css).not.toContain('.arco-btn:not(.arco-btn-size-mini)');
    expect(css).not.toMatch(/\.arco-input,\s*\.arco-input-inner-wrapper,\s*\.arco-select-single/);
    expect(css).not.toMatch(/\.arco-radio-button\s*\{/);
    expect(css).not.toMatch(/\.arco-select-popup\s*\{/);
  });
});
