import {beforeAll, describe, expect, it, vi} from 'vitest';

let NotebookSession: typeof import('../src/workspace/NotebookBridge').NotebookSession;
let hydrateComments: typeof import('../src/workspace/NotebookBridge').hydrateComments;

beforeAll(async () => {
  vi.stubGlobal('window', {location: {hash: '#test-nonce'}, parent: {postMessage: vi.fn()}});
  ({NotebookSession, hydrateComments} = await import('../src/workspace/NotebookBridge'));
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

  it('clones and validates comments so note sessions cannot share mutable comments', () => {
    const input = [{type: 'comment', id: 'c1', author: '我', content: 'hello', deleted: false, timeStamp: 10}];
    const result = hydrateComments([...input, {type: 'thread', id: 'bad', comments: [null]}]);
    expect(result).toEqual(input);
    expect(result[0]).not.toBe(input[0]);
    result[0].id = 'changed';
    expect(input[0].id).toBe('c1');
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
