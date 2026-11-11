import {$createCodeHighlightNode, $createCodeNode, CodeHighlightNode, CodeNode} from '@lexical/code';
import {createHeadlessEditor} from '@lexical/headless';
import {createEmptyHistoryState, registerHistory} from '@lexical/history';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isParagraphNode,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_EDITOR,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
  REDO_COMMAND,
  UNDO_COMMAND,
} from 'lexical';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  $applyFormattedCode,
  $exitCodeBlock,
  $getCodeBlock,
  $getSelectedCodeBlock,
  $readCodeSnapshot,
  $setCodeBlockLanguage,
  registerCodeWritingCommands,
} from '../src/playground/plugins/CodeActionMenuPlugin/codeActions';
import {formatCodeWithPrettier} from '../src/playground/plugins/CodeActionMenuPlugin/formatCodeWithPrettier';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function update(editor: LexicalEditor, action: () => void) {
  editor.update(action, {discrete: true});
}

function fixture(language = 'js', content = 'const x={a:1}') {
  const editor = createHeadlessEditor({
    namespace: 'code-writing-test',
    nodes: [CodeNode, CodeHighlightNode],
    onError(error) { throw error; },
  });
  const history = createEmptyHistoryState();
  cleanups.push(registerHistory(editor, history, 1000));
  let key = '';
  let otherKey = '';
  update(editor, () => {
    const code = $createCodeNode(language).append($createCodeHighlightNode(content));
    const other = $createCodeNode('python').append($createCodeHighlightNode('print(1)'));
    key = code.getKey();
    otherKey = other.getKey();
    $getRoot().append(other, code);
    code.selectEnd();
  });
  return {editor, key, otherKey, history};
}

function readCode(editor: LexicalEditor, key: string) {
  return editor.read('latest', () => $readCodeSnapshot(key)!);
}

function undo(editor: LexicalEditor) {
  editor.dispatchCommand(UNDO_COMMAND, undefined);
  editor.read('force-commit', () => {});
}

function redo(editor: LexicalEditor) {
  editor.dispatchCommand(REDO_COMMAND, undefined);
  editor.read('force-commit', () => {});
}

function keyEvent(key: string, modifiers: Partial<KeyboardEvent> = {}) {
  return {key, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false,
    isComposing: false, preventDefault: vi.fn(), ...modifiers} as unknown as KeyboardEvent;
}

describe('code target and language', () => {
  it('resolves highlighted text and a node selection, rejecting ranges crossing code blocks', () => {
    const {editor, key, otherKey} = fixture();
    editor.read('latest', () => expect($getSelectedCodeBlock()?.getKey()).toBe(key));
    update(editor, () => {
      const selection = $createRangeSelection();
      selection.anchor.set($getCodeBlock(key)!.getFirstChildOrThrow().getKey(), 3, 'text');
      selection.focus.set($getCodeBlock(otherKey)!.getFirstChildOrThrow().getKey(), 0, 'text');
      $setSelection(selection);
    });
    editor.read('latest', () => expect($getSelectedCodeBlock()).toBeNull());
    update(editor, () => {
      const selection = $createNodeSelection();
      selection.add(otherKey);
      $setSelection(selection);
    });
    editor.read('latest', () => expect($getSelectedCodeBlock()?.getKey()).toBe(otherKey));
  });

  it('changes the hovered key, not another selected block, and language is independently undoable', () => {
    const {editor, key, otherKey} = fixture();
    let selectedText = '';
    update(editor, () => {
      const text = $getCodeBlock(otherKey)!.getFirstChildOrThrow();
      selectedText = text.getKey();
      text.selectStart();
    });
    update(editor, () => expect($setCodeBlockLanguage(editor, key, 'plain')).toBe(true));
    expect(readCode(editor, key).language).toBe('plain');
    expect(readCode(editor, otherKey).language).toBe('python');
    editor.read('latest', () => {
      const selection = $getSelection();
      expect($isRangeSelection(selection) && selection.anchor.key).toBe(selectedText);
    });
    undo(editor);
    expect(readCode(editor, key).language).toBe('js');
    redo(editor);
    expect(readCode(editor, key).language).toBe('plain');
  });

  it('keeps unspecified language distinct from explicit plain text across JSON and reads', () => {
    const {editor, key, history} = fixture('');
    const before = editor.getEditorState().toJSON();
    const depth = history.undoStack.length;
    expect(readCode(editor, key).language).toBe('');
    expect(editor.getEditorState().toJSON()).toEqual(before);
    expect(history.undoStack.length).toBe(depth);
    update(editor, () => $setCodeBlockLanguage(editor, key, 'plain'));
    expect(JSON.stringify(editor.getEditorState().toJSON())).toContain('"language":"plain"');
    update(editor, () => $setCodeBlockLanguage(editor, key, ''));
    editor.read('latest', () => expect($getCodeBlock(key)!.getLanguage()).toBeUndefined());
  });
});

