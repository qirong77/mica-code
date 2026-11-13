// @vitest-environment happy-dom
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

import autoEmbedSource from '../src/playground/plugins/AutoEmbedPlugin/index.tsx?raw';
import KatexEquationAlterer from '../src/playground/ui/KatexEquationAlterer';
import TextInput from '../src/playground/ui/TextInput';

vi.mock('@lexical/react/LexicalComposerContext', () => ({
  useLexicalComposerContext: () => [{_onError: vi.fn()}],
}));
vi.mock('../src/playground/ui/KatexRenderer', () => ({
  default: ({equation}: {equation: string}) => createElement('div', {'data-preview': true}, equation),
}));

let root: Root | undefined;
let container: HTMLDivElement;

beforeAll(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
});

async function render(element: React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() => root!.render(element));
}

async function changeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', {bubbles: true}));
  });
}

describe('editor form controls', () => {
  it('labels the shared small input and forwards its value', async () => {
    const onChange = vi.fn();
    await render(createElement(TextInput, {label: '链接地址', value: 'https://example.com', onChange}));
    const label = container.querySelector('label')!;
    const input = container.querySelector('input')!;
    expect(label.htmlFor).toBe(input.id);
    expect(input.classList.contains('arco-input-size-small')).toBe(true);
    await changeValue(input, 'https://new.example.com');
    expect(onChange.mock.calls[0][0]).toBe('https://new.example.com');
  });

  it('uses the shared input for inline equations and submits edited text', async () => {
    const onConfirm = vi.fn();
    await render(createElement(KatexEquationAlterer, {initialEquation: 'x^2', onConfirm}));
    const input = container.querySelector<HTMLInputElement>('[data-test-id="equation-input"]')!;
    expect(input.classList.contains('arco-input')).toBe(true);
    expect(input.value).toBe('x^2');
    expect(container.querySelector('label[for]')?.getAttribute('for')).toBe(input.id);
    await changeValue(input, 'x+1');
    await act(() => container.querySelector<HTMLButtonElement>('[data-test-id="equation-submit-btn"]')!.click());
    expect(onConfirm).toHaveBeenCalledWith('x+1', true);
  });

  it('preserves the draft when switching to the shared multiline equation input', async () => {
    const onConfirm = vi.fn();
    await render(createElement(KatexEquationAlterer, {initialEquation: 'x^2', onConfirm}));
    const originalId = container.querySelector('[data-test-id="equation-input"]')!.id;
    await act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(textarea.classList.contains('arco-textarea')).toBe(true);
    expect(textarea.id).toBe(originalId);
    expect(textarea.value).toBe('x^2');
    await changeValue(textarea, 'x+1\ny+2');
    await act(() => container.querySelector<HTMLButtonElement>('[data-test-id="equation-submit-btn"]')!.click());
    expect(onConfirm).toHaveBeenCalledWith('x+1\ny+2', false);
  });
});

it('keeps the embed dialog on the shared form without a fixed overflowing width', () => {
  // Embed mounting and URL requests are not exercised by this source contract.
  expect(autoEmbedSource).toContain('label="链接地址"');
  expect(autoEmbedSource).not.toContain("width: '600px'");
  expect(autoEmbedSource).toMatch(/插入\s*<\/Button>/);
  expect(autoEmbedSource).toContain("new AutoEmbedOption('取消'");
  for (const name of ['YouTube 视频', 'X 帖子', 'Figma 文档']) expect(autoEmbedSource).toContain(`contentName: '${name}'`);
});
