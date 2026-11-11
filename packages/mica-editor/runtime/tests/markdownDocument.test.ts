import {createHeadlessEditor} from '@lexical/headless';
import {$getRoot} from 'lexical';
import {describe, expect, it} from 'vitest';

import {$exportMarkdown, $importMarkdown} from '../src/markdown/markdownDocument';
import {markdownEditableReason} from '../src/markdown/markdownPolicy';
import {MARKDOWN_NODES} from '../src/markdown/transformers';

/**
 * Markdown 模式只在「导入 → 编辑 → 导出」这条链路上改写文本，所以这里盯住往返结果：
 * 常见写法必须原样回到磁盘，不能被排版层的取舍悄悄改掉。
 */
function roundTrip(source: string) {
  const editor = createHeadlessEditor({
    namespace: 'markdown-document-test',
    nodes: MARKDOWN_NODES,
    onError(error) { throw error; },
  });
  editor.update(() => {
    $importMarkdown(source);
  }, {discrete: true});
  return editor.getEditorState().read(() => ({
    blocks: $getRoot().getChildren().map((node) => node.getType()),
    text: $exportMarkdown(source.endsWith('\n')),
  }));
}

describe('Markdown document round trip', () => {
  it('does not turn blank separator lines into empty paragraphs', () => {
    const {blocks} = roundTrip('# 标题\n\n正文\n\n- 第一项\n- 第二项\n');
    expect(blocks).toEqual(['heading', 'paragraph', 'list']);
  });

  it.each([
    ['段落与列表', '# 测试角色\n\n这是一个 **Markdown** 角色。\n\n- 第一项\n- 第二项\n'],
    ['段内换行', '第一行\n第二行\n\n下一段\n'],
    ['硬换行', '第一行  \n第二行\n'],
    ['代码块', '```js\nconst a = 1;\n\nconst b = 2;\n```\n'],
    ['引用', '> 引用一行\n> 引用二行\n'],
    ['引用内空行', '> 第一段\n>\n> 第二段\n'],
    ['引用内列表', '> 只依据两份 PRD：\n> - 《资金相关》`2210258582940`（下称 **资金PRD**）\n> - 《C 端产品方案》`2210222573447`（下称 **C端PRD**）\n>\n> 文中 `「资金PRD §五」` 是原文位置。\n'],
    ['引用内代码块', '> 说明\n>\n> ```js\n> const a = 1\n> ```\n'],
    ['嵌套引用', '> 外层\n> > 内层\n'],
    ['GFM 表格', '| 名称 | 状态 |\n| --- | --- |\n| A | 完成 |\n'],
    ['表格对齐', '| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| a | b | c |\n'],
    ['表格单元格行内格式', '| 格式 | 转义 |\n| --- | --- |\n| **加粗** 与 `a\\|b` | 左\\|右 |\n'],
    ['引用内表格', '> | 名称 | 状态 |\n> | --- | --- |\n> | A | 完成 |\n'],
    ['行内格式与链接', '**粗** 与 *斜* 与 `代码` 与 [链接](https://example.com)\n'],
    ['任务列表', '- [ ] 待办\n- [x] 完成\n'],
    ['没有收尾换行', '# 标题\n\n正文'],
    ['空文档', ''],
  ])('keeps %s byte for byte', (_name, source) => {
    expect(roundTrip(source).text).toBe(source);
  });

  it('reads a quote as blocks so its list is a real list', () => {
    expect(roundTrip('> 说明：\n> - 第一项\n> - 第二项\n').blocks).toEqual(['quote']);
  });

  it('collapses runs of blank lines to a single separator', () => {
    expect(roundTrip('第一段\n\n\n\n第二段\n').text).toBe('第一段\n\n第二段\n');
  });
});

describe('Markdown editable policy', () => {
  it.each([
    ['引用', '> 引用一行\n'],
    ['引用内列表与空行', '> 说明：\n> - 第一项\n>\n> 后一段\n'],
    ['引用内代码块', '> 说明\n>\n> ```js\n> a\n> ```\n'],
    ['嵌套引用', '> 外层\n> > 内层\n'],
  ])('keeps %s editable', (_name, source) => {
    expect(markdownEditableReason(source)).toBeNull();
  });

  it.each([
    ['frontmatter', '---\ntitle: x\n---\n\n正文\n'],
    ['未闭合围栏', '```js\nconst a = 1\n'],
    ['行内 HTML', '文本 <kbd>Enter</kbd>\n'],
    ['图片', '![图](a.png)\n'],
    ['引用式链接', '见 [文档][ref]\n\n[ref]: https://example.com\n'],
    ['列表项直接跟围栏', '- ```js\n  a\n  ```\n'],
  ])('keeps %s as source', (_name, source) => {
    expect(markdownEditableReason(source)).not.toBeNull();
  });
});
