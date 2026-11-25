import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorBridge, NOTEBOOK_CHANNEL } from './bridge';

const document = { version: 1 as const, editorState: null };
function fixture() {
  const target = { postMessage: vi.fn() } as unknown as Window;
  const onReady = vi.fn(),
    onChange = vi.fn(),
    onError = vi.fn(),
    onOutline = vi.fn(),
    onLoaded = vi.fn(),
    onModalChange = vi.fn();
  const bridge = createEditorBridge({ token: 'nonce', target: () => target, onReady, onChange, onError, onOutline, onLoaded, onModalChange });
  const last = (type: string) => vi.mocked(target.postMessage).mock.calls
    .map(([payload]) => payload as Record<string, unknown>).filter((payload) => payload.type === type).at(-1)!;
  const receive = (data: Record<string, unknown>, source: unknown = target) =>
    bridge.receive({ source, data: {
      channel: NOTEBOOK_CHANNEL, token: 'nonce', loadId: last('load')?.loadId,
      ...(data.type === 'loaded' ? { requestId: last('load')?.requestId } : {}), ...data,
    } } as MessageEvent);
  const load = async (id: string) => {
    const loading = bridge.load(id, document);
    receive({ type: 'loaded', noteId: id });
    await loading;
  };
  return { target, onReady, onChange, onError, onOutline, onLoaded, onModalChange, bridge, receive, last, load };
}
afterEach(() => vi.useRealTimers());

