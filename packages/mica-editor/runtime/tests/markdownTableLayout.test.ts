// @vitest-environment happy-dom

import {LexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {$isTableNode, $isTableRowNode, registerTablePlugin, registerTableSelectionObserver} from '@lexical/table';
import {$getRoot, $isTextNode, createEditor, type LexicalEditor} from 'lexical';
import {act, createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {$exportMarkdown, $importMarkdown} from '../src/markdown/markdownDocument';
import {calculateMarkdownTableColumnWidths, registerMarkdownTableLayout} from '../src/markdown/markdownTableLayout';
import {MARKDOWN_NODES} from '../src/markdown/transformers';
import TableCellResizerPlugin from '../src/playground/plugins/TableCellResizer';

const cleanups: (() => void)[] = [];
afterEach(async () => {
  await act(async () => {for (const cleanup of cleanups.splice(0).reverse()) cleanup();});
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('Markdown table starting widths', () => {
  it('keeps a short table compact instead of filling the editor', () => {
    expect(calculateMarkdownTableColumnWidths([['ID', '状态'], ['1', '完成']], 900)).toEqual([64, 64]);
  });

  it('allocates more room to prose than identifiers and fits the viewport', () => {
    const widths = calculateMarkdownTableColumnWidths([['ID', '说明', '备注'], ['1', '内容'.repeat(100), 'details '.repeat(60)]], 480);
    expect(widths[0]).toBe(64);
    expect(widths[1]).toBeGreaterThan(widths[0]);
    expect(widths[2]).toBeGreaterThan(widths[0]);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBe(479);
  });

  it('leaves readable minimum widths for a wide table to scroll locally', () => {
    const widths = calculateMarkdownTableColumnWidths([Array(12).fill('long text '.repeat(80))], 320);
    expect(widths).toEqual(Array(12).fill(64));
  });

  it('caps long URLs and accounts for full-width Chinese text', () => {
    expect(calculateMarkdownTableColumnWidths([['https://example.com/' + 'a'.repeat(500), '中文标题标题']], 1200)).toEqual([360, 108]);
    expect(calculateMarkdownTableColumnWidths([], 500)).toEqual([]);
  });
});

function $table() {
  const table = $getRoot().getFirstChild();
  if (!$isTableNode(table)) throw new Error('Expected a table');
  return table;
}

const SOURCE = '| ID | 说明 | 备注 |\n| --- | --- | --- |\n| 1 | ' + '内容'.repeat(80) + ' | ' + 'details '.repeat(50).trim() + ' |\n';

function createTableEditor(source = SOURCE) {
  const editor = createEditor({namespace: 'markdown-table-layout-test', nodes: MARKDOWN_NODES, onError(error) {throw error;}});
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.append(root);
  editor.setRootElement(root);
  cleanups.push(() => editor.setRootElement(null));
  editor.update(() => $importMarkdown(source), {discrete: true});
  return {editor, root};
}

function readWidths(editor: LexicalEditor) {
  return editor.getEditorState().read(() => $table().getColWidths());
}

function layoutFixture(initialWidth = 600) {
  const {editor, root} = createTableEditor();
  let width = initialWidth;
  root.style.padding = '0 30px';
  Object.defineProperty(root, 'clientWidth', {get: () => width, configurable: true});
  let frames: FrameRequestCallback[] = [];
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {frames.push(callback); return frames.length;});
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  let resized = () => {};
  class TestResizeObserver {
    constructor(callback: () => void) {resized = callback;}
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', TestResizeObserver);
  cleanups.push(registerMarkdownTableLayout(editor));
  const flush = async () => {
    for (let turn = 0; turn < 8 && frames.length; turn++) {
      const pending = frames;
      frames = [];
      pending.forEach(callback => callback(0));
      await Promise.resolve();
    }
    expect(frames).toHaveLength(0);
  };
  return {editor, root, flush, resize: (next: number) => {width = next; resized();}};
}

describe('runtime-only table layout', () => {
  it('refits untouched tables on editor resize and leaves Markdown and node styles unchanged', async () => {
    const {editor, root, flush, resize} = layoutFixture();
    const markdown = editor.getEditorState().read(() => $exportMarkdown(true));
    await flush();
    expect(readWidths(editor)?.reduce((sum, width) => sum + width, 0)).toBe(539);
    expect(root.querySelector('table')?.style.width).toBe('540px');
    resize(400);
    await flush();
    expect(readWidths(editor)?.reduce((sum, width) => sum + width, 0)).toBe(339);
    expect(root.querySelector('table')?.style.width).toBe('340px');
    expect(editor.getEditorState().read(() => $exportMarkdown(true))).toBe(markdown);
    expect(editor.getEditorState().read(() => $table().getStyle())).toBe('');
  });

  it('preserves manually resized columns when the editor later changes width', async () => {
    const {editor, root, flush, resize} = layoutFixture();
    await flush();
    editor.update(() => $table().setColWidths([100, 300, 200]), {discrete: true});
    await flush();
    resize(400);
    await flush();
    expect(readWidths(editor)).toEqual([100, 300, 200]);
    expect(root.querySelector('table')?.style.width).toBe('601px');
  });

  it('waits for a hidden visual editor to become measurable', async () => {
    const {editor, flush, resize} = layoutFixture(0);
    await flush();
    expect(readWidths(editor)).toBeUndefined();
    resize(600);
    await flush();
    expect(readWidths(editor)).toHaveLength(3);
  });

  it('keeps widths stable during typing and applies layout to newly inserted tables', async () => {
    const {editor, flush} = layoutFixture();
    await flush();
    const widths = readWidths(editor);
    editor.update(() => {
      const text = $table().getFirstDescendant();
      if ($isTextNode(text)) text.setTextContent('typing must not move all the columns '.repeat(10));
    }, {discrete: true});
    await flush();
    expect(readWidths(editor)).toEqual(widths);
    editor.update(() => {
      $importMarkdown('| A | B |\n| --- | --- |\n| short | text |\n');
    }, {discrete: true});
    await flush();
    expect(widths).toHaveLength(3);
    expect(readWidths(editor)).toEqual([64, 64]);
  });
});

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return new DOMRect(x, y, width, height);
}

async function resizerFixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(document.documentElement, 'clientWidth', {value: 1200, configurable: true});
  Object.defineProperty(document.documentElement, 'clientHeight', {value: 800, configurable: true});
  const {editor, root} = createTableEditor('| A | B |\n| --- | --- |\n| a | b |\n');
  const table = root.querySelector('table')!;
  cleanups.push(registerTablePlugin(editor), registerTableSelectionObserver(editor));
  editor.update(() => $table().setColWidths([140, 160]), {discrete: true});
  const cell = root.querySelector('th')!;
  vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(rect(100, 100, 200, 40));
  Object.defineProperty(cell, 'offsetWidth', {value: 100, configurable: true});
  vi.spyOn(table, 'getBoundingClientRect').mockReturnValue(rect(100, 100, 440, 80));
  table.querySelectorAll('col').forEach((col, index) => vi.spyOn(col, 'getBoundingClientRect').mockReturnValue(rect(100, 100, index === 0 ? 200 : 240, 80)));
  const mount = document.createElement('div');
  document.body.append(mount);
  const reactRoot = createRoot(mount);
  cleanups.push(() => reactRoot.unmount());
  await act(async () => {
    reactRoot.render(createElement(LexicalComposerContext.Provider, {value: [editor, {getTheme: () => null}]}, createElement(TableCellResizerPlugin, {initializeColumnWidths: false, minColumnWidth: 64, minRowHeight: 28})));
  });
  await act(async () => {cell.dispatchEvent(new PointerEvent('pointermove', {bubbles: true, clientX: 290, clientY: 110, isPrimary: true, pointerId: 1}));});
  const handle = document.querySelector<HTMLElement>('[data-table-resizer="column"]');
  expect(handle).not.toBeNull();
  return {editor, root, cell, handle: handle!};
}

async function pointer(target: EventTarget, type: string, x: number, pointerId = 1) {
  await act(async () => {
    target.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true, clientX: x, clientY: 110, button: 0, isPrimary: true, pointerId}));
  });
}

