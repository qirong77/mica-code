import {$createCodeHighlightNode, $createCodeNode, CodeExtension, CodeHighlightNode, CodeNode} from '@lexical/code';
import {buildEditorFromExtensions} from '@lexical/extension';
import {HeadlessExtension} from '@lexical/headless';
import {createEmptyHistoryState, registerHistory} from '@lexical/history';
import {$createLinkNode, $isLinkNode, LinkNode} from '@lexical/link';
import {$createListItemNode, $createListNode, $isListItemNode, $isListNode, CheckListExtension, ListExtension, ListItemNode, ListNode, type ListType} from '@lexical/list';
import {$createHeadingNode, $createQuoteNode, $isHeadingNode, HeadingNode, type HeadingTagType, QuoteNode, RichTextExtension} from '@lexical/rich-text';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isParagraphNode,
  $isRangeSelection,
  $setCompositionKey,
  $setSelection,
  DELETE_CHARACTER_COMMAND,
  defineExtension,
  INSERT_PARAGRAPH_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalCommand,
  type LexicalEditor,
  REDO_COMMAND,
  UNDO_COMMAND,
} from 'lexical';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {registerNotebookBlockEditing} from '../src/workspace/blockEditing';
import {$readDocumentStyle, $updateDocumentStyle} from '../src/workspace/documentStyle';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const headings: HeadingTagType[] = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
type BlockKind = HeadingTagType | 'quote';
const blocks: BlockKind[] = [...headings, 'quote'];
const listTypes: ListType[] = ['number', 'bullet', 'check'];
const content = '标题 1';

function makeEditor({native = true, notebook = true, parentEditor}: {
  native?: boolean;
  notebook?: boolean;
  parentEditor?: LexicalEditor;
} = {}) {
  // Use the same extension registrations as the notebook, including the
  // CodeExtension Enter handler, rather than replacing them with test mocks.
  const editor = buildEditorFromExtensions(defineExtension({
    name: '@test/notebook-block-editing',
    namespace: 'notebook-block-editing',
    parentEditor,
    dependencies: native
      ? [HeadlessExtension, RichTextExtension, ListExtension, CheckListExtension, CodeExtension]
      : [HeadlessExtension],
    nodes: [HeadingNode, QuoteNode, LinkNode, ListNode, ListItemNode, CodeNode, CodeHighlightNode],
    onError(error) { throw error; },
  }));
  cleanups.push(() => editor[Symbol.dispose]());
  if (notebook) cleanups.push(registerNotebookBlockEditing(editor));
  return editor;
}

function update(editor: LexicalEditor, action: () => void) {
  editor.update(action, {discrete: true});
}

function dispatch<T>(editor: LexicalEditor, command: LexicalCommand<T>, payload: T): boolean {
  let handled = false;
  update(editor, () => { handled = editor.dispatchCommand(command, payload); });
  return handled;
}

function keyEvent(key = 'Enter', modifiers: Partial<KeyboardEvent> = {}) {
  return {
    key, keyCode: key === 'Backspace' ? 8 : 13, target: null,
    altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
    defaultPrevented: false, isComposing: false, preventDefault: vi.fn(),
    ...modifiers,
  } as unknown as KeyboardEvent;
}

function $selectText(key: string, anchor: number, focus = anchor) {
  const selection = $createRangeSelection();
  selection.anchor.set(key, anchor, 'text');
  selection.focus.set(key, focus, 'text');
  $setSelection(selection);
}

function seedBlock(editor: LexicalEditor, kind: BlockKind, offset = 0, text = content) {
  let key = '';
  let textKey = '';
  update(editor, () => {
    const block = kind === 'quote' ? $createQuoteNode() : $createHeadingNode(kind);
    key = block.getKey();
    if (text) {
      const child = $createTextNode(text);
      textKey = child.getKey();
      block.append(child);
    }
    $getRoot().clear().append(block);
    if (text) $selectText(textKey, offset);
    else block.selectStart();
  });
  return {key, textKey};
}

function readBlocks(editor: LexicalEditor) {
  return editor.read('latest', () => $getRoot().getChildren().map(node => [node.getType(), node.getTextContent()]));
}

