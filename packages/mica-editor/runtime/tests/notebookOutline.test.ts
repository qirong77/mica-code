import {$createCodeNode, CodeNode} from '@lexical/code';
import {buildEditorFromExtensions} from '@lexical/extension';
import {createHeadlessEditor} from '@lexical/headless';
import {$createHeadingNode, $createQuoteNode, HeadingNode, type HeadingTagType, QuoteNode} from '@lexical/rich-text';
import {$createTableCellNode, $createTableNode, $createTableRowNode, TableCellNode, TableNode, TableRowNode} from '@lexical/table';
import {$createParagraphNode, $createTextNode, $getRoot, $getSelection, defineExtension, type LexicalEditor} from 'lexical';
import {describe, expect, it, vi} from 'vitest';

import {$createImageNode, ImageNode} from '../src/playground/nodes/ImageNode';
import {$readNotebookOutline} from '../src/workspace/NotebookOutline';

function createEditor() {
  return createHeadlessEditor({
    namespace: 'notebook-outline-test',
    nodes: [HeadingNode, QuoteNode, CodeNode, TableNode, TableRowNode, TableCellNode, ImageNode],
    onError(error) { throw error; },
  });
}
const read = (editor: LexicalEditor) => editor.getEditorState().read($readNotebookOutline);
const createCaptionEditor = () => buildEditorFromExtensions(defineExtension({
  name: 'notebook-outline-caption-test',
  nodes: [HeadingNode],
  onError(error) { throw error; },
}));

describe('Notebook outline metadata', () => {
  it('keeps all six heading levels in document order, excluding table and nested-editor headings', () => {
    const editor = createEditor();
    const expected: {key: string; text: string; level: number}[] = [];
    const caption = createCaptionEditor();
    editor.update(() => {
      const root = $getRoot();
      for (const level of [1, 2, 3, 4, 5, 6]) {
        const heading = $createHeadingNode(`h${level}` as HeadingTagType).append($createTextNode(`  第 ${level} 级  `));
        expected.push({key: heading.getKey(), text: `第 ${level} 级`, level});
        // A heading in an ordinary block container still belongs to this editor.
        root.append(level === 6 ? $createQuoteNode().append(heading) : heading);
        if (level === 2) {
          root.append($createTableNode().append($createTableRowNode().append($createTableCellNode().append(
            $createQuoteNode().append($createHeadingNode('h3').append($createTextNode('表格内标题'))),
          ))));
          const image = $createImageNode({src: 'caption.png', altText: '有图注的图片', showCaption: true, caption});
          root.append($createParagraphNode().append(image));
        }
      }
    }, {discrete: true});
    caption.update(() => {
      $getRoot().clear().append($createHeadingNode('h1').append($createTextNode('图注内标题')));
    }, {discrete: true});

    expect(read(editor).items).toEqual(expected);
    expect(read(editor).blocks).toEqual({table: true, code: false, mermaid: false, image: true});
    caption[Symbol.dispose]();
  });

  it('distinguishes code from Mermaid and tracks the first live key as blocks change', () => {
    const editor = createEditor();
    const caption = createCaptionEditor();
    let firstCode: CodeNode;
    let secondCode: CodeNode;
    let diagram: CodeNode;
    let table: TableNode;
    let image: ImageNode;
    editor.update(() => {
      firstCode = $createCodeNode('javascript').append($createTextNode('const a = 1;'));
      secondCode = $createCodeNode().append($createTextNode('untyped source'));
      diagram = $createCodeNode('mermaid').append($createTextNode('graph TD; A-->B;'));
      table = $createTableNode().append($createTableRowNode().append($createTableCellNode().append($createParagraphNode())));
      image = $createImageNode({src: 'figure.png', altText: '图片', width: 320, height: 180, caption});
      $getRoot().append(firstCode, secondCode, diagram, table, $createParagraphNode().append(image));
    }, {discrete: true});
    expect(read(editor).blocks).toEqual({table: true, code: true, mermaid: true, image: true});
    expect(read(editor).blockKeys).toEqual({table: table!.getKey(), code: firstCode!.getKey(), mermaid: diagram!.getKey(), image: image!.getKey()});

    editor.update(() => {
      firstCode.remove();
      diagram.setLanguage('typescript');
      table.remove();
      image.remove();
    }, {discrete: true});
    expect(read(editor).blocks).toEqual({table: false, code: true, mermaid: false, image: false});
    expect(read(editor).blockKeys).toEqual({table: null, code: secondCode!.getKey(), mermaid: null, image: null});
    caption[Symbol.dispose]();
  });

  it('reads renamed and reordered headings without changing document, selection or editor state', () => {
    const editor = createEditor();
    let first: HeadingNode;
    let second: HeadingNode;
    editor.update(() => {
      first = $createHeadingNode('h1').append($createTextNode('相同标题'));
      second = $createHeadingNode('h2').append($createTextNode('相同标题'));
      $getRoot().append(first, second);
      first.selectEnd();
    }, {discrete: true});
    expect(read(editor).items.map((item) => item.key)).toEqual([first!.getKey(), second!.getKey()]);
    editor.update(() => {
      second.setTag('h6');
      second.clear().append($createTextNode('新标题'));
      first.insertBefore(second);
    }, {discrete: true});
    const state = editor.getEditorState();
    const serialized = state.toJSON();
    const selection = state.read(() => $getSelection()?.clone() ?? null);
    const onUpdate = vi.fn();
    const unregister = editor.registerUpdateListener(onUpdate);

    expect(read(editor).items).toEqual([
      {key: second!.getKey(), text: '新标题', level: 6},
      {key: first!.getKey(), text: '相同标题', level: 1},
    ]);
    read(editor);
    expect(editor.getEditorState()).toBe(state);
    expect(state.toJSON()).toEqual(serialized);
    expect(state.read(() => $getSelection()?.is(selection))).toBe(true);
    expect(onUpdate).not.toHaveBeenCalled();
    unregister();
  });
});
