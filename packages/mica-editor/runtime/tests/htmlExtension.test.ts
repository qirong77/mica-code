import {createHeadlessEditor} from '@lexical/headless';
import {HeadingNode} from '@lexical/rich-text';
import {Window} from 'happy-dom';
import {$createParagraphNode, $createTextNode, $getRoot} from 'lexical';
import {describe, expect, it, vi} from 'vitest';

import {
  buildHtmlPreviewDocument,
  insertHtmlBlock,
  normalizeLocalHtml,
  pageEmbed,
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

  it('wraps HTML fragments in a preview document without changing complete documents', () => {
    expect(buildHtmlPreviewDocument('<strong>预览</strong>')).toContain('<body>');
    expect(buildHtmlPreviewDocument('<strong>预览</strong>')).toContain('<strong>预览</strong>');

    const document = '<!doctype html><html><body><main>完整文档</main></body></html>';
    expect(buildHtmlPreviewDocument(document)).toBe(document);
  });

  it('keeps a framed page reachable when the site refuses to be embedded', () => {
    const html = pageEmbed('https://github.com/zexadev/gemini-web2api-go');
    // The bar keeps the address clickable: X-Frame-Options / frame-ancestors
    // leave the iframe blank and there is no way to detect that from the host.
    expect(html).toContain('<span style="flex:1');
    expect(html).toContain('github.com</span>');
    expect(html).toContain('href="https://github.com/zexadev/gemini-web2api-go"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('src="https://github.com/zexadev/gemini-web2api-go"');
    expect(html).toContain('不允许被嵌入');
  });

  it('rejects addresses a frame cannot load', () => {
    expect(pageEmbed('javascript:alert(1)')).toBeNull();
    expect(pageEmbed('not a url')).toBeNull();
    expect(pageEmbed('http://example.com/a?b=1&c=2')).toContain('src="http://example.com/a?b=1&amp;c=2"');
  });
});