describe('table column drag', () => {
  it('uses rendered widths and cell scale when releasing outside the editor', async () => {
    const {editor, handle} = await resizerFixture();
    const markdown = editor.getEditorState().read(() => $exportMarkdown(true));
    await pointer(handle, 'pointerdown', 300);
    await pointer(document.body, 'pointermove', 330);
    expect(handle.style.left).toBe('330px');
    await pointer(document.body, 'pointerup', 360);
    expect(readWidths(editor)).toEqual([130, 120]);
    expect(editor.getEditorState().read(() => $exportMarkdown(true))).toBe(markdown);
  });

  it('enforces the Markdown minimum width and ignores other pointers', async () => {
    const {editor, handle} = await resizerFixture();
    await pointer(handle, 'pointerdown', 300);
    await pointer(document.body, 'pointerup', 20, 2);
    expect(readWidths(editor)).toEqual([140, 160]);
    await pointer(document.body, 'pointerup', 20);
    expect(readWidths(editor)).toEqual([64, 120]);
  });

  it('cancels a drag without changing widths', async () => {
    const {editor, handle} = await resizerFixture();
    await pointer(handle, 'pointerdown', 300);
    await pointer(document.body, 'pointermove', 400);
    await pointer(document.body, 'pointercancel', 400);
    expect(readWidths(editor)).toEqual([140, 160]);
    expect(document.querySelector('[data-table-resizer="column"]')).toBeNull();
  });

  it('captures the pointer and cancels cleanly if capture is lost across the iframe boundary', async () => {
    const {editor, handle} = await resizerFixture();
    const capture = vi.fn(), release = vi.fn();
    Object.defineProperties(handle, {
      setPointerCapture: {value: capture},
      hasPointerCapture: {value: () => true},
      releasePointerCapture: {value: release},
    });
    await pointer(handle, 'pointerdown', 300);
    expect(capture).toHaveBeenCalledWith(1);
    await pointer(document.body, 'pointermove', 400);
    await pointer(handle, 'lostpointercapture', 400);
    expect(release).toHaveBeenCalledWith(1);
    await pointer(document.body, 'pointerup', 500);
    expect(readWidths(editor)).toEqual([140, 160]);
    expect(document.querySelector('[data-table-resizer="column"]')).toBeNull();
  });

  it('resizes row height using the same cell scale without changing Markdown', async () => {
    const {editor, cell} = await resizerFixture();
    Object.defineProperty(cell, 'clientHeight', {value: 20, configurable: true});
    const otherCell = cell.parentElement!.querySelectorAll('th')[1];
    Object.defineProperty(otherCell, 'clientHeight', {value: 20, configurable: true});
    const markdown = editor.getEditorState().read(() => $exportMarkdown(true));
    const rowHandle = document.querySelector('[data-table-resizer="row"]')!;
    await act(async () => {rowHandle.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, clientX: 150, clientY: 140, button: 0, isPrimary: true, pointerId: 1}));});
    await act(async () => {document.body.dispatchEvent(new PointerEvent('pointerup', {bubbles: true, clientX: 150, clientY: 180, isPrimary: true, pointerId: 1}));});
    expect(editor.getEditorState().read(() => {
      const row = $table().getFirstChild();
      return $isTableRowNode(row) ? row.getHeight() : undefined;
    })).toBe(40);
    expect(editor.getEditorState().read(() => $exportMarkdown(true))).toBe(markdown);
  });

  it('hides stale handles when an editor scroll container moves', async () => {
    const {root} = await resizerFixture();
    await act(async () => {root.dispatchEvent(new Event('scroll'));});
    expect(document.querySelector('[data-table-resizer="column"]')).toBeNull();
  });

  it('cleans up when a table is deleted during a drag', async () => {
    const {editor, handle} = await resizerFixture();
    await pointer(handle, 'pointerdown', 300);
    await act(async () => {editor.update(() => $table().remove(), {discrete: true});});
    await pointer(document.body, 'pointerup', 400);
    expect(document.querySelector('[data-table-resizer="column"]')).toBeNull();
  });
});