function expectCaretAtStart(editor: LexicalEditor, textKey?: string) {
  editor.read('latest', () => {
    const selection = $getSelection();
    expect($isRangeSelection(selection) && selection.isCollapsed()).toBe(true);
    if (!$isRangeSelection(selection)) throw new Error('Expected a range selection');
    expect(selection.anchor.offset).toBe(0);
    if (textKey) expect(selection.anchor.key).toBe(textKey);
    expect(selection.anchor.getNode().isAttached()).toBe(true);
  });
}

describe('Lexical 0.53 native block boundaries', () => {
  it.each(['h1', 'quote'] as const)('documents the extra empty block from native %s Enter at the start', kind => {
    const editor = makeEditor({notebook: false});
    seedBlock(editor, kind);
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
    expect(readBlocks(editor)).toEqual(kind === 'quote'
      ? [['quote', ''], ['paragraph', content]]
      : [['paragraph', ''], ['heading', content]]);
  });

  it('documents native Backspace keeping a nonempty first heading', () => {
    const editor = makeEditor({notebook: false});
    seedBlock(editor, 'h1');
    // Native character deletion requires a browser Selection. Exercise the
    // heading's boundary hook directly in this headless baseline instead.
    update(editor, () => {
      const heading = $getRoot().getFirstChildOrThrow();
      if (!$isHeadingNode(heading)) throw new Error('Expected heading');
      expect(heading.collapseAtStart()).toBe(true);
    });
    expect(readBlocks(editor)).toEqual([['heading', content]]);
  });
});

