import { describe, expect, it } from 'vitest';

import { isSafeUrl, markdownDocument } from './markdown-document';
import type { NotebookDocument } from './model';

const empty: NotebookDocument = { version: 1, editorState: null };
const rootOf = (document: NotebookDocument) => JSON.parse(document.editorState!).root;
const walk = (node: Record<string, any>): Record<string, any>[] => [node, ...(node.children ?? []).flatMap(walk)];
const textOf = (node: Record<string, any>): string =>
  node.type === 'linebreak' ? '\n' : (node.text ?? (node.children ?? []).map(textOf).join(''));

describe('Notebook Markdown document conversion', () => {
  it('decodes ordinary text entities and keeps an entity-escaped safe URL linked', () => {
    const result = markdownDocument(empty, 'A &amp; B &#x4e2d; &#60;\n\n[x](https://example.com?a=1&amp;b=2)');
    const root = rootOf(result.document);
    expect(textOf(root)).toContain('A & B 中 <');
    const link = walk(root).find((node) => node.type === 'link');
    expect(link?.url).toBe('https://example.com?a=1&b=2');
    expect(result.warnings).toEqual([]);
  });
  it('creates H1–H6 with inline children, paragraphs and rules without spacer paragraphs', () => {
    const result = markdownDocument(
      empty,
      '# 一\n\n## 二\n\n### 三\n\n#### 四\n\n##### 五\n\n###### 六\n\n正文\n\n---',
    );
    const root = rootOf(result.document);
    expect(root.children.map((node: Record<string, unknown>) => node.type)).toEqual([
      ...Array(6).fill('heading'),
      'paragraph',
      'horizontalrule',
    ]);
    expect(root.children.slice(0, 6).map((node: Record<string, unknown>) => node.tag)).toEqual([
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
    ]);
    expect(root.children[0].children[0].type).toBe('text');
    expect(result.outline).toEqual(['一', '二', '三', '四', '五', '六']);
    expect(result.warnings).toEqual([]);
  });

  it('combines bold/italic/strike/code formats and uses linebreak nodes', () => {
    const result = markdownDocument(empty, '**_~~组合~~_** **`code`**\n软换行  \n硬换行');
    const nodes = walk(rootOf(result.document));
    expect(nodes.find((node) => node.text === '组合')?.format).toBe(1 | 2 | 4);
    expect(nodes.find((node) => node.text === 'code')?.format).toBe(1 | 16);
    expect(nodes.filter((node) => node.type === 'linebreak')).toHaveLength(2);
  });

  it('creates native nested ordered, bullet and checked lists without losing text', () => {
    const result = markdownDocument(empty, '3. 第一\n   - 内层\n     - [ ] 待办\n     - [x] 完成\n4. 第二');
    const root = rootOf(result.document);
    const lists = walk(root).filter((node) => node.type === 'list');
    expect(lists.map((node) => node.listType)).toEqual(['number', 'bullet', 'check']);
    expect(lists[0].start).toBe(3);
    expect(lists[0].children[0].value).toBe(3);
    expect(lists[0].children[1].children[0].type).toBe('list');
    expect(lists[2].children.map((node: Record<string, unknown>) => node.checked)).toEqual([false, true]);
    expect(textOf(root)).toContain('第一内层待办完成第二');
    expect(result.statistics.lists).toBe(3);
    expect(result.warnings).toEqual([]);
  });

  it('keeps nested quotes and their block content as native blocks', () => {
    const root = rootOf(markdownDocument(empty, '> ## 引用\n>\n> 段落\n>\n> > 内层\n>\n> - 项目').document);
    expect(root.children[0].type).toBe('quote');
    expect(root.children[0].children.map((node: Record<string, unknown>) => node.type)).toEqual([
      'heading',
      'paragraph',
      'quote',
      'list',
    ]);
    expect(textOf(root)).toBe('引用段落内层项目');
  });

  it('uses real code nodes and preserves empty lines, indentation and languages', () => {
    const root = rootOf(
      markdownDocument(empty, '```ts\n\nconst x = 1;\n\n  return x;\n\n```\n\n~~~python\nprint(1)\n~~~').document,
    );
    expect(root.children.map((node: Record<string, unknown>) => node.type)).toEqual(['code', 'code']);
    expect(root.children[0].language).toBe('ts');
    expect(textOf(root.children[0])).toBe('\nconst x = 1;\n\n  return x;\n');
    expect(root.children[0].children.filter((node: Record<string, unknown>) => node.type === 'linebreak')).toHaveLength(
      4,
    );
    expect(root.children[1].language).toBe('python');
  });

  it('creates compact, aligned GFM tables with real header cells and no fixed widths', () => {
    const result = markdownDocument(empty, '| 名称 | 状态 |\n| --- | :---: |\n| `a\\|b` | **好** |');
    const table = rootOf(result.document).children[0];
    expect(table.type).toBe('table');
    expect(table).not.toHaveProperty('colWidths');
    expect(table.children[0].children.map((cell: Record<string, unknown>) => cell.headerState)).toEqual([1, 1]);
    expect(table.children[1].children[0].headerState).toBe(0);
    expect(table.children[0].children[1].children[0].format).toBe('center');
    expect(textOf(table.children[1].children[0])).toBe('a|b');
    expect(walk(table).find((node) => node.text === '好')?.format).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it.each(['append', 'prepend'] as const)(
    'keeps root state, document style and every existing rich node on %s',
    (mode) => {
      const existing = {
        root: {
          $: { micaDocumentStyle: { width: 'wide', fontSize: 16 } },
          children: [
            { type: 'image', src: 'data:image/png;base64,kept', caption: { editorState: {} } },
            { type: 'table', children: [], colWidths: [240] },
          ],
          direction: 'rtl',
          format: 'right',
          indent: 0,
          type: 'root',
          version: 1,
        },
        custom: 'kept',
      };
      const original = JSON.stringify(existing);
      const result = markdownDocument({ version: 1, editorState: original }, '新段落', mode);
      const state = JSON.parse(result.document.editorState!);
      expect(state.root['$']).toEqual(existing.root['$']);
      expect(state.root.format).toBe('right');
      expect(state.root.direction).toBe('rtl');
      expect(state.custom).toBe('kept');
      expect(mode === 'append' ? state.root.children.slice(0, 2) : state.root.children.slice(1)).toEqual(
        existing.root.children,
      );
      expect(JSON.stringify(existing)).toBe(original);
    },
  );

  it('does not execute HTML or unsafe URLs, does not create inline paragraphs, and reports image fallbacks', () => {
    const result = markdownDocument(
      empty,
      '<script>alert(1)</script>\n\n[x](javascript:bad) ![图](data:image/png;base64,x) ![](https://example.com/img.png) [ok](https://example.com) <b>literal</b>',
    );
    const root = rootOf(result.document);
    const nodes = walk(root);
    expect(textOf(root)).toContain('<script>alert(1)</script>');
    expect(nodes.filter((node) => node.type === 'link').map((node) => node.url)).toEqual([
      'https://example.com/img.png',
      'https://example.com',
    ]);
    expect(root.children[1].children.every((node: Record<string, unknown>) => node.type !== 'paragraph')).toBe(true);
    expect(nodes.some((node) => node.type === 'image')).toBe(false);
    expect(textOf(root)).toContain('图');
    expect(textOf(root)).toContain('https://example.com/img.png');
    expect(result.warnings.join(' ')).toMatch(/HTML.*Unsafe URL.*Image/);
  });

  it('turns a paragraph that is only a base64 data image into an image block', () => {
    const result = markdownDocument(empty, '![侧边栏](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)\n\n后一段');
    const root = rootOf(result.document);
    expect(root.children.map((node: Record<string, unknown>) => node.type)).toEqual(['image', 'paragraph']);
    expect(root.children[0]).toMatchObject({
      altText: '侧边栏',
      maxWidth: 720,
      showCaption: false,
      src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      type: 'image',
    });
    expect(result.statistics.images).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it('keeps a remote image as a link and reports why it was not inserted', () => {
    const result = markdownDocument(empty, '![](https://example.com/a.png)');
    const root = rootOf(result.document);
    expect(root.children.map((node: Record<string, unknown>) => node.type)).toEqual(['paragraph']);
    expect(result.statistics.images).toBe(0);
    expect(result.warnings.join(' ')).toMatch(/only a complete base64 data:image URL/);
  });

  it('refuses an inline image past the size limit instead of writing it into the document', () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(1024 * 1024);
    const result = markdownDocument(empty, `![大图](${huge})`);
    expect(rootOf(result.document).children.some((node: Record<string, unknown>) => node.type === 'image')).toBe(
      false,
    );
    expect(result.statistics.images).toBe(0);
    expect(result.warnings.join(' ')).toMatch(/exceeds the 512 KiB inline limit/);
  });

  it('turns one complete HTML element into an interactive html block', () => {
    const html = '<div class="card"><p>一键建群</p><button type="button">建群</button></div>';
    const result = markdownDocument(empty, `${html}\n\n下一段`);
    const root = rootOf(result.document);
    expect(root.children.map((node: Record<string, unknown>) => node.type)).toEqual(['html', 'paragraph']);
    expect(root.children[0]).toMatchObject({ html, type: 'html' });
    expect(root.children[0]).not.toHaveProperty('runtime');
    expect(result.statistics.html_blocks).toBe(1);
    expect(result.statistics.component_blocks).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it('keeps HTML as text when it is a fragment, several roots, or a script', () => {
    for (const source of [
      '文字 <div>x</div>',
      '<div>a</div><div>b</div>',
      '<script>alert(1)</script>',
      '<div>没有闭合',
    ]) {
      const result = markdownDocument(empty, source);
      expect(result.statistics.html_blocks).toBe(0);
      expect(rootOf(result.document).children.some((node: Record<string, unknown>) => node.type === 'html')).toBe(
        false,
      );
    }
  });

  it('turns a react fence into a component block and leaves other fences as code', () => {
    const code = 'function App({html, Arco}) { return html`<${Arco.Button}>建群</${Arco.Button}>`; }';
    const result = markdownDocument(empty, '```react\n' + code + '\n```\n\n```js\nconst a = 1;\n```');
    const root = rootOf(result.document);
    expect(root.children.map((node: Record<string, unknown>) => node.type)).toEqual(['component', 'code']);
    expect(root.children[0]).toMatchObject({ code, type: 'component' });
    expect(root.children[0]).not.toHaveProperty('html');
    expect(root.children[0]).not.toHaveProperty('runtime');
    expect(root.children[1]).toMatchObject({ language: 'js', type: 'code' });
    expect(result.statistics.component_blocks).toBe(1);
    expect(result.statistics.html_blocks).toBe(0);
    expect(result.statistics.code_blocks).toBe(2);
  });

  it.each([
    'https://example.com/a?q=1&x=2',
    'http://example.com',
    'mailto:a@example.com',
    '/path',
    './path',
    '../path',
    'docs/page',
    '?note=123',
    '#anchor',
  ])('accepts a safe URL: %s', (url) => {
    expect(isSafeUrl(url)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:bad',
    'data:text/plain,x',
    'file:///tmp/x',
    'tel:123',
    '//example.com',
    '\\\\example.com',
    'java\tscript:bad',
    ' https://example.com',
    'javascript&#58;bad',
    'https://',
    '',
  ])('rejects a URL outside the allowlist: %s', (url) => {
    expect(isSafeUrl(url)).toBe(false);
  });

  it('warns on unsupported syntax and never truncates malformed table cells', () => {
    const result = markdownDocument(
      empty,
      '---\ntitle: 原文\n---\n\n==高亮== $x$\n\n| a | b |\n| --- | --- |\n| one | two | 不可丢失 |',
    );
    expect(textOf(rootOf(result.document))).toContain('title: 原文');
    expect(textOf(rootOf(result.document))).toContain('不可丢失');
    expect(result.warnings.join(' ')).toMatch(/extra cells/);
    expect(result.warnings.join(' ')).toMatch(/YAML/);
    expect(result.warnings.join(' ')).toMatch(/not supported/);
  });

  it('handles empty input and preserves existing content on an empty append', () => {
    const result = markdownDocument(empty, '  \n\n');
    expect(rootOf(result.document).children).toMatchObject([{ type: 'paragraph', children: [] }]);
    expect(result).toMatchObject({ blocks: 0, outline: [], warnings: [] });
    const existing = markdownDocument(empty, '# Keep').document;
    expect(markdownDocument(existing, '', 'append').document).toEqual(existing);
  });
});