describe('exit code', () => {
  it('creates a following paragraph at the end, keeps code intact, and supports undo/redo', () => {
    const {editor, key} = fixture();
    const before = readCode(editor, key).content;
    update(editor, () => expect($exitCodeBlock(editor, key)).toBe(true));
    editor.read('latest', () => {
      const next = $getCodeBlock(key)!.getNextSibling();
      expect($isParagraphNode(next)).toBe(true);
      const selection = $getSelection();
      expect($isRangeSelection(selection) && selection.anchor.key).toBe(next!.getKey());
      expect($isRangeSelection(selection) && selection.isCollapsed()).toBe(true);
    });
    expect(readCode(editor, key).content).toBe(before);
    undo(editor);
    editor.read('latest', () => {
      expect($getCodeBlock(key)!.getNextSibling()).toBeNull();
      expect($getSelectedCodeBlock()?.getKey()).toBe(key);
    });
    redo(editor);
    editor.read('latest', () => expect($isParagraphNode($getCodeBlock(key)!.getNextSibling())).toBe(true));
  });

  it.each(['', '已有正文'])('enters an existing following paragraph (%s) without inserting or deleting content', content => {
    const {editor, key, history} = fixture();
    let paragraphKey = '';
    update(editor, () => {
      const paragraph = $createParagraphNode();
      if (content) paragraph.append($createTextNode(content));
      paragraphKey = paragraph.getKey();
      $getRoot().append(paragraph);
    });
    const before = editor.getEditorState().toJSON();
    const depth = history.undoStack.length;
    update(editor, () => $exitCodeBlock(editor, key));
    expect(editor.getEditorState().toJSON()).toEqual(before);
    expect(history.undoStack.length).toBe(depth);
    editor.read('latest', () => {
      const selection = $getSelection();
      expect($isRangeSelection(selection) && selection.anchor.offset).toBe(0);
      expect($isRangeSelection(selection) && [selection.anchor.key, selection.anchor.getNode().getParent()?.getKey()]).toContain(paragraphKey);
      expect($getNodeByKey(paragraphKey)!.getTextContent()).toBe(content);
    });
  });

  it('inserts between adjacent code blocks and ignores the currently selected different block', () => {
    const {editor, key, otherKey} = fixture();
    update(editor, () => $exitCodeBlock(editor, otherKey));
    editor.read('latest', () => {
      const inserted = $getCodeBlock(otherKey)!.getNextSibling();
      expect($isParagraphNode(inserted)).toBe(true);
      expect(inserted!.getNextSibling()?.getKey()).toBe(key);
      expect($getCodeBlock(key)!.getNextSibling()).toBeNull();
    });
  });

  it('supports modified Enter and Alt+F10 without intercepting ordinary Enter, Tab or IME input', () => {
    const {editor, key} = fixture();
    const focusTools = vi.fn();
    cleanups.push(registerCodeWritingCommands(editor, focusTools));
    const upstreamTab = vi.fn(() => false);
    cleanups.push(editor.registerCommand(KEY_TAB_COMMAND, upstreamTab, COMMAND_PRIORITY_EDITOR));
    const focus = keyEvent('F10', {altKey: true});
    update(editor, () => expect(editor.dispatchCommand(KEY_DOWN_COMMAND, focus)).toBe(true));
    expect(focusTools).toHaveBeenCalledWith(key);
    expect(focus.preventDefault).toHaveBeenCalled();
    for (const event of [keyEvent('Enter'), keyEvent('Enter', {ctrlKey: true, isComposing: true})]) {
      update(editor, () => expect(editor.dispatchCommand(KEY_ENTER_COMMAND, event)).toBe(false));
    }
    const tab = keyEvent('Tab');
    update(editor, () => editor.dispatchCommand(KEY_DOWN_COMMAND, tab));
    expect(upstreamTab).toHaveBeenCalledWith(tab, editor);
    expect(tab.preventDefault).not.toHaveBeenCalled();
    const exit = keyEvent('Enter', {metaKey: true});
    update(editor, () => expect(editor.dispatchCommand(KEY_ENTER_COMMAND, exit)).toBe(true));
    expect(exit.preventDefault).toHaveBeenCalled();
    editor.read('latest', () => expect($isParagraphNode($getCodeBlock(key)!.getNextSibling())).toBe(true));
  });
});