describe('notebook block style removal', () => {
  it.each(blocks)('converts %s at its text start on Enter without adding a line', kind => {
    const editor = makeEditor();
    const {textKey} = seedBlock(editor, kind);
    const event = keyEvent();
    expect(dispatch(editor, KEY_ENTER_COMMAND, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(readBlocks(editor)).toEqual([['paragraph', content]]);
    expectCaretAtStart(editor, textKey);
  });

  it.each(blocks)('handles beforeinput paragraph insertion at the start of %s', kind => {
    const editor = makeEditor();
    const {textKey} = seedBlock(editor, kind);
    expect(dispatch(editor, INSERT_PARAGRAPH_COMMAND, undefined)).toBe(true);
    expect(readBlocks(editor)).toEqual([['paragraph', content]]);
    expectCaretAtStart(editor, textKey);
  });

  it.each(blocks)('replaces empty %s with one empty paragraph on Enter', kind => {
    const editor = makeEditor();
    seedBlock(editor, kind, 0, '');
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
    expect(readBlocks(editor)).toEqual([['paragraph', '']]);
    expectCaretAtStart(editor);
  });

  it.each(blocks)('clears %s on Backspace at the start without merging into the previous paragraph', kind => {
    const editor = makeEditor();
    const {key, textKey} = seedBlock(editor, kind);
    update(editor, () => {
      const block = $getNodeByKey(key)!;
      block.insertBefore($createParagraphNode().append($createTextNode('前文')));
      block.insertAfter($createParagraphNode().append($createTextNode('后文')));
    });
    const event = keyEvent('Backspace');
    expect(dispatch(editor, KEY_BACKSPACE_COMMAND, event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(readBlocks(editor)).toEqual([['paragraph', '前文'], ['paragraph', content], ['paragraph', '后文']]);
    expectCaretAtStart(editor, textKey);
  });

  it.each(blocks)('handles beforeinput backward deletion at the start of %s', kind => {
    const editor = makeEditor();
    const {textKey} = seedBlock(editor, kind);
    expect(dispatch(editor, DELETE_CHARACTER_COMMAND, true)).toBe(true);
    expect(readBlocks(editor)).toEqual([['paragraph', content]]);
    expectCaretAtStart(editor, textKey);
  });

  it.each(['h1', 'quote'] as const)('preserves explicit inline styles and links when removing %s', kind => {
    const editor = makeEditor();
    let linkKey = '';
    let textKey = '';
    update(editor, () => {
      const text = $createTextNode('链接').toggleFormat('bold').toggleFormat('italic').setStyle('color: red; font-size: 18px;');
      textKey = text.getKey();
      const link = $createLinkNode('https://example.com').append(text);
      linkKey = link.getKey();
      const block = kind === 'quote' ? $createQuoteNode() : $createHeadingNode(kind);
      block.setFormat('center').setDirection('rtl').setStyle('font-size: 32px;');
      $getRoot().clear().append(block.append(link, $createTextNode(' 正文')));
      text.selectStart();
      $updateDocumentStyle({bodySize: 20, lineHeight: 2});
    });
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
    editor.read('latest', () => {
      const paragraph = $getRoot().getFirstChildOrThrow();
      expect($isParagraphNode(paragraph)).toBe(true);
      if (!$isParagraphNode(paragraph)) throw new Error('Expected paragraph');
      expect(paragraph.getStyle()).toBe('');
      expect(paragraph.getFormatType()).toBe('center');
      expect(paragraph.getDirection()).toBe('rtl');
      const link = $getNodeByKey(linkKey);
      expect($isLinkNode(link) && link.getURL()).toBe('https://example.com');
      const text = paragraph.getAllTextNodes()[0];
      expect(text.getKey()).toBe(textKey);
      expect(text.hasFormat('bold')).toBe(true);
      expect(text.hasFormat('italic')).toBe(true);
      expect(text.getStyle()).toBe('color: red; font-size: 18px;');
      expect($readDocumentStyle()).toMatchObject({bodySize: 20, lineHeight: 2});
    });
    expectCaretAtStart(editor, textKey);
  });

  it.each(['h1', 'quote'] as const)('maps element-point selection at the start of %s to the paragraph', kind => {
    const editor = makeEditor();
    const {key} = seedBlock(editor, kind);
    update(editor, () => {
      const selection = $createRangeSelection();
      selection.anchor.set(key, 0, 'element');
      selection.focus.set(key, 0, 'element');
      $setSelection(selection);
    });
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
    expect(readBlocks(editor)).toEqual([['paragraph', content]]);
    expectCaretAtStart(editor);
  });

  it('makes the conversion one undoable action with the caret restored on undo and redo', () => {
    const editor = makeEditor();
    const history = createEmptyHistoryState();
    cleanups.push(registerHistory(editor, history, 1000));
    const {textKey} = seedBlock(editor, 'h2');
    const depth = history.undoStack.length;
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
    expect(history.undoStack.length).toBe(depth + 1);
    dispatch(editor, UNDO_COMMAND, undefined);
    expect(readBlocks(editor)).toEqual([['heading', content]]);
    expectCaretAtStart(editor, textKey);
    dispatch(editor, REDO_COMMAND, undefined);
    expect(readBlocks(editor)).toEqual([['paragraph', content]]);
    expectCaretAtStart(editor, textKey);
  });
});

describe('native text splitting and soft breaks', () => {
  it.each(headings)('retains %s on both halves of a middle split', kind => {
    const editor = makeEditor();
    seedBlock(editor, kind, 2);
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
    expect(readBlocks(editor)).toEqual([['heading', '标题'], ['heading', ' 1']]);
    editor.read('latest', () => {
      for (const block of $getRoot().getChildren()) expect($isHeadingNode(block) && block.getTag()).toBe(kind);
    });
  });

  it.each(headings)('creates normal body text after %s at the end', kind => {
    const editor = makeEditor();
    seedBlock(editor, kind, content.length);
    update(editor, () => $updateDocumentStyle({bodySize: 18, lineHeight: 2}));
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
    expect(readBlocks(editor)).toEqual([['heading', content], ['paragraph', '']]);
    editor.read('latest', () => {
      const paragraph = $getRoot().getLastChildOrThrow();
      expect($isParagraphNode(paragraph) && paragraph.getStyle()).toBe('');
      expect($isParagraphNode(paragraph) && paragraph.getTextStyle()).toBe('');
      expect($readDocumentStyle()).toMatchObject({bodySize: 18, lineHeight: 2});
      const selection = $getSelection();
      expect($isRangeSelection(selection) && selection.anchor.key).toBe(paragraph.getKey());
    });
  });

  it.each([2, content.length])('keeps native quote splitting into a following paragraph at offset %s', offset => {
    const editor = makeEditor();
    seedBlock(editor, 'quote', offset);
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
    expect(readBlocks(editor)).toEqual([['quote', content.slice(0, offset)], ['paragraph', content.slice(offset)]]);
  });

  it.each(blocks)('keeps Shift+Enter inside %s as a soft break', kind => {
    const editor = makeEditor();
    seedBlock(editor, kind);
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent('Enter', {shiftKey: true}));
    expect(readBlocks(editor)).toEqual([[kind === 'quote' ? 'quote' : 'heading', `\n${content}`]]);
    editor.read('latest', () => {
      const block = $getRoot().getFirstChildOrThrow();
      expect($isElementNode(block) && block.getFirstChild()?.getType()).toBe('linebreak');
    });
  });

  it.each(['h1', 'quote'] as const)('leaves non-collapsed %s replacement to the native handler', kind => {
    const results = [false, true].map(notebook => {
      const editor = makeEditor({notebook});
      const {textKey} = seedBlock(editor, kind);
      update(editor, () => $selectText(textKey, 0, 2));
      dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
      return editor.getEditorState().toJSON();
    });
    expect(results[1]).toEqual(results[0]);
  });
});

describe('narrow command boundaries', () => {
  it.each([
    {shiftKey: true}, {ctrlKey: true}, {metaKey: true}, {altKey: true},
    {isComposing: true}, {keyCode: 229}, {defaultPrevented: true},
  ])('does not intercept modified or composing key events: %j', modifiers => {
    const editor = makeEditor({native: false});
    seedBlock(editor, 'h1');
    const before = editor.getEditorState().toJSON();
    for (const key of ['Enter', 'Backspace']) {
      const event = keyEvent(key, modifiers);
      const handled = key === 'Enter'
        ? dispatch(editor, KEY_ENTER_COMMAND, event)
        : dispatch(editor, KEY_BACKSPACE_COMMAND, event);
      expect(handled).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(editor.getEditorState().toJSON()).toEqual(before);
  });

  it('leaves the real editor composition state intact for key and beforeinput commands', () => {
    const editor = makeEditor({native: false});
    const {textKey} = seedBlock(editor, 'h1');
    update(editor, () => $setCompositionKey(textKey));
    const before = editor.getEditorState().toJSON();
    expect(editor.isComposing()).toBe(true);
    expect(dispatch(editor, KEY_ENTER_COMMAND, keyEvent())).toBe(false);
    expect(dispatch(editor, KEY_BACKSPACE_COMMAND, keyEvent('Backspace'))).toBe(false);
    expect(dispatch(editor, INSERT_PARAGRAPH_COMMAND, undefined)).toBe(false);
    expect(dispatch(editor, DELETE_CHARACTER_COMMAND, true)).toBe(false);
    expect(editor.getEditorState().toJSON()).toEqual(before);
    update(editor, () => $setCompositionKey(null));
  });

  it('does not mutate a read-only document even when a command is dispatched directly', () => {
    const editor = makeEditor({native: false});
    seedBlock(editor, 'h1');
    editor.setEditable(false);
    const before = editor.getEditorState().toJSON();
    expect(dispatch(editor, KEY_ENTER_COMMAND, keyEvent())).toBe(false);
    expect(dispatch(editor, KEY_BACKSPACE_COMMAND, keyEvent('Backspace'))).toBe(false);
    expect(dispatch(editor, INSERT_PARAGRAPH_COMMAND, undefined)).toBe(false);
    expect(dispatch(editor, DELETE_CHARACTER_COMMAND, true)).toBe(false);
    expect(editor.getEditorState().toJSON()).toEqual(before);
  });

  it('does not intercept ranges, node selections, forward deletion or Backspace in the middle', () => {
    const editor = makeEditor({native: false});
    const {key, textKey} = seedBlock(editor, 'h1');
    expect(dispatch(editor, DELETE_CHARACTER_COMMAND, false)).toBe(false);
    update(editor, () => $selectText(textKey, 1));
    expect(dispatch(editor, KEY_BACKSPACE_COMMAND, keyEvent('Backspace'))).toBe(false);
    update(editor, () => $selectText(textKey, 0, 2));
    expect(dispatch(editor, KEY_ENTER_COMMAND, keyEvent())).toBe(false);
    expect(dispatch(editor, INSERT_PARAGRAPH_COMMAND, undefined)).toBe(false);
    expect(dispatch(editor, DELETE_CHARACTER_COMMAND, true)).toBe(false);
    update(editor, () => {
      const selection = $createNodeSelection();
      selection.add(key);
      $setSelection(selection);
    });
    expect(dispatch(editor, KEY_ENTER_COMMAND, keyEvent())).toBe(false);
    expect(readBlocks(editor)).toEqual([['heading', content]]);
  });

  it('does not mistake the start of a later inline link for the start of its heading', () => {
    const editor = makeEditor({native: false});
    update(editor, () => {
      const text = $createTextNode('链接');
      $getRoot().clear().append($createHeadingNode('h1').append(
        $createTextNode('前面的字'), $createLinkNode('https://example.com').append(text),
      ));
      text.selectStart();
    });
    const before = editor.getEditorState().toJSON();
    expect(dispatch(editor, KEY_ENTER_COMMAND, keyEvent())).toBe(false);
    expect(dispatch(editor, KEY_BACKSPACE_COMMAND, keyEvent('Backspace'))).toBe(false);
    expect(editor.getEditorState().toJSON()).toEqual(before);
  });

  it('does not flatten a quote configured as a shadow root containing blocks', () => {
    const editor = makeEditor({native: false});
    update(editor, () => {
      const quote = $createQuoteNode({shadowRoot: true}).append($createParagraphNode().append($createTextNode(content)));
      $getRoot().clear().append(quote);
      quote.select(0, 0);
    });
    const before = editor.getEditorState().toJSON();
    expect(dispatch(editor, KEY_ENTER_COMMAND, keyEvent())).toBe(false);
    expect(editor.getEditorState().toJSON()).toEqual(before);
  });

  it('does not apply notebook behavior to another composer', () => {
    const notebook = makeEditor();
    const otherComposer = makeEditor({notebook: false});
    seedBlock(notebook, 'h1');
    seedBlock(otherComposer, 'h1');
    dispatch(otherComposer, KEY_ENTER_COMMAND, keyEvent());
    expect(readBlocks(otherComposer)).toEqual([['paragraph', ''], ['heading', content]]);
    expect(readBlocks(notebook)).toEqual([['heading', content]]);
  });

  it('ignores caption editor commands bubbling to the notebook', () => {
    const parent = makeEditor({native: false});
    seedBlock(parent, 'h1');
    const caption = makeEditor({native: false, notebook: false, parentEditor: parent});
    seedBlock(caption, 'h2');
    const beforeParent = parent.getEditorState().toJSON();
    const beforeCaption = caption.getEditorState().toJSON();
    expect(dispatch(caption, KEY_ENTER_COMMAND, keyEvent())).toBe(false);
    expect(dispatch(caption, KEY_BACKSPACE_COMMAND, keyEvent('Backspace'))).toBe(false);
    expect(dispatch(caption, INSERT_PARAGRAPH_COMMAND, undefined)).toBe(false);
    expect(dispatch(caption, DELETE_CHARACTER_COMMAND, true)).toBe(false);
    expect(parent.getEditorState().toJSON()).toEqual(beforeParent);
    expect(caption.getEditorState().toJSON()).toEqual(beforeCaption);
  });

  it('unregisters all command handlers on unmount', () => {
    const editor = makeEditor({native: false, notebook: false});
    seedBlock(editor, 'h1');
    const unregister = registerNotebookBlockEditing(editor);
    unregister();
    expect(dispatch(editor, KEY_ENTER_COMMAND, keyEvent())).toBe(false);
    expect(dispatch(editor, KEY_BACKSPACE_COMMAND, keyEvent('Backspace'))).toBe(false);
    expect(dispatch(editor, INSERT_PARAGRAPH_COMMAND, undefined)).toBe(false);
    expect(dispatch(editor, DELETE_CHARACTER_COMMAND, true)).toBe(false);
    expect(readBlocks(editor)).toEqual([['heading', content]]);
  });
});

describe('native list and code editing remains available', () => {
  function seedList(editor: LexicalEditor, type: ListType, text: string, nested = false) {
    let key = '';
    update(editor, () => {
      const item = $createListItemNode(type === 'check' ? true : undefined);
      key = item.getKey();
      if (text) item.append($createTextNode(text));
      const list = $createListNode(type);
      if (nested) list.append($createListItemNode().append($createTextNode('外层')));
      $getRoot().clear().append(list.append(item));
      if (nested) item.setIndent(1);
      item.selectStart();
    });
    return key;
  }

  it.each(listTypes)('exits an empty top-level %s list item to body text', type => {
    const editor = makeEditor();
    seedList(editor, type, '');
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
    expect(readBlocks(editor)).toEqual([['paragraph', '']]);
    expectCaretAtStart(editor);
  });

  it.each(listTypes)('exits a whitespace-only %s list item through beforeinput', type => {
    const editor = makeEditor();
    seedList(editor, type, '   ');
    dispatch(editor, INSERT_PARAGRAPH_COMMAND, undefined);
    expect(readBlocks(editor)).toEqual([['paragraph', '']]);
  });

  it.each(listTypes)('outdents an empty nested %s item on Enter before exiting the list', type => {
    const editor = makeEditor();
    seedList(editor, type, '', true);
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
    editor.read('latest', () => {
      const list = $getRoot().getFirstChildOrThrow();
      expect($isListNode(list) && list.getListType()).toBe(type);
      const selection = $getSelection();
      const item = $isRangeSelection(selection) ? selection.anchor.getNode() : null;
      expect($isListItemNode(item) && item.getIndent()).toBe(0);
      expect($isListItemNode(item) && item.getTextContent()).toBe('');
      expect($isListNode(list) && list.getChildrenSize()).toBe(2);
    });
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
    expect(readBlocks(editor)).toEqual([['list', '外层'], ['paragraph', '']]);
  });

  it.each(listTypes)('outdents a nonempty nested %s item on Backspace without removing text', type => {
    const editor = makeEditor();
    const key = seedList(editor, type, '子项', true);
    dispatch(editor, KEY_BACKSPACE_COMMAND, keyEvent('Backspace'));
    editor.read('latest', () => {
      const item = $getNodeByKey(key);
      expect($isListItemNode(item) && item.getIndent()).toBe(0);
      expect(item?.getTextContent()).toBe('子项');
      expect($isListNode(item?.getParent()) && item?.getParent()?.getKey()).toBe($getRoot().getFirstChildOrThrow().getKey());
    });
  });

  function seedCode(editor: LexicalEditor, text: string, offset = text.length) {
    update(editor, () => {
      const code = $createCodeNode('javascript');
      if (text) code.append($createCodeHighlightNode(text));
      $getRoot().clear().append(code);
      if (text) $selectText(code.getFirstChildOrThrow().getKey(), offset);
      else code.selectStart();
    });
  }

  it.each([0, 3, 7])('retains Enter inside code at offset %s', offset => {
    const editor = makeEditor();
    const text = 'const x';
    seedCode(editor, text, offset);
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
    expect(readBlocks(editor)).toEqual([['code', `${text.slice(0, offset)}\n${text.slice(offset)}`]]);
  });

  it('retains native empty-code Enter and code indentation', () => {
    const editor = makeEditor();
    seedCode(editor, '');
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
    expect(readBlocks(editor)).toEqual([['code', '\n']]);
    seedCode(editor, '  call()');
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
    expect(readBlocks(editor)).toEqual([['code', '  call()\n  ']]);
  });

  it('retains the native exit after two trailing code line breaks', () => {
    const editor = makeEditor();
    seedCode(editor, 'const x = 1;');
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
    expect(readBlocks(editor)).toEqual([['code', 'const x = 1;\n\n']]);
    dispatch(editor, KEY_ENTER_COMMAND, keyEvent());
    expect(readBlocks(editor)).toEqual([['code', 'const x = 1;'], ['paragraph', '']]);
    expectCaretAtStart(editor);
  });
});
