import {createHeadlessEditor} from '@lexical/headless';
import {HeadingNode} from '@lexical/rich-text';
import {Window} from 'happy-dom';
import {$createParagraphNode, $createTextNode, $getRoot} from 'lexical';
import {describe, expect, it, vi} from 'vitest';

import {
  DEFAULT_REACT_BLOCK,
  insertHtmlBlock,
  normalizeLocalHtml,
} from '../src/playground/plugins/HtmlExtension';
import {HtmlNode} from '../src/playground/nodes/HtmlNode';

function createEditor() {
  return createHeadlessEditor({
    namespace: 'html-extension-test',
    nodes: [HeadingNode, HtmlNode],
    onError(error) { throw error; },
  });
}

describe('Notebook HTML blocks', () => {
  it('inserts an independent block and leaves a paragraph for continued writing', () => {
    const editor = createEditor();
    editor.update(() => {
      const paragraph = $createParagraphNode().append($createTextNode('前文'));
      $getRoot().append(paragraph);
      paragraph.selectEnd();
    }, {discrete: true});

    insertHtmlBlock(editor, {html: '<section><strong>内容</strong></section>'});

    editor.getEditorState().read(() => {
      expect($getRoot().getChildren().map(node => node.getType())).toEqual(['paragraph', 'html', 'paragraph']);
      const block = $getRoot().getChildren()[1];
      expect(block instanceof HtmlNode && block.getHtml()).toContain('<strong>内容</strong>');
    });
  });

  it('extracts inline styles and body content from a local HTML document', () => {
    const previousParser = globalThis.DOMParser;
    vi.stubGlobal('DOMParser', new Window().DOMParser);
    try {
      expect(normalizeLocalHtml('<!doctype html><html><head><style>.card{color:red}</style></head><body><div class="card">页面</div></body></html>'))
        .toBe('<style>.card{color:red}</style>\n<div class="card">页面</div>');
    } finally {
      vi.stubGlobal('DOMParser', previousParser);
    }
  });

  it('keeps the short React/Arco template executable as block source', () => {
    expect(DEFAULT_REACT_BLOCK).toContain('function App({React, Arco, html})');
    expect(DEFAULT_REACT_BLOCK).toContain('<${Card}');
    expect(DEFAULT_REACT_BLOCK).toContain('setCount(count + 1)');
  });
});