describe('Notebook iframe boundary', () => {
  it('mirrors only the active frame modal and clears the host mask on load or dispose', async () => {
    const f = fixture();
    await f.load('a');
    const oldLoad = f.last('load').loadId;
    f.onModalChange.mockClear();
    for (const data of [
      { noteId: 'a', token: 'wrong', open: true },
      { noteId: 'other', open: true },
      { noteId: 'a', open: 'true' },
    ]) f.receive({ type: 'modal', ...data });
    f.receive({ type: 'modal', noteId: 'a', open: true }, {});
    expect(f.onModalChange).not.toHaveBeenCalled();
    f.receive({ type: 'modal', noteId: 'a', open: true });
    expect(f.onModalChange).toHaveBeenLastCalledWith(true);
    f.receive({ type: 'modal', noteId: 'a', open: false });
    expect(f.onModalChange).toHaveBeenLastCalledWith(false);
    f.receive({ type: 'modal', noteId: 'a', open: true });
    await f.load('b');
    expect(f.onModalChange).toHaveBeenLastCalledWith(false);
    f.onModalChange.mockClear();
    f.receive({ type: 'modal', noteId: 'a', loadId: oldLoad, open: true });
    expect(f.onModalChange).not.toHaveBeenCalled();
    f.receive({ type: 'modal', noteId: 'b', open: true });
    f.bridge.dispose();
    expect(f.onModalChange).toHaveBeenLastCalledWith(false);
  });
  it('ignores foreign frames and forged nonces', () => {
    const f = fixture();
    f.receive({ type: 'ready' }, {});
    f.receive({ type: 'ready', token: 'wrong' });
    expect(f.onReady).not.toHaveBeenCalled();
    f.receive({ type: 'ready' });
    f.receive({ type: 'ready' });
    expect(f.onReady).toHaveBeenCalledOnce();
    f.bridge.dispose();
  });
  it('waits for the matching load acknowledgment and flush result', async () => {
    const f = fixture();
    const load = f.bridge.load('note-a', document);
    f.receive({ type: 'loaded', noteId: 'note-a' });
    await load;
    const flush = f.bridge.flush();
    const payload = vi.mocked(f.target.postMessage).mock.calls.at(-1)![0] as { requestId: string };
    f.receive({ type: 'result', requestId: payload.requestId, noteId: 'note-a', document });
    await expect(flush).resolves.toEqual({ noteId: 'note-a', document });
    f.bridge.dispose();
  });
  it('tracks a debounced dirty notification so a clean switch can skip a full snapshot', async () => {
    const f = fixture();
    await f.load('note-a');
    expect(f.bridge.needsFlush()).toBe(false);
    f.receive({ type: 'dirty', noteId: 'note-a' });
    expect(f.bridge.needsFlush()).toBe(true);
    const flush = f.bridge.flush();
    const payload = f.last('flush');
    f.receive({ type: 'result', requestId: payload.requestId, noteId: 'note-a', document });
    await flush;
    expect(f.bridge.needsFlush()).toBe(false);
    f.bridge.dispose();
  });
  it('surfaces runtime snapshot failures without completing the flush', async () => {
    const f = fixture();
    await f.load('a');
    const flush = f.bridge.flush();
    const payload = vi.mocked(f.target.postMessage).mock.calls.at(-1)![0] as { requestId: string };
    f.receive({ type: 'error', requestId: payload.requestId, message: '笔记快照暂不可用' });
    await expect(flush).rejects.toThrow('快照暂不可用');
    expect(f.onError).toHaveBeenCalledWith('笔记快照暂不可用');
    f.bridge.dispose();
  });
  it('keeps the newest oversized draft exportable instead of discarding the change', async () => {
    const f = fixture();
    await f.load('a');
    const big = {
      ...document,
      editorState: JSON.stringify({ root: { type: 'root', children: [] }, text: 'x'.repeat(6 * 1024 * 1024) }),
    };
    f.receive({ type: 'change', noteId: 'a', document: big });
    expect(f.onChange).toHaveBeenCalledWith('a', big);
    expect(f.onError).toHaveBeenCalled();
    f.bridge.dispose();
  });
  it('times out dead frames and rejects outstanding requests on close', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.load('a');
    const request = f.bridge.flush();
    const rejected = expect(request).rejects.toThrow('没有响应');
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    const load = f.bridge.load('a', document);
    const closed = expect(load).rejects.toThrow('已关闭');
    f.bridge.dispose();
    await closed;
  });
  it('keeps outline metadata separate from saved content and authenticates its sender', async () => {
    const f = fixture();
    await f.load('note-a');
    const outline = {
      items: [{ key: 'h1', text: '正文', level: 1 }],
      activeKey: 'h1',
      blocks: { table: true, code: false, mermaid: true, image: false },
    };
    f.receive({ type: 'outline', noteId: 'note-a', ...outline }, {});
    f.receive({ type: 'outline', noteId: 'note-a', ...outline, token: 'other' });
    expect(f.onOutline).not.toHaveBeenCalled();
    f.receive({ type: 'outline', noteId: 'note-a', ...outline });
    expect(f.onOutline).toHaveBeenCalledWith('note-a', outline);
    expect(f.onChange).not.toHaveBeenCalled();
    f.bridge.dispose();
  });
  it('ignores malformed outlines instead of interrupting document saving', async () => {
    const f = fixture();
    await f.load('a');
    const outline = {
      items: [{ key: 'h1', text: '正文', level: 1 }],
      activeKey: 'h1',
      blocks: { table: true, code: false, mermaid: false, image: false },
    };
    for (const invalid of [
      { noteId: undefined },
      { items: [null] },
      { items: [{ key: 'bad', text: 'x', level: 7 }] },
      { activeKey: 'foreign-key' },
      { blocks: {} },
    ])
      f.receive({ type: 'outline', noteId: 'a', ...outline, ...invalid });
    expect(f.onOutline).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
    const load = f.bridge.load('a', document);
    f.receive({ type: 'loaded', noteId: 'a' });
    await load;
    f.bridge.dispose();
  });
  it('sends navigation with the current note identity and no document mutation', async () => {
    const f = fixture();
    await f.load('note-b');
    f.bridge.navigate('note-b', { heading: 'h2' });
    expect(f.target.postMessage).toHaveBeenCalledWith(
      { channel: NOTEBOOK_CHANNEL, token: 'nonce', type: 'navigate', noteId: 'note-b', loadId: f.last('load').loadId, heading: 'h2' },
      '*',
    );
    expect(f.onChange).not.toHaveBeenCalled();
    f.bridge.dispose();
    vi.mocked(f.target.postMessage).mockClear();
    f.bridge.navigate('note-b', { block: 'top' });
    expect(f.target.postMessage).not.toHaveBeenCalled();
  });

  it('routes document actions only to a loaded note and never to a replacement in flight', async () => {
    const f = fixture();
    f.bridge.action('a', 'style');
    expect(f.target.postMessage).not.toHaveBeenCalled();
    await f.load('a');
    const loadId = f.last('load').loadId;
    f.bridge.action('a', 'style');
    expect(f.last('action')).toEqual({channel: NOTEBOOK_CHANNEL, token: 'nonce', type: 'action', noteId: 'a', loadId, action: 'style'});
    f.bridge.title('a', '新标题');
    expect(f.last('title')).toEqual({channel: NOTEBOOK_CHANNEL, token: 'nonce', type: 'title', noteId: 'a', loadId, title: '新标题'});
    const replacement = f.bridge.load('b', document);
    vi.mocked(f.target.postMessage).mockClear();
    f.bridge.action('a', 'style');
    f.bridge.action('b', 'style');
    expect(f.target.postMessage).not.toHaveBeenCalled();
    f.receive({type: 'loaded', noteId: 'b', requestId: 'load-2', loadId: 'load-2'});
    await replacement;
    f.bridge.dispose();
    f.bridge.action('b', 'style');
    expect(f.target.postMessage).not.toHaveBeenCalled();
  });

  it('rejects replaced loads and ignores late acknowledgments, changes and errors for the same note', async () => {
    const f = fixture();
    const first = f.bridge.load('a', document);
    const replaced = expect(first).rejects.toThrow('已切换');
    const old = f.last('load');
    const second = f.bridge.load('a', document);
    const latest = f.last('load');
    f.receive({ type: 'loaded', noteId: 'a', requestId: old.requestId, loadId: old.loadId });
    f.receive({ type: 'error', noteId: 'a', requestId: old.requestId, loadId: old.loadId, message: 'stale failure' });
    expect(f.onLoaded).not.toHaveBeenCalled();
    expect(f.onError).not.toHaveBeenCalled();
    f.receive({ type: 'loaded', noteId: 'a', requestId: latest.requestId, loadId: latest.loadId });
    await second;
    await replaced;
    f.receive({ type: 'change', noteId: 'a', loadId: old.loadId, document });
    f.receive({ type: 'change', noteId: 'a', loadId: undefined, document });
    expect(f.onChange).not.toHaveBeenCalled();
    f.receive({ type: 'change', noteId: 'a', document });
    expect(f.onChange).toHaveBeenCalledOnce();
    f.bridge.dispose();
  });

  it('cannot let a timed-out load acknowledge a retry of the same note', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const first = f.bridge.load('a', document);
    const timedOut = expect(first).rejects.toThrow('未能完成加载');
    const old = f.last('load');
    await vi.advanceTimersByTimeAsync(10000);
    await timedOut;
    const second = f.bridge.load('a', document);
    f.receive({ type: 'loaded', noteId: 'a', requestId: old.requestId, loadId: old.loadId });
    expect(f.onLoaded).not.toHaveBeenCalled();
    f.receive({ type: 'loaded', noteId: 'a' });
    await second;
    f.bridge.dispose();
  });

  it('rejects malformed flush documents immediately and leaves no timeout behind', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.load('a');
    const flushed = f.bridge.flush();
    f.receive({ type: 'result', requestId: f.last('flush').requestId, noteId: 'a', document: null });
    await expect(flushed).rejects.toThrow('must be an object');
    expect(vi.getTimerCount()).toBe(0);
    f.bridge.dispose();
  });

  it('rejects closed and absent frames without scheduling dead requests', async () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const bridge = createEditorBridge({ token: 'nonce', target: () => null, onReady, onChange: vi.fn(), onError: vi.fn() });
    bridge.receive({ source: null, data: { channel: NOTEBOOK_CHANNEL, token: 'nonce', type: 'ready' } } as MessageEvent);
    expect(onReady).not.toHaveBeenCalled();
    await expect(bridge.load('a', document)).rejects.toThrow('尚未就绪');
    bridge.dispose();
    await expect(bridge.load('a', document)).rejects.toThrow('已关闭');
    await expect(bridge.flush()).rejects.toThrow('已关闭');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('writes the system clipboard for a sandboxed block copy and answers the frame', async () => {
    const f = fixture();
    await f.load('a');
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    class FakeClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    }
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    vi.stubGlobal('navigator', { clipboard: { write, writeText } });
    try {
      f.receive({ type: 'clipboard', requestId: 'copy-1', html: '<p>块</p>', text: '块' });
      await vi.waitFor(() => expect(f.last('clipboardResult')).toMatchObject({ requestId: 'copy-1', ok: true }));
      const [[items]] = write.mock.calls as [[Record<string, FakeClipboardItem>]];
      expect(Object.keys(items[0].items).sort()).toEqual(['text/html', 'text/plain']);
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      f.bridge.dispose();
    }
  });

  it('falls back to plain text and reports a failed clipboard write', async () => {
    const f = fixture();
    await f.load('a');
    const write = vi.fn().mockRejectedValue(new Error('denied'));
    vi.stubGlobal('ClipboardItem', undefined);
    vi.stubGlobal('navigator', { clipboard: { write, writeText: undefined } });
    try {
      f.receive({ type: 'clipboard', requestId: 'copy-2', html: '', text: '只有文本' });
      await vi.waitFor(() => expect(f.last('clipboardResult')).toMatchObject({ requestId: 'copy-2', ok: false }));
    } finally {
      vi.unstubAllGlobals();
      f.bridge.dispose();
    }
  });
});
