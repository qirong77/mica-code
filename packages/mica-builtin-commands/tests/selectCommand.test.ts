import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

let micaUi: typeof import('@packages/mica-ui/index.js').micaUi;
let showSelectCommand: typeof import('../shared/selectCommand.js').showSelectCommand;
let scheduleSpy: MockInstance;

const options = [
  { name: '["openai","gpt-4o"]', label: 'gpt-4o', description: 'OpenAI', searchField: 'gpt-4o OpenAI openai' },
  { name: '["deepseek","deepseek-v4"]', label: 'deepseek-v4', description: 'DeepSeek', searchField: 'deepseek-v4 DeepSeek deepseek' },
  { name: '["anthropic","claude-4"]', label: 'claude-4', description: 'Anthropic', searchField: 'claude-4 Anthropic anthropic' },
];

beforeAll(async () => {
  ({ micaUi } = await import('@packages/mica-ui/index.js'));
  ({ showSelectCommand } = await import('../shared/selectCommand.js'));
});

beforeEach(() => {
  // SelectorPanel 渲染的是 Ink 组件，静态渲染时替换成普通元素；useScheduleState
  // 由测试控制返回值，模拟订阅状态在按键后刷新。
  vi.spyOn(micaUi, 'Dialog').mockImplementation(({ title, children }: any) =>
    React.createElement('div', { 'data-title': title }, children),
  );
  vi.spyOn(micaUi, 'SelectList').mockImplementation(({ items }: any) =>
    React.createElement(
      'div',
      { 'data-testid': 'select-items' },
      (items as Array<{ key: string; label: React.ReactNode }>).map((item) =>
        React.createElement('span', { key: item.key }, item.label),
      ),
    ),
  );
  vi.spyOn(micaUi, 'KeyHints').mockImplementation(() => null);
  scheduleSpy = vi.spyOn(micaUi, 'useScheduleState');
});

afterEach(() => {
  vi.restoreAllMocks();
  micaUi.panels.clearPluginUIs();
});

function openPanel(): void {
  showSelectCommand({
    id: 'select-model',
    title: 'select model',
    current: options[0]!.name,
    options,
    filterable: true,
    onSelect: () => true,
  });
}

function renderPanel(search: string): string {
  let call = 0;
  scheduleSpy.mockImplementation(() => {
    call += 1;
    if (call === 1) return 0; // selectedIdx
    if (call === 2) return false; // applying
    return search; // searchText
  });
  const panel = micaUi.panels.pluginUIs.get()[0];
  if (!panel) throw new Error('no select panel registered');
  return renderToStaticMarkup(React.createElement(panel.component));
}

describe('showSelectCommand filter', () => {
  it('keeps re-filtering the option list when the search text changes after the first keystroke', () => {
    openPanel();

    // 初始无过滤：显示全部选项。
    expect(renderPanel('')).toContain('gpt-4o');
    expect(renderPanel('')).toContain('deepseek-v4');
    expect(renderPanel('')).toContain('claude-4');

    // 输入 gpt：只显示 gpt 相关模型。
    expect(renderPanel('gpt')).toContain('gpt-4o');
    expect(renderPanel('gpt')).not.toContain('deepseek-v4');
    expect(renderPanel('gpt')).not.toContain('claude-4');

    // 删掉再输入其他关键字（复现：先输 gpt → 按 delete → 再输别的，过滤失效）。
    expect(renderPanel('claude')).toContain('claude-4');
    expect(renderPanel('claude')).not.toContain('gpt-4o');
    expect(renderPanel('claude')).not.toContain('deepseek-v4');
  });
});
