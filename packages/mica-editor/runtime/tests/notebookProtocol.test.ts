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

  it('never serializes source-mode text as the saved rich document', () => {
    const session = new NotebookSession('a', {version: 1, editorState: null, comments: []});
    const read = vi.fn();
    session.editor = {getRootElement: () => ({dataset: {sourceMode: 'markdown'}}), getEditorState: read} as never;
    expect(() => session.snapshot()).toThrow('返回富文本');
    expect(read).not.toHaveBeenCalled();
    session.editor = {getRootElement: () => ({dataset: {sourceMode: 'wysiwyg', sourcePending: 'true'}})} as never;
    expect(() => session.snapshot()).toThrow('返回富文本');
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
});
