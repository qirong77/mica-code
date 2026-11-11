import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorBridge, NOTEBOOK_CHANNEL } from './bridge';

const document = { version: 1 as const, editorState: null, comments: [] };
function fixture() {
  const target = { postMessage: vi.fn() } as unknown as Window;
  const onReady = vi.fn(),
    onChange = vi.fn(),
    onError = vi.fn(),
    onOutline = vi.fn();
  const bridge = createEditorBridge({ token: 'nonce', target: () => target, onReady, onChange, onError, onOutline });
  const receive = (data: Record<string, unknown>, source: unknown = target) =>
    bridge.receive({ source, data: { channel: NOTEBOOK_CHANNEL, token: 'nonce', ...data } } as MessageEvent);
  return { target, onReady, onChange, onError, onOutline, bridge, receive };
}
afterEach(() => vi.useRealTimers());

describe('Notebook iframe boundary', () => {
  it('ignores foreign frames and forged nonces', () => {
    const f = fixture();
    f.receive({ type: 'ready' }, {});
    f.receive({ type: 'ready', token: 'wrong' });
    expect(f.onReady).not.toHaveBeenCalled();
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
  it('surfaces source-mode failures without completing the flush', async () => {
    const f = fixture();
    const flush = f.bridge.flush();
    const payload = vi.mocked(f.target.postMessage).mock.calls.at(-1)![0] as { requestId: string };
    f.receive({ type: 'error', requestId: payload.requestId, message: '请返回富文本模式' });
    await expect(flush).rejects.toThrow('富文本');
    expect(f.onError).toHaveBeenCalledWith('请返回富文本模式');
    f.bridge.dispose();
  });
  it('keeps the newest oversized draft exportable instead of discarding the change', () => {
    const f = fixture();
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
    const request = f.bridge.flush();
    const rejected = expect(request).rejects.toThrow('没有响应');
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    const load = f.bridge.load('a', document);
    const closed = expect(load).rejects.toThrow('已关闭');
    f.bridge.dispose();
    await closed;
  });
  it('keeps outline metadata separate from saved content and authenticates its sender', () => {
    const f = fixture();
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
  it('sends navigation with the current note identity and no document mutation', () => {
    const f = fixture();
    f.bridge.navigate('note-b', { heading: 'h2' });
    expect(f.target.postMessage).toHaveBeenCalledWith(
      { channel: NOTEBOOK_CHANNEL, token: 'nonce', type: 'navigate', noteId: 'note-b', heading: 'h2' },
      '*',
    );
    expect(f.onChange).not.toHaveBeenCalled();
    f.bridge.dispose();
    vi.mocked(f.target.postMessage).mockClear();
    f.bridge.navigate('note-b', { block: 'top' });
    expect(f.target.postMessage).not.toHaveBeenCalled();
  });
});
