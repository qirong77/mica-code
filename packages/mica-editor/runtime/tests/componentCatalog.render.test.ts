// @vitest-environment happy-dom
import * as Arco from '@arco-design/web-react';
import htm from 'htm';
import * as React from 'react';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

import {COMPONENT_TEMPLATES} from '../../componentCatalog';

type ComponentProps = {React: typeof import('react'); Arco: typeof Arco; html: ReturnType<typeof htm.bind>};
type Component = (props: ComponentProps) => React.ReactNode;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

beforeAll(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
});

const html = htm.bind(React.createElement);

function evaluate(source: string): Component {
  // These are the repository-owned catalog entries, not notebook/user input.
  return new Function('React', 'Arco', 'html', `${source}\nreturn App;`)(
    React,
    Arco,
    html,
  ) as Component;
}

async function renderTemplate(id: string) {
  const template = COMPONENT_TEMPLATES.find(item => item.id === id);
  expect(template).toBeDefined();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() => root!.render(createElement(evaluate(template!.code), {React, Arco, html})));
  return {template: template!, container};
}

function clickButton(label: string): void {
  const button = [...container!.querySelectorAll<HTMLButtonElement>('button')].find(item =>
    item.textContent?.replace(/\s+/g, ' ').trim().includes(label),
  );
  expect(button, `找不到按钮：${label}`).toBeDefined();
  act(() => button!.click());
}

function setInputValue(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
    input.dispatchEvent(new Event('blur', {bubbles: true}));
  });
}

describe('catalog component blocks render with React + Arco + htm', () => {
  it('keeps every catalog recipe free of string style props and mounts it', async () => {
    const styleWarnings: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation((...args) => {
      const message = args.map(String).join(' ');
      if (message.includes('style prop')) styleWarnings.push(message);
    });
    try {
      for (const template of COMPONENT_TEMPLATES) {
        const rendered = await renderTemplate(template.id);
        expect(rendered.container.textContent?.trim().length).toBeGreaterThan(0);
      }
    } finally {
      error.mockRestore();
    }
    expect(styleWarnings).toEqual([]);
  });

  it('updates the counter from an Arco button', async () => {
    const {container: view} = await renderTemplate('counter');
    expect(view.textContent).toContain('点击了 0 次');
    clickButton('点击了 0 次');
    expect(view.textContent).toContain('点击了 1 次');
  });

  it('filters the list and exposes an empty result state', async () => {
    const {container: view} = await renderTemplate('filtered-list');
    const input = view.querySelector<HTMLInputElement>('input[placeholder="搜索项目名称"]');
    expect(input).toBeDefined();
    setInputValue(input!, '不存在的项目');
    expect(view.textContent).toContain('没有匹配项');
    expect(view.textContent).toContain('0 项');
  });

  it('recalculates the total when a calculator parameter changes', async () => {
    const {container: view} = await renderTemplate('calculator');
    expect(view.textContent).toContain('345.60');
    const inputs = view.querySelectorAll<HTMLInputElement>('input');
    expect(inputs.length).toBeGreaterThanOrEqual(3);
    setInputValue(inputs[0], '200');
    expect(view.textContent).toContain('540.00');
  });

  it('switches the trend range and changes the plotted point count', async () => {
    const {container: view} = await renderTemplate('trend');
    expect(view.textContent).toContain('近 7 天');
    expect(view.querySelectorAll('circle')).toHaveLength(7);
    clickButton('8 周');
    expect(view.textContent).toContain('近 8 周');
    expect(view.querySelectorAll('circle')).toHaveLength(8);
  });

  it('sorts comparison rows and advances the workflow timeline', async () => {
    const comparison = await renderTemplate('comparison');
    const names = () => [...comparison.container.querySelectorAll('tbody th')].map(cell => cell.textContent?.trim());
    expect(names()).toEqual(['方案 A', '方案 C', '方案 B']);
    clickButton('降序');
    expect(names()).toEqual(['方案 B', '方案 C', '方案 A']);

    await act(() => root!.unmount());
    root = undefined;
    comparison.container.remove();
    const timeline = await renderTemplate('timeline');
    expect(timeline.container.textContent).toContain('收集问题');
    clickButton('下一步');
    expect(timeline.container.textContent).toContain('做出原型');
  });
});
