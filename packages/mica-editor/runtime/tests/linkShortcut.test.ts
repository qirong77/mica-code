import {createHeadlessEditor} from '@lexical/headless';
import {$isLinkNode, LinkNode} from '@lexical/link';
import {$createParagraphNode, $createTextNode, $getRoot, $getSelection, $isRangeSelection} from 'lexical';
import {describe, expect, it} from 'vitest';

import {NOTEBOOK_LINK_SHORTCUT} from '../src/playground/plugins/FloatingLinkEditorPlugin/linkShortcut';

describe('Notebook link typing', () => {
  it('waits for Space, preserving the space and placing subsequent typing outside the link', () => {
    const source = '[说明](https://example.com/a_(b) "备注")';
    expect(NOTEBOOK_LINK_SHORTCUT.regExp!.test(source)).toBe(false);
    const editor = createHeadlessEditor({namespace: 'link-shortcut', nodes: [LinkNode], onError: error => {throw error;}});
    editor.update(() => {
      const node = $createTextNode(`${source} `);
      const paragraph = $createParagraphNode().append(node);
      $getRoot().append(paragraph);
      node.selectEnd();
      const match = node.getTextContent().match(NOTEBOOK_LINK_SHORTCUT.regExp!);
      expect(match).not.toBeNull();
      NOTEBOOK_LINK_SHORTCUT.replace!(node, match!);
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if ($isRangeSelection(selection)) selection.insertText('正文');
      const link = paragraph.getFirstChild();
      expect($isLinkNode(link)).toBe(true);
      if ($isLinkNode(link)) {
        expect(link.getURL()).toBe('https://example.com/a_(b)');
        expect(link.getTitle()).toBe('备注');
        expect(link.getTextContent()).toBe('说明');
      }
      expect(link?.getNextSibling()?.getTextContent()).toBe(' 正文');
    }, {discrete: true});
  });

  it('keeps escaped Markdown literal', () => {
    const editor = createHeadlessEditor({namespace: 'escaped-link-shortcut', nodes: [LinkNode], onError: error => {throw error;}});
    editor.update(() => {
      const source = '\\[说明](https://example.com) ';
      const node = $createTextNode(source);
      const paragraph = $createParagraphNode().append(node);
      $getRoot().append(paragraph);
      const match = source.match(NOTEBOOK_LINK_SHORTCUT.regExp!);
      NOTEBOOK_LINK_SHORTCUT.replace!(node, match!);
      expect(paragraph.getTextContent()).toBe(source);
      expect($isLinkNode(paragraph.getFirstChild())).toBe(false);
    }, {discrete: true});
  });
});