describe('formatting and stale actions', () => {
  it('formats with the existing Prettier parser as one undoable change and preserves backward selection', async () => {
    const {editor, key} = fixture();
    update(editor, () => {
      const text = $getCodeBlock(key)!.getFirstChildOrThrow();
      const selection = $createRangeSelection();
      selection.anchor.set(text.getKey(), 8, 'text');
      selection.focus.set(text.getKey(), 2, 'text');
      $setSelection(selection);
    });
    const snapshot = readCode(editor, key);
    const formatted = await formatCodeWithPrettier(snapshot.content, 'js');
    update(editor, () => expect($applyFormattedCode(editor, snapshot, formatted)).toBe('applied'));
    expect(readCode(editor, key).content).toBe('const x = { a: 1 };\n');
    editor.read('latest', () => {
      const selection = $getSelection();
      expect($isRangeSelection(selection) && selection.isBackward()).toBe(true);
      expect($isRangeSelection(selection) && selection.anchor.offset).toBe(8);
      expect($isRangeSelection(selection) && selection.focus.offset).toBe(2);
    });
    undo(editor);
    expect(readCode(editor, key).content).toBe(snapshot.content);
    redo(editor);
    expect(readCode(editor, key).content).toBe(formatted);
  });

  it('formats only the original key when focus moves, without stealing the new selection', () => {
    const {editor, key, otherKey} = fixture();
    const snapshot = readCode(editor, key);
    update(editor, () => $getCodeBlock(otherKey)!.selectEnd());
    const selection = editor.read('latest', () => $getSelection()!.clone());
    update(editor, () => $applyFormattedCode(editor, snapshot, 'const x = 1;\n\tfoo();\n'));
    editor.read('latest', () => {
      expect($getSelection()!.is(selection)).toBe(true);
      expect($getSelectedCodeBlock()?.getKey()).toBe(otherKey);
      expect($getCodeBlock(key)!.getChildren().map(node => node.getType())).toContain('tab');
    });
    expect(readCode(editor, otherKey).content).toBe('print(1)');
  });

  it.each(['content', 'language', 'removed', 'readonly'])('rejects a delayed format after %s changes', change => {
    const {editor, key, otherKey} = fixture();
    const snapshot = readCode(editor, key);
    update(editor, () => {
      if (change === 'content') $getCodeBlock(key)!.append($createCodeHighlightNode('//new'));
      if (change === 'language') $setCodeBlockLanguage(editor, key, 'plain');
      if (change === 'removed') {
        $getCodeBlock(otherKey)!.selectEnd();
        $getCodeBlock(key)!.remove();
      }
    });
    if (change === 'readonly') editor.setEditable(false);
    const before = editor.getEditorState().toJSON();
    update(editor, () => expect($applyFormattedCode(editor, snapshot, 'OLD RESULT')).toBe('stale'));
    expect(editor.getEditorState().toJSON()).toEqual(before);
  });

  it('does not mutate read-only or detached targets and does not add history for unchanged formatting', () => {
    const {editor, key, history} = fixture();
    const snapshot = readCode(editor, key);
    const depth = history.undoStack.length;
    update(editor, () => expect($applyFormattedCode(editor, snapshot, snapshot.content)).toBe('unchanged'));
    expect(history.undoStack.length).toBe(depth);
    editor.setEditable(false);
    const before = editor.getEditorState().toJSON();
    update(editor, () => {
      expect($exitCodeBlock(editor, key)).toBe(false);
      expect($setCodeBlockLanguage(editor, key, 'plain')).toBe(false);
    });
    expect(editor.getEditorState().toJSON()).toEqual(before);
    editor.setEditable(true);
    update(editor, () => {
      expect($exitCodeBlock(editor, 'removed-key')).toBe(false);
      expect($setCodeBlockLanguage(editor, 'removed-key', 'plain')).toBe(false);
    });
  });
});
