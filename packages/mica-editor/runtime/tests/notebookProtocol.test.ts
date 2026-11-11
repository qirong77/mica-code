import {createHeadlessEditor} from '@lexical/headless';
import {$createMarkNode, $isMarkNode, MarkNode} from '@lexical/mark';
import {$createParagraphNode, $createTextNode, $getRoot} from 'lexical';
import {beforeAll, describe, expect, it, vi} from 'vitest';

let NotebookSession: typeof import('../src/workspace/NotebookBridge').NotebookSession;

beforeAll(async () => {
  vi.stubGlobal('window', {location: {hash: '#test-nonce'}, parent: {postMessage: vi.fn()}});
  ({NotebookSession} = await import('../src/workspace/NotebookBridge'));
});

describe('notebook persistence boundary', () => {
  it('rejects flush until the document editor is mounted', () => {
    const session = new NotebookSession('a', {version: 1, editorState: null, comments: []});
    expect(() => session.snapshot()).toThrow('尚未就绪');
  });

  it('reports failed content snapshots with their load identity instead of silently dropping the last input', async () => {
    const post = vi.mocked(window.parent.postMessage);
    post.mockClear();
    const session = new NotebookSession('a', {version: 1, editorState: null, comments: []}, 'load-failed');
    const detach = session.attach({update: () => {}, getEditorState: () => {throw new Error('invalid node');}} as never);
    await Promise.resolve();
    session.dirty();
    await Promise.resolve();
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'error', loadId: 'load-failed', noteId: 'a', message: 'Error: invalid node',
    }), '*');
    detach();
  });

  it('round-trips existing comments as opaque deep copies while editing the body and retaining marks', () => {
    const thread = {
      type: 'thread', id: 't1', quote: '原有正文',
      comments: [{type: 'comment', id: 'c1', author: '我', content: 'hello', deleted: false, timeStamp: 10}],
      metadata: {labels: ['stored']},
    };
    const comments = [thread, {type: 'thread', id: 'unvalidated', comments: [null]}, {unknown: {values: [1, null]}}, null];
    const createEditor = () => createHeadlessEditor({
      namespace: 'notebook-protocol-comments', nodes: [MarkNode], onError(error) {throw error;},
    });
    const editor = createEditor();
    editor.update(() => {
      $getRoot().append($createParagraphNode().append($createMarkNode(['t1']).append($createTextNode('原有正文'))));
    }, {discrete: true});
    const document = {version: 1 as const, editorState: JSON.stringify(editor.getEditorState().toJSON()), comments};
    const session = new NotebookSession('a', document);
    session.editor = editor;
    editor.update(() => {
      $getRoot().getAllTextNodes()[0].setTextContent('修改后的正文');
    }, {discrete: true});

    const snapshot = session.snapshot();
    expect(snapshot.editorState).not.toBe(document.editorState);
    expect(snapshot.comments).toEqual(comments);
    expect(snapshot.comments).not.toBe(comments);
    const savedThread = snapshot.comments[0] as typeof thread;
    expect(savedThread).not.toBe(thread);
    expect(savedThread.comments[0]).not.toBe(thread.comments[0]);
    expect(savedThread.metadata.labels).not.toBe(thread.metadata.labels);

    const reopened = createEditor();
    reopened.setEditorState(reopened.parseEditorState(snapshot.editorState!));
    reopened.getEditorState().read(() => {
      expect($getRoot().getTextContent()).toBe('修改后的正文');
      const mark = $getRoot().getAllTextNodes()[0].getParent();
      expect($isMarkNode(mark) && mark.getIDs()).toEqual(['t1']);
    });
    const reopenedSession = new NotebookSession('a', snapshot);
    reopenedSession.editor = reopened;
    reopened.update(() => {
      $getRoot().getAllTextNodes()[0].setTextContent('再次修改正文');
    }, {discrete: true});
    const roundTrip = reopenedSession.snapshot();
    expect(roundTrip.comments).toEqual(comments);
    expect(roundTrip.comments[0]).not.toBe(savedThread);

    savedThread.comments[0].content = 'changed in snapshot';
    savedThread.metadata.labels[0] = 'changed in snapshot';
    expect(session.snapshot().comments).toEqual(comments);
    expect(roundTrip.comments).toEqual(comments);
    expect(thread.comments[0].content).toBe('hello');
    expect(thread.metadata.labels).toEqual(['stored']);
  });

  it('flushes attached captions before serializing and detaches them on unmount', () => {
    const session = new NotebookSession('a', {version: 1, editorState: null, comments: []});
    const updates: string[] = [];
    const nested = {update: () => updates.push('caption')} as never;
    session.editor = {
      getRootElement: () => ({dataset: {}}),
      update: () => updates.push('document'),
      getEditorState: () => ({toJSON: () => ({root: {children: []}})}),
    } as never;
    const detach = session.attachNested(nested);
    session.snapshot();
    expect(updates).toEqual(['caption', 'document']);
    detach();
    updates.length = 0;
    session.snapshot();
    expect(updates).toEqual(['document']);
  });

  it('keeps comment store snapshots stable and isolates writes from caller mutations', () => {
    const session = new NotebookSession('a', {version: 1, editorState: null, comments: []});
    const editor = createHeadlessEditor({namespace: 'comment-store', onError(error) {throw error;}});
    session.editor = editor;
    const original = session.getCommentSnapshot();
    const notified = vi.fn();
    const unsubscribe = session.subscribeComments(notified);
    expect(session.getCommentSnapshot()).toBe(original);
    const next = [{content: '已保存'}];
    expect(session.setComments(next)).toBe(true);
    const updated = session.getCommentSnapshot();
    expect(updated).not.toBe(original);
    expect(session.getCommentSnapshot()).toBe(updated);
    next[0].content = '外部修改';
    expect(session.getComments()).toEqual([{content: '已保存'}]);
    expect(notified).toHaveBeenCalledTimes(1);
    unsubscribe();
    session.setComments([]);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it('restores presentation editability only after an overlapping freeze ends', () => {
    const session = new NotebookSession('a', {version: 1, editorState: null, comments: []});
    const editor = createHeadlessEditor({namespace: 'presentation-freeze', onError(error) {throw error;}});
    session.editor = editor;
    session.setPresenting(true);
    expect(editor.isEditable()).toBe(false);
    expect(session.setComments([{content: 'blocked'}])).toBe(false);
    session.setFrozen(true);
    session.setPresenting(false);
    expect(editor.isEditable()).toBe(false);
    session.setFrozen(false);
    expect(editor.isEditable()).toBe(true);
    session.setFrozen(true);
    session.setPresenting(true);
    session.setFrozen(false);
    expect(editor.isEditable()).toBe(false);
    session.setPresenting(false);
    expect(editor.isEditable()).toBe(true);
  });

  it('preserves a document that was already read-only before presentation', () => {
    const session = new NotebookSession('a', {version: 1, editorState: null, comments: []});
    const editor = createHeadlessEditor({namespace: 'presentation-readonly', editable: false, onError(error) {throw error;}});
    session.editor = editor;
    session.setPresenting(true);
    session.setPresenting(true);
    session.setPresenting(false);
    expect(editor.isEditable()).toBe(false);
  });

  it('tags loaded, outline and content messages with the mounted load identity and stops after detach', async () => {
    const post = vi.mocked(window.parent.postMessage);
    post.mockClear();
    const session = new NotebookSession('a', {version: 1, editorState: null, comments: []}, 'load-current');
    const editor = {
      getRootElement: () => ({dataset: {}}),
      update: () => {},
      getEditorState: () => ({toJSON: () => ({root: {children: []}})}),
    } as never;
    const detach = session.attach(editor);
    await Promise.resolve();
    session.publishOutline({items: [], activeKey: null, blocks: {table: false, code: false, mermaid: false, image: false}});
    session.dirty();
    await Promise.resolve();
    expect(post.mock.calls.map(([message]) => message)).toEqual([
      expect.objectContaining({type: 'loaded', noteId: 'a', requestId: 'load-current', loadId: 'load-current'}),
      expect.objectContaining({type: 'outline', noteId: 'a', loadId: 'load-current'}),
      expect.objectContaining({type: 'change', noteId: 'a', loadId: 'load-current'}),
    ]);
    detach();
    session.dirty();
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(3);
  });
});
