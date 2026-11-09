import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ArcoSettings, Select } from './ArcoSettings.js';
import { ProviderEditor } from './ProviderEditor.js';

function renderProvider(overrides: Partial<Parameters<typeof ProviderEditor>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(ArcoSettings, {
      children: createElement(ProviderEditor, {
        raw: {
          id: 'example',
          api_base: 'https://api.example.com',
          api_key: 'example-key',
          protocol: 'openai',
          models: ['example-chat'],
        },
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
    for (const name of ['arco-btn', 'arco-input', 'arco-radio-group', 'arco-tag']) {
      expect(html).toContain(name);
    }
    expect(html).toContain('type="password"');
    expect(html).toContain('aria-label="服务商 1 API Key"');
    expect(html).toContain('aria-label="显示明文"');
    expect(html).toContain('aria-label="移除模型 example-chat"');
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

  it('不引入全局 reset、body 暗色开关或改变公共页面骨架', () => {
    const source = readFileSync(new URL('./ArcoSettings.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../arco-settings.css', import.meta.url), 'utf8');
    expect(source).toContain("node.closest('.arco-settings')");
    expect(css).not.toContain('dist/css/arco.css');
    expect(css).not.toContain("@import '@arco-design/web-react/es/style/index.css'");
    expect(css).toContain('@scope (.mica-config-ui .arco-settings)');
    expect(css).not.toMatch(/body\s*\{|\.page-frame\s*\{|\.app-shell\s*\{/);
  });
});
