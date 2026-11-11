import {CodeNode} from '@lexical/code';
import {createHeadlessEditor} from '@lexical/headless';
import {LinkNode} from '@lexical/link';
import {ListItemNode, ListNode} from '@lexical/list';
import {HeadingNode, QuoteNode} from '@lexical/rich-text';
import {$getRoot} from 'lexical';
import {describe, expect, it} from 'vitest';

import {$exportMarkdown, $importMarkdown} from '../src/markdown/markdownDocument';

/**
 * Markdown 模式只在「导入 → 编辑 → 导出」这条链路上改写文本，所以这里盯住往返结果：
 * 常见写法必须原样回到磁盘，不能被排版层的取舍悄悄改掉。
 */
function roundTrip(source: string) {
  const editor = createHeadlessEditor({
    namespace: 'markdown-document-test',
    nodes: [CodeNode, HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode],
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
    ['行内格式与链接', '**粗** 与 *斜* 与 `代码` 与 [链接](https://example.com)\n'],
    ['任务列表', '- [ ] 待办\n- [x] 完成\n'],
    ['没有收尾换行', '# 标题\n\n正文'],
    ['空文档', ''],
  ])('keeps %s byte for byte', (_name, source) => {
    expect(roundTrip(source).text).toBe(source);
  });

  it('collapses runs of blank lines to a single separator', () => {
    expect(roundTrip('第一段\n\n\n\n第二段\n').text).toBe('第一段\n\n第二段\n');
  });
});
