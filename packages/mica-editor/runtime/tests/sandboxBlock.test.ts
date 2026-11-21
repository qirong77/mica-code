// @vitest-environment happy-dom
import {FocusTrapExtension} from '@lexical/a11y';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {defineExtension} from 'lexical';
import {act, createElement} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

import {SandboxBlock} from '../src/playground/nodes/sandboxBlock';
import {registerEditorModal, subscribeEditorModals} from '../src/playground/ui/modalVisibility';

let root: Root | undefined;
beforeAll(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => {
  if (root) await act(() => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
});

const extension = defineExtension({name: 'sandbox-block-test', dependencies: [FocusTrapExtension]});
const code = 'function App() {\n' + '  // long source\n'.repeat(40) + '  return null;\n}';

async function renderBlock() {
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const onSave = vi.fn();
  await act(() => root!.render(createElement(LexicalExtensionComposer, {extension}, createElement(SandboxBlock, {
    document: '<!doctype html><body>Short preview</body>',
    frameTitle: '组件块', editLabel: '编辑组件', source: code, height: 80, onSave,
  }))));
  return {container, onSave};
}

function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label);
  expect(button).toBeDefined();
  return act(() => button!.click());
}

describe('sandbox source editing', () => {
  it('edits long source in a portal independent of an 80px preview and saves once', async () => {
    const {container, onSave} = await renderBlock();
    const visibility = vi.fn();
    const unsubscribe = subscribeEditorModals(visibility);
    await click('编辑组件');
    expect(container.querySelector('textarea')).toBeNull();
    const modal = document.querySelector('.block-source-modal')!;
    const input = modal.querySelector('textarea')!;
    expect(input.value).toBe(code);
    expect(modal.querySelector('label')?.htmlFor).toBe(input.id);
    expect(container.querySelector('iframe')?.style.height).toBe('80px');
    expect(visibility).toHaveBeenLastCalledWith(true);
    const edited = code.replace('return null', 'return "changed"');
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, edited);
      input.dispatchEvent(new Event('input', {bubbles: true}));
    });
    await click('保存');
    expect(onSave).toHaveBeenCalledExactlyOnceWith(edited);
    expect(visibility).toHaveBeenLastCalledWith(false);
    unsubscribe();
  });

  it('cancels without changing the node and restores its saved source on reopen', async () => {
    const {onSave} = await renderBlock();
    await click('编辑组件');
    await click('取消');
    expect(onSave).not.toHaveBeenCalled();
    await click('编辑组件');
    expect(document.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(code);
  });

  it('keeps the host masked until the last nested modal closes', () => {
    const visibility = vi.fn();
    const unsubscribe = subscribeEditorModals(visibility);
    const closeOuter = registerEditorModal();
    const closeInner = registerEditorModal();
    visibility.mockClear();
    closeInner();
    expect(visibility).not.toHaveBeenCalled();
    closeOuter();
    expect(visibility).toHaveBeenCalledExactlyOnceWith(false);
    closeOuter();
    expect(visibility).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
