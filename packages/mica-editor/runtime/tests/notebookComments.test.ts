import {$createCodeNode, CodeNode} from '@lexical/code';
import {createHeadlessEditor} from '@lexical/headless';
import {$createLinkNode, LinkNode} from '@lexical/link';
import {$createMarkNode, MarkNode} from '@lexical/mark';
import {$createTableCellNode, $createTableNode, $createTableRowNode, TableCellNode, TableNode, TableRowNode} from '@lexical/table';
import {
  $createNodeSelection, $createParagraphNode, $createRangeSelection, $createTextNode,
  $getRoot, $getSelection, $isRangeSelection, $setSelection, type LexicalEditor,
} from 'lexical';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

import {
  $addNotebookCommentAnchor, $captureNotebookCommentAnchor, $getNotebookCommentIDs,
  $getNotebookCommentMarks, $isNotebookCommentAnchorValid, createNotebookThread,
  formatNotebookCommentTime, isNotebookComment, isNotebookThread, notebookCommentDateTime,
  registerNotebookCommentOverlap, replyToNotebookThread, resolveNotebookThread,
  type NotebookCommentAnchor,
} from '../src/workspace/notebookComments';

let NotebookSession: typeof import('../src/workspace/NotebookBridge').NotebookSession;
let editorSequence = 0;
const cleanups: (() => void)[] = [];

beforeAll(async () => {
  vi.stubGlobal('window', {location: {hash: '#comments-test'}, parent: {postMessage: vi.fn()}});
  ({NotebookSession} = await import('../src/workspace/NotebookBridge'));
});
afterAll(() => vi.unstubAllGlobals());
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function createEditor(text = 'abcdefghi'): LexicalEditor {
  const editor = createHeadlessEditor({
    namespace: `notebook-comments-${++editorSequence}`, nodes: [MarkNode, LinkNode, CodeNode, TableNode, TableRowNode, TableCellNode],
    onError(error) { throw error; },
  });
  cleanups.push(registerNotebookCommentOverlap(editor));
  editor.update(() => {
    $getRoot().append($createParagraphNode().append($createTextNode(text)));
  }, {discrete: true});
  return editor;
}

/** Text offsets remain useful after MarkNode splits a paragraph's text nodes. */
function capture(editor: LexicalEditor, start: number, end: number): NotebookCommentAnchor {
  let anchor: NotebookCommentAnchor | null = null;
  editor.update(() => {
    const nodes = $getRoot().getAllTextNodes();
    const point = (offset: number) => {
      let remaining = offset;
      for (const node of nodes) {
        if (remaining <= node.getTextContentSize()) return {node, offset: remaining};
        remaining -= node.getTextContentSize();
      }
      throw new Error(`Text offset ${offset} exceeds the document`);
    };
    const from = point(start);
    const to = point(end);
    const selection = $createRangeSelection();
    selection.setTextNodeRange(from.node, from.offset, to.node, to.offset);
    $setSelection(selection);
    anchor = $captureNotebookCommentAnchor(selection);
  }, {discrete: true});
  expect(anchor).not.toBeNull();
  return anchor!;
}

function addAnchor(editor: LexicalEditor, anchor: NotebookCommentAnchor, id: string, commit?: () => boolean): boolean {
  let added = false;
  editor.update(() => { added = $addNotebookCommentAnchor(anchor, id, commit); }, {discrete: true});
  return added;
}

