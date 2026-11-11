import {createHeadlessEditor} from '@lexical/headless';
import {$isCodeNode} from '@lexical/code';
import {$getRoot, $getSelection, $isElementNode, $isRangeSelection} from 'lexical';
import {describe, expect, it} from 'vitest';
import {MARKDOWN_NODES} from '../src/markdown/transformers';
import {$importMarkdown, $exportMarkdown} from '../src/markdown/markdownDocument';
import {$insertMarkdownCodeBlock} from '../src/markdown/markdownCommands';

const diagram = 'flowchart LR\n  A[开始] --> B[完成]';

describe('Markdown fenced code insertion', () => {
  it.each([
    ['普通段落', '已有正文\n', 'paragraph', ['paragraph', 'code']],
    ['列表', '- 已有任务\n', 'list', ['list', 'code']],
    ['表格单元格', '| 标题 |\n| --- |\n| 内容 |\n', 'table', ['table', 'code']],
    ['引用', '> 引用正文\n', 'quote', ['quote', 'code']],
  ])('inserts a real attached block after %s without replacing existing text', (_name, markdown, blockType, expectedTypes) => {
    const editor = createHeadlessEditor({namespace: 'markdown-commands', nodes: MARKDOWN_NODES, onError: error => {throw error;}});
    editor.update(() => {
      $importMarkdown(markdown);
      const block = $getRoot().getFirstChildOrThrow();
      expect(block.getType()).toBe(blockType);
      if (!$isElementNode(block)) throw new Error('Expected block');
      const text = block.getAllTextNodes().at(-1)!;
      text.selectEnd();
      $insertMarkdownCodeBlock('mermaid', diagram);
    }, {discrete: true});
    editor.read('latest', () => {
      expect($getRoot().getChildren().map(node => node.getType())).toEqual(expectedTypes);
      const code = $getRoot().getLastChildOrThrow();
      expect($isCodeNode(code) && code.getLanguage()).toBe('mermaid');
      expect(code.isAttached()).toBe(true);
      const selection = $getSelection();
      expect($isRangeSelection(selection) && selection.anchor.getNode().isAttached()).toBe(true);
      expect($exportMarkdown(true)).toBe(`${markdown.trimEnd()}\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n`);
    });
  });
  it('can insert before the first selection or replace an empty paragraph', () => {
    const editor = createHeadlessEditor({namespace: 'markdown-commands-empty', nodes: MARKDOWN_NODES, onError: error => {throw error;}});
    editor.update(() => $insertMarkdownCodeBlock('mermaid', diagram), {discrete: true});
    editor.read('latest', () => expect($getRoot().getChildren().map(node => node.getType())).toEqual(['code']));
    editor.update(() => {$importMarkdown('');$getRoot().selectEnd();$insertMarkdownCodeBlock('mermaid', diagram);}, {discrete: true});
    editor.read('latest', () => expect($getRoot().getChildren().map(node => node.getType())).toEqual(['code']));
  });
});
