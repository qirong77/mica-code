import {beforeAll, describe, expect, it, vi} from 'vitest';

let MarkdownSession: typeof import('../src/markdown/MarkdownBridge').MarkdownSession;

beforeAll(async () => {
  vi.stubGlobal('location', {hash: '#markdown-nonce'});
  vi.stubGlobal('window', {parent: {postMessage: vi.fn()}});
  ({MarkdownSession} = await import('../src/markdown/MarkdownBridge'));
});

describe('Markdown runtime identity', () => {
  it('identifies the mounted load on changes and shortcut snapshots, even when the document id is reused', () => {
    const post = vi.mocked(window.parent.postMessage);
    post.mockClear();
    const session = new MarkdownSession('a', 'initial', false, 'load-new');
    session.reader = () => 'last keystroke';
    session.ready();
    session.save();
    expect(post.mock.calls.map(([message]) => message)).toEqual([
      expect.objectContaining({type: 'loaded', requestId: 'load-new', documentId: 'a'}),
      expect.objectContaining({type: 'change', loadId: 'load-new', documentId: 'a', value: 'last keystroke'}),
      expect.objectContaining({type: 'save', loadId: 'load-new', documentId: 'a', value: 'last keystroke'}),
    ]);
  });

  it('never publishes changes or saves for a read-only session', () => {
    const post = vi.mocked(window.parent.postMessage);
    post.mockClear();
    const session = new MarkdownSession('a', 'default prompt', true, 'load-readonly');
    session.change('override');
    session.save();
    expect(session.value).toBe('default prompt');
    expect(post).not.toHaveBeenCalled();
  });
});
