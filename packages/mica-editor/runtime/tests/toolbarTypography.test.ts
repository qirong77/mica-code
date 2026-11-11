// @vitest-environment happy-dom
import { $createHeadingNode, HeadingNode } from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  createEditor,
} from 'lexical';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { $getToolbarFontSize } from '../src/playground/plugins/ToolbarPlugin/typography';
import { $updateFontSizeInSelection } from '../src/playground/plugins/ToolbarPlugin/utils';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function makeEditor() {
  return createEditor({
    nodes: [HeadingNode],
    onError(error) {
      throw error;
    },
  });
}

describe('toolbar selection typography', () => {
  it.each([
    ['h1', '28px'],
    ['h2', '24px'],
    ['h3', '20px'],
    ['h4', '16px'],
    ['h5', '15px'],
    ['h6', '15px'],
  ] as const)('reads the inherited size of %s without inline formatting', (tag, expected) => {
    const editor = makeEditor();
    editor.update(
      () => {
        const heading = $createHeadingNode(tag);
        $getRoot().append(heading.append($createTextNode('Heading')));
        heading.selectEnd();
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) throw new Error('Expected text selection');
        expect($getToolbarFontSize(editor, selection)).toBe(expected);
      },
      { discrete: true },
    );
  });

  it('uses 15px for an empty body and the heading size for empty headings', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        for (const tag of ['paragraph', 'h2'] as const) {
          const block = tag === 'paragraph' ? $createParagraphNode() : $createHeadingNode(tag);
          $getRoot().append(block);
          block.select();
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) throw new Error('Expected text selection');
          expect($getToolbarFontSize(editor, selection)).toBe(tag === 'paragraph' ? '15px' : '24px');
        }
      },
      { discrete: true },
    );
  });

  it('keeps an explicit custom size ahead of heading defaults and computed CSS', () => {
    const editor = makeEditor();
    const dom = document.createElement('h1');
    dom.style.fontSize = '28px';
    vi.spyOn(editor, 'getElementByKey').mockReturnValue(dom);
    editor.update(
      () => {
        const text = $createTextNode('Custom').setStyle('font-size: 37px;');
        $getRoot().append($createHeadingNode('h1').append(text));
        text.select(0, 6);
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) throw new Error('Expected text selection');
        expect($getToolbarFontSize(editor, selection)).toBe('37px');
        selection.setStyle('font-size: 19px;');
        selection.anchor.set(text.getKey(), 3, 'text');
        selection.focus.set(text.getKey(), 3, 'text');
        expect($getToolbarFontSize(editor, selection)).toBe('19px');
      },
      { discrete: true },
    );
  });

  it('reads the actual computed size for unformatted selected text', () => {
    const editor = makeEditor();
    const dom = document.createElement('span');
    dom.style.fontSize = '17.5px';
    document.body.append(dom);
    vi.spyOn(editor, 'getElementByKey').mockReturnValue(dom);
    editor.update(
      () => {
        const text = $createTextNode('Body');
        $getRoot().append($createParagraphNode().append(text));
        text.select(0, 4);
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) throw new Error('Expected text selection');
        expect($getToolbarFontSize(editor, selection)).toBe('17.5px');
      },
      { discrete: true },
    );
  });

  it('leaves the control blank for a range spanning different heading sizes', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const first = $createTextNode('First');
        const last = $createTextNode('Last');
        $getRoot().append($createHeadingNode('h1').append(first), $createHeadingNode('h3').append(last));
        const selection = first.select(0, 5);
        selection.focus.set(last.getKey(), 4, 'text');
        expect($getToolbarFontSize(editor, selection)).toBe('');
      },
      { discrete: true },
    );
  });

  it('applies custom sizes only to the selection and safely ignores a missing selection', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        const text = $createTextNode('Body');
        $getRoot().append($createParagraphNode().append(text));
        $setSelection(null);
        expect(() => $updateFontSizeInSelection('42px', null, true)).not.toThrow();
        expect(text.getStyle()).toBe('');
        text.select(0, 4);
        $updateFontSizeInSelection('17.5px', null, true);
        expect(text.getStyle()).toBe('font-size: 17.5px;');
      },
      { discrete: true },
    );
  });
});
