// @vitest-environment happy-dom

import {CodeExtension, CodeHighlightNode, CodeNode} from '@lexical/code';
import {buildEditorFromExtensions} from '@lexical/extension';
import {HeadlessExtension} from '@lexical/headless';
import {$isListNode, CheckListExtension, ListExtension, ListItemNode, ListNode} from '@lexical/list';
import {$createHeadingNode, $isHeadingNode, HeadingNode, QuoteNode, RichTextExtension} from '@lexical/rich-text';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  defineExtension,
  type ElementNode,
  type LexicalEditor,
} from 'lexical';
import {afterEach, describe, expect, it} from 'vitest';

import {
  $convertBlockShape,
  $deleteTopLevelBlock,
  $selectEntireBlock,
  $shiftBlockIndent,
} from '../src/playground/plugins/DraggableBlockPlugin/blockMenuActions';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function makeEditor() {
  const editor = buildEditorFromExtensions(defineExtension({
    name: '@test/draggable-block-menu',
    namespace: 'draggable-block-menu',
    dependencies: [HeadlessExtension, RichTextExtension, ListExtension, CheckListExtension, CodeExtension],
    nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, CodeHighlightNode],
    onError(error) { throw error; },
  }));
  cleanups.push(() => editor[Symbol.dispose]());
  return editor;
}

function update(editor: LexicalEditor, action: () => void) {
  editor.update(action, {discrete: true});
}

function seedParagraph(editor: LexicalEditor, text = '正文') {
  let block: ElementNode | null = null;
  update(editor, () => {
    block = $createParagraphNode().append($createTextNode(text));
    $getRoot().clear().append(block);
    block.selectStart();
  });
  return block!;
}

function readTopLevel(editor: LexicalEditor) {
  // Node getters need an active editor state, so read the text in the same pass.
  return editor.read('latest', () => $getRoot().getChildren().map(block => block.getTextContent()));
}

describe('block menu actions', () => {
  it('deletes a top-level block and focuses the next, then the previous block', () => {
    const editor = makeEditor();
    let first: ElementNode;
    let middle: ElementNode;
    let last: ElementNode;
    update(editor, () => {
      first = $createParagraphNode().append($createTextNode('前'));
      middle = $createParagraphNode().append($createTextNode('中'));
      last = $createParagraphNode().append($createTextNode('后'));
      $getRoot().clear().append(first, middle, last);
    });

    update(editor, () => expect($deleteTopLevelBlock(middle)).toBe(true));
    expect(readTopLevel(editor)).toEqual(['前', '后']);
    editor.read('latest', () => {
      const selection = $getSelection();
      expect($isRangeSelection(selection) && selection.anchor.getNode().getTextContent()).toBe('后');
      expect($isRangeSelection(selection) && selection.anchor.offset).toBe(0);
    });

    update(editor, () => expect($deleteTopLevelBlock(last!)).toBe(true));
    editor.read('latest', () => {
      const selection = $getSelection();
      expect($isRangeSelection(selection) && selection.anchor.getNode().getTextContent()).toBe('前');
      expect($isRangeSelection(selection) && selection.anchor.offset).toBe(0);
    });
  });

  it('replaces a document emptied by deletion with a paragraph and focuses it', () => {
    const editor = makeEditor();
    const block = seedParagraph(editor);

    update(editor, () => expect($deleteTopLevelBlock(block)).toBe(true));
    editor.read('latest', () => {
      const children = $getRoot().getChildren();
      expect(children).toHaveLength(1);
      expect(children[0].getType()).toBe('paragraph');
      const selection = $getSelection();
      expect($isRangeSelection(selection) && selection.anchor.key).toBe(children[0].getKey());
      expect($isRangeSelection(selection) && selection.anchor.offset).toBe(0);
    });
  });

  it('does not delete the first h1 when protectFirstBlock is enabled', () => {
    const editor = makeEditor();
    let title: ElementNode;
    let body: ElementNode;
    update(editor, () => {
      title = $createHeadingNode('h1').append($createTextNode('标题'));
      body = $createParagraphNode().append($createTextNode('正文'));
      $getRoot().clear().append(title, body);
      title.selectStart();
    });

    update(editor, () => expect($deleteTopLevelBlock(title!, {protectFirstBlock: true})).toBe(false));
    expect(readTopLevel(editor)).toEqual(['标题', '正文']);
    editor.read('latest', () => expect($getRoot().getFirstChild()?.getKey()).toBe(title!.getKey()));
  });

  it('clamps indentation to the 0..5 range', () => {
    const editor = makeEditor();
    const block = seedParagraph(editor);

    update(editor, () => {
      expect($shiftBlockIndent(block, -1)).toBe(false);
      expect(block.getIndent()).toBe(0);
      expect($shiftBlockIndent(block, 1)).toBe(true);
      expect(block.getIndent()).toBe(1);
      block.setIndent(5);
      expect($shiftBlockIndent(block, 1)).toBe(false);
      expect(block.getIndent()).toBe(5);
      expect($shiftBlockIndent(block, -1)).toBe(true);
      expect(block.getIndent()).toBe(4);
    });
  });

  it.each([
    ['paragraph', 'paragraph'],
    ['h2', 'heading'],
    ['quote', 'quote'],
    ['code', 'code'],
  ] as const)('converts a block to %s while retaining its text', (shape, expectedType) => {
    const editor = makeEditor();
    let source: ElementNode;
    update(editor, () => {
      source = (shape === 'paragraph' ? $createHeadingNode('h2') : $createParagraphNode()).append($createTextNode('保留'));
      $getRoot().append(source);
    });

    update(editor, () => {
      const converted = $convertBlockShape(source!, shape);
      expect(converted?.getType()).toBe(expectedType);
      expect(converted?.getTextContent()).toBe('保留');
    });
  });

  it('converts a block to an ordered list', () => {
    const editor = makeEditor();
    const source = seedParagraph(editor, '列表项');

    update(editor, () => {
      const converted = $convertBlockShape(source, 'number');
      expect($isListNode(converted)).toBe(true);
      expect(converted?.getTextContent()).toBe('列表项');
      expect(converted?.getType()).toBe('list');
    });
  });

  it('does not convert the protected first h1', () => {
    const editor = makeEditor();
    let title: ElementNode;
    update(editor, () => {
      title = $createHeadingNode('h1').append($createTextNode('标题'));
      $getRoot().clear().append(title);
    });

    update(editor, () => expect($convertBlockShape(title!, 'paragraph', {protectFirstBlock: true})).toBeNull());
    editor.read('latest', () => {
      const first = $getRoot().getFirstChild();
      expect($isHeadingNode(first) && first.getTag()).toBe('h1');
    });
  });

  it('selects the complete block range for copy and cut actions', () => {
    const editor = makeEditor();
    const block = seedParagraph(editor, '整块内容');

    update(editor, () => expect($selectEntireBlock(block)).toBe(true));
    editor.read('latest', () => {
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if (!$isRangeSelection(selection)) return;
      expect(selection.anchor.key).toBe(block.getKey());
      expect(selection.anchor.type).toBe('element');
      expect(selection.anchor.offset).toBe(0);
      expect(selection.focus.key).toBe(block.getKey());
      expect(selection.focus.type).toBe('element');
      expect(selection.focus.offset).toBe(block.getChildrenSize());
    });
  });
});