describe('notebook comment threads', () => {
  it('publishes stable subscription snapshots while keeping getComments deeply isolated', () => {
    const editor = createEditor();
    const thread = {...createNotebookThread('t', 'c', 'original'), extra: {values: [1]}};
    const session = new NotebookSession('snapshot', {version: 1, editorState: null, comments: [thread]});
    session.editor = editor;
    const initial = session.getCommentSnapshot();
    expect(session.getCommentSnapshot()).toBe(initial);
    const copied = session.getComments() as typeof thread[];
    copied[0].extra.values.push(2);
    expect(session.getComments()).toEqual([thread]);
    expect(session.getCommentSnapshot()).toBe(initial);
    const listener = vi.fn();
    const unsubscribe = session.subscribeComments(listener);
    const next = replyToNotebookThread(session.getComments(), 't', 'reply', 'next', 200);
    expect(session.setComments(next)).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(session.getCommentSnapshot()).not.toBe(initial);
    expect(session.getCommentSnapshot()).toBe(session.getCommentSnapshot());
    expect(initial).toEqual([thread]);
    next.push({later: true});
    expect(session.getComments()).toHaveLength(1);
    unsubscribe();
  });

  it('creates full-document comments and preserves unknown rows, children and fields through reply/resolve/reopen', () => {
    const thread = {
      ...createNotebookThread('thread', 'first', '  首条评论  ', '', 100),
      metadata: {labels: ['original'], future: {value: 1}},
      comments: [
        {...(createNotebookThread('unused', 'first', '首条评论', '', 100).comments[0] as object), extra: {kept: true}},
        null, {type: 'future-comment', payload: [1, 2]}, {type: 'comment', content: false},
      ],
    };
    const unknown = {type: 'future-row', data: {values: [1, null]}};
    const malformed = {type: 'thread', id: 'thread', comments: [null]};
    const duplicate = {...createNotebookThread('thread', 'duplicate', 'duplicate'), extra: 'untouched'};
    const rows = [unknown, malformed, thread, null, 'opaque', duplicate];
    const before = structuredClone(rows);
    const replied = replyToNotebookThread(rows, 'thread', 'reply', '  新回复\n保留换行  ', 200);
    expect(replied[0]).toBe(unknown);
    expect(replied[1]).toBe(malformed);
    expect(replied[5]).toBe(duplicate);
    const changed = replied[2] as typeof thread;
    expect(changed).toMatchObject({quote: '', metadata: thread.metadata});
    expect(changed.comments.slice(0, 4)).toEqual(thread.comments);
    expect(changed.comments[0]).toBe(thread.comments[0]);
    expect(changed.comments[4]).toEqual({
      type: 'comment', id: 'reply', author: '我', content: '新回复\n保留换行', deleted: false, timeStamp: 200,
    });
    const resolved = resolveNotebookThread(replied, 'thread', true);
    expect(resolved[2]).toMatchObject({resolved: true, metadata: thread.metadata, comments: changed.comments});
    expect(replyToNotebookThread(resolved, 'thread', 'blocked', 'no')).toEqual(resolved);
    const reopened = resolveNotebookThread(resolved, 'thread', false);
    expect(reopened[2]).toMatchObject({resolved: false, quote: '', metadata: thread.metadata});
    expect(replyToNotebookThread(reopened, 'thread', 'after-reopen', '可以继续回复', 300)[2])
      .toMatchObject({comments: [...changed.comments, expect.objectContaining({id: 'after-reopen'})]});
    expect(rows).toEqual(before);
    expect(replyToNotebookThread(rows, 'thread', 'empty', ' \n ')).toEqual(before);
    expect(resolveNotebookThread(rows, 'missing', true)).toEqual(before);
  });

  it('formats out-of-range historical timestamps without throwing or discarding the comment', () => {
    for (const stamp of [NaN, Infinity, -Infinity, Number.MAX_VALUE, 8.64e15 + 1, -8.64e15 - 1]) {
      expect(notebookCommentDateTime(stamp)).toBeUndefined();
      expect(formatNotebookCommentTime(stamp, stamp)).toBe('时间未知');
      expect(formatNotebookCommentTime(stamp, null)).toBe('时间未知');
    }
    expect(notebookCommentDateTime(8.64e15)).toBe('+275760-09-13T00:00:00.000Z');
    expect(notebookCommentDateTime(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(formatNotebookCommentTime(100, 101)).toBe('刚刚');
    expect(formatNotebookCommentTime(100, 120_100)).toBe('2 分钟前');
    const historical = {type: 'comment', id: 'c', author: '过去', content: '仍可阅读', deleted: false, timeStamp: 1e30};
    expect(isNotebookComment(historical)).toBe(true);
    const rows = [{...createNotebookThread('t', 'c', 'x'), comments: [historical]}];
    expect(resolveNotebookThread(rows, 't', true)[0]).toMatchObject({comments: [historical]});
  });
});

describe('notebook comment marks in a real Lexical editor', () => {
  it.each([[2, 6], [6, 2]])('marks only the selected text for offsets %i → %i', (start, end) => {
    const editor = createEditor();
    const anchor = capture(editor, start, end);
    expect(anchor.quote).toBe('cdef');
    expect(addAnchor(editor, anchor, 'thread')).toBe(true);
    editor.getEditorState().read(() => {
      expect($getRoot().getTextContent()).toBe('abcdefghi');
      const marks = $getNotebookCommentMarks('thread');
      expect(marks.map((mark) => mark.getTextContent())).toEqual(['cdef']);
      expect($getNotebookCommentIDs(marks[0].getFirstChild())).toEqual(['thread']);
      expect($getNotebookCommentMarks('unknown')).toEqual([]);
      const selection = $getSelection();
      expect($isRangeSelection(selection) && selection.getTextContent()).toBe('cdef');
      expect($isRangeSelection(selection) && selection.isBackward()).toBe(start > end);
    });
  });

  it('captures root element ranges and selections spanning paragraphs', () => {
    const editor = createEditor('first');
    let anchor: NotebookCommentAnchor | null = null;
    editor.update(() => {
      $getRoot().append($createParagraphNode().append($createTextNode('second')));
      const selection = $getRoot().select(0, 2);
      anchor = $captureNotebookCommentAnchor(selection);
    }, {discrete: true});
    expect(anchor).not.toBeNull();
    expect(addAnchor(editor, anchor!, 'multi')).toBe(true);
    editor.getEditorState().read(() => {
      expect($getNotebookCommentMarks('multi').map((mark) => mark.getTextContent())).toEqual(['first', 'second']);
    });
  });

  it('anchors text inside a table cell without mistaking its shadow root for a detached document', () => {
    const editor = createEditor();
    let anchor: NotebookCommentAnchor | null = null;
    editor.update(() => {
      const text = $createTextNode('表格里的正文');
      $getRoot().clear().append($createTableNode().append($createTableRowNode().append($createTableCellNode().append($createParagraphNode().append(text)))));
      anchor = $captureNotebookCommentAnchor(text.select(0, 3));
    }, {discrete: true});
    expect(anchor).not.toBeNull();
    expect(addAnchor(editor, anchor!, 'table')).toBe(true);
    expect(editor.getEditorState().read(() => $getNotebookCommentMarks('table').map(mark => mark.getTextContent()))).toEqual(['表格里']);
  });

  it('keeps code selections and their draft untouched rather than saving an anchor that highlighting removes', () => {
    const editor = createEditor();
    let anchor: NotebookCommentAnchor | null = null;
    editor.update(() => {
      const text = $createTextNode('const x = 1;');
      $getRoot().clear().append($createCodeNode('javascript').append(text));
      anchor = $captureNotebookCommentAnchor(text.select(0, 5));
    }, {discrete: true});
    expect(anchor).not.toBeNull();
    const before = editor.getEditorState().toJSON();
    const commit = vi.fn(() => true);
    expect(addAnchor(editor, anchor!, 'code', commit)).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(editor.getEditorState().toJSON()).toEqual(before);
  });

  it('ignores collapsed, blank and non-text selections', () => {
    const editor = createEditor('   ');
    editor.update(() => {
      const text = $getRoot().getAllTextNodes()[0];
      text.select(1, 1);
      expect($captureNotebookCommentAnchor($getSelection())).toBeNull();
      text.select(0, 3);
      expect($captureNotebookCommentAnchor($getSelection())).toBeNull();
      const selection = $createNodeSelection();
      selection.add(text.getKey());
      expect($captureNotebookCommentAnchor(selection)).toBeNull();
      expect($captureNotebookCommentAnchor(null)).toBeNull();
    }, {discrete: true});
  });

  it('preserves both IDs and their exact text when comment ranges overlap', () => {
    const editor = createEditor();
    expect(addAnchor(editor, capture(editor, 0, 5), 'first')).toBe(true);
    expect(addAnchor(editor, capture(editor, 3, 8), 'second')).toBe(true);
    editor.getEditorState().read(() => {
      expect($getRoot().getAllTextNodes().map((node) => ({text: node.getTextContent(), ids: $getNotebookCommentIDs(node).sort()})))
        .toEqual([
          {text: 'abc', ids: ['first']}, {text: 'de', ids: ['first', 'second']},
          {text: 'fgh', ids: ['second']}, {text: 'i', ids: []},
        ]);
      expect($getNotebookCommentMarks('first').map((mark) => mark.getTextContent()).join('')).toBe('abcde');
      expect($getNotebookCommentMarks('second').map((mark) => mark.getTextContent()).join('')).toBe('defgh');
    });
  });

  it('finds all comment IDs in historical marks nested around inline links', () => {
    const editor = createEditor();
    editor.update(() => {
      $getRoot().clear().append($createParagraphNode().append(
        $createMarkNode(['outer']).append($createLinkNode('https://example.com').append(
          $createMarkNode(['inner', 'outer']).append($createTextNode('linked quote')),
        )),
      ));
    }, {discrete: true});
    editor.getEditorState().read(() => {
      expect($getNotebookCommentIDs($getRoot().getAllTextNodes()[0]).sort()).toEqual(['inner', 'outer']);
      expect($getNotebookCommentMarks('inner')[0].getTextContent()).toBe('linked quote');
    });
  });

  it('keeps overlapping comment ranges correct across a link boundary', () => {
    const editor = createEditor();
    editor.update(() => {
      $getRoot().clear().append($createParagraphNode().append($createTextNode('ab'), $createLinkNode('https://example.com').append($createTextNode('cdef')), $createTextNode('ghi')));
    }, {discrete: true});
    expect(addAnchor(editor, capture(editor, 0, 5), 'before-link')).toBe(true);
    expect(addAnchor(editor, capture(editor, 3, 8), 'after-link')).toBe(true);
    editor.getEditorState().read(() => {
      expect($getNotebookCommentMarks('before-link').map(mark => mark.getTextContent()).join('')).toBe('abcde');
      expect($getNotebookCommentMarks('after-link').map(mark => mark.getTextContent()).join('')).toBe('defgh');
      expect($getRoot().getTextContent()).toBe('abcdefghi');
    });
  });

  it('rejects changed text and does not commit a stale quote', () => {
    const editor = createEditor();
    const anchor = capture(editor, 2, 6);
    editor.update(() => {
      expect($isNotebookCommentAnchorValid(anchor)).toBe(true);
      $getRoot().getAllTextNodes()[0].setTextContent('abXdefghi');
    }, {discrete: true});
    const commit = vi.fn(() => true);
    expect(addAnchor(editor, anchor, 'stale', commit)).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    editor.getEditorState().read(() => expect($getNotebookCommentMarks('stale')).toEqual([]));
  });

  it('rejects a deleted selection even when identical text exists elsewhere', () => {
    const editor = createEditor('same');
    const anchor = capture(editor, 0, 4);
    editor.update(() => {
      $getRoot().clear().append($createParagraphNode().append($createTextNode('same')));
    }, {discrete: true});
    expect(addAnchor(editor, anchor, 'not-guessed')).toBe(false);
    editor.getEditorState().read(() => expect($getRoot().getTextContent()).toBe('same'));
  });

  it('rejects moving an identical block while allowing unrelated edits after the quote', () => {
    const editor = createEditor('same');
    const anchor = capture(editor, 0, 4);
    editor.update(() => {
      $getRoot().append($createParagraphNode().append($createTextNode('same')));
      expect($isNotebookCommentAnchorValid(anchor)).toBe(true);
      $getRoot().append($getRoot().getFirstChildOrThrow());
      expect($isNotebookCommentAnchorValid(anchor)).toBe(false);
    }, {discrete: true});
    expect(addAnchor(editor, anchor, 'moved')).toBe(false);
  });

  it('does not split or mark the body when the comment commit is rejected', () => {
    const editor = createEditor();
    const anchor = capture(editor, 2, 6);
    const before = editor.getEditorState().toJSON();
    const commit = vi.fn(() => false);
    expect(addAnchor(editor, anchor, 'rejected', commit)).toBe(false);
    expect(commit).toHaveBeenCalledOnce();
    expect(editor.getEditorState().toJSON()).toEqual(before);
  });

  it('lets a read-only session inspect comments and marks while refusing every write', () => {
    const editor = createEditor();
    const original = createNotebookThread('original', 'c1', '评论', 'abc', 100);
    expect(addAnchor(editor, capture(editor, 0, 3), original.id)).toBe(true);
    const anchor = capture(editor, 5, 8);
    const session = new NotebookSession('readonly', {version: 1, editorState: null, comments: [original, {opaque: true}]});
    session.editor = editor;
    editor.setEditable(false);
    const before = session.snapshot();
    expect(session.getComments()).toEqual(before.comments);
    expect(addAnchor(editor, anchor, 'new', () => session.setComments([
      ...session.getComments(), createNotebookThread('new', 'c2', '不能写入', anchor.quote),
    ]))).toBe(false);
    expect(session.setComments(replyToNotebookThread(session.getComments(), 'original', 'reply', '不能回复'))).toBe(false);
    expect(session.setComments(resolveNotebookThread(session.getComments(), 'original', true))).toBe(false);
    expect(session.snapshot()).toEqual(before);
    editor.getEditorState().read(() => {
      expect($getNotebookCommentMarks('original')[0].getTextContent()).toBe('abc');
      expect($getNotebookCommentIDs($getNotebookCommentMarks('original')[0])).toEqual(['original']);
      expect($getNotebookCommentMarks('new')).toEqual([]);
    });
  });

  it('round-trips overlapping marks and opaque comment data through the document session', () => {
    const editor = createEditor();
    const opaque = {type: 'future-row', extra: {kept: [null, 'value']}};
    const session = new NotebookSession('persist', {version: 1, editorState: null, comments: [opaque, null]});
    session.editor = editor;
    for (const [id, start, end] of [['first', 0, 5], ['second', 3, 8]] as const) {
      const anchor = capture(editor, start, end);
      const thread = {...createNotebookThread(id, `${id}-comment`, '正文评论', anchor.quote, 100), metadata: {kept: true}};
      expect(addAnchor(editor, anchor, id, () => session.setComments([...session.getComments(), thread]))).toBe(true);
    }
    expect(session.setComments(replyToNotebookThread(session.getComments(), 'first', 'reply', '回复', 200))).toBe(true);
    expect(session.setComments(resolveNotebookThread(session.getComments(), 'second', true))).toBe(true);
    const snapshot = session.snapshot();
    const reopened = createEditor();
    reopened.setEditorState(reopened.parseEditorState(snapshot.editorState!));
    const restored = new NotebookSession('persist', snapshot);
    restored.editor = reopened;
    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.getComments()[0]).toEqual(opaque);
    expect(restored.setComments(resolveNotebookThread(restored.getComments(), 'second', false))).toBe(true);
    const second = restored.getComments().find((row) => isNotebookThread(row) && row.id === 'second');
    expect(second).toMatchObject({resolved: false, metadata: {kept: true}, quote: 'defgh'});
    reopened.getEditorState().read(() => {
      expect($getRoot().getTextContent()).toBe('abcdefghi');
      expect($getNotebookCommentMarks('first').map((mark) => mark.getTextContent()).join('')).toBe('abcde');
      expect($getNotebookCommentMarks('second').map((mark) => mark.getTextContent()).join('')).toBe('defgh');
      expect($getRoot().getAllTextNodes().some((node) => $getNotebookCommentIDs(node).length === 2)).toBe(true);
    });
  });
});
