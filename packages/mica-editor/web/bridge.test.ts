import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownBridge, type MarkdownEditorStatus } from './bridge.js';
import { MARKDOWN_CHANNEL } from '../protocol.js';

function fixture(value = '# Original\r\n\r\n', readOnly = false) {
  const target = { postMessage: vi.fn() } as unknown as Window;
  const changes = vi.fn();
  const statuses = vi.fn<(status: MarkdownEditorStatus, message?: string) => void>();
  const bridge = createMarkdownBridge({ token: 'secret', target: () => target, onChange: changes, onStatus: statuses, timeoutMs: 100 });
  const send = (data: Record<string, unknown>, overrides: Record<string, unknown> = {}) => bridge.receive({
    source: target,
    data: { channel: MARKDOWN_CHANNEL, token: 'secret', ...data },
    ...overrides,
  } as MessageEvent);
  const messages = () => vi.mocked(target.postMessage).mock.calls.map(([message]) => message as Record<string, unknown>);
  const last = (type: string) => messages().filter((message) => message.type === type).at(-1)!;
  bridge.setDocument({ documentId: 'a', value, readOnly });
  const loaded = (id = 'a') => send({ type: 'loaded', requestId: last('load').requestId, documentId: id });
  return { bridge, changes, statuses, target, send, last, loaded, messages };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('Markdown iframe bridge', () => {
  it('preserves source during hydration and validates the source window, channel and token', () => {
    const f = fixture();
    f.send({ type: 'ready' }, { source: {} });
    f.send({ type: 'ready', token: 'wrong' });
    f.send({ type: 'ready', channel: 'wrong' });
    expect(f.messages()).toEqual([]);
    f.send({ type: 'ready' });
    expect(f.last('load')).toMatchObject({ documentId: 'a', value: '# Original\r\n\r\n', readOnly: false });
    f.send({ type: 'change', documentId: 'a', value: '' });
    f.loaded();
    expect(f.changes).not.toHaveBeenCalled();
    expect(f.bridge.getValue()).toBe('# Original\r\n\r\n');
    f.bridge.dispose();
  });

  it('waits for readiness, load acknowledgement and flush, notifying before resolution', async () => {
    const f = fixture();
    const flushed = f.bridge.flush();
    f.send({ type: 'ready' });
    await Promise.resolve();
    expect(f.last('flush')).toBeUndefined();
    f.loaded();
    await vi.advanceTimersByTimeAsync(0);
    const request = f.last('flush');
    expect(request).toBeDefined();
    f.send({ type: 'result', requestId: request.requestId, documentId: 'a', value: 'Last keystroke' });
    expect(f.changes).toHaveBeenCalledWith('a', 'Last keystroke');
    await expect(flushed).resolves.toBe('Last keystroke');
    f.bridge.dispose();
  });

  it('does not rehydrate or reset undo when controlled values echo changes', () => {
    const f = fixture('initial');
    f.send({ type: 'ready' });
    f.loaded();
    f.send({ type: 'change', documentId: 'a', value: 'one' });
    f.send({ type: 'change', documentId: 'a', value: 'two' });
    f.bridge.setDocument({ documentId: 'a', value: 'one', readOnly: false });
    f.bridge.setDocument({ documentId: 'a', value: 'two', readOnly: false });
    expect(f.messages().filter((message) => message.type === 'load')).toHaveLength(1);
    expect(f.bridge.getValue()).toBe('two');
    f.bridge.setDocument({ documentId: 'a', value: 'external revision', readOnly: false });
    expect(f.messages().filter((message) => message.type === 'load')).toHaveLength(2);
    f.bridge.dispose();
  });

  it('isolates rapid document switches and rejects stale load/flush results', async () => {
    const f = fixture();
    f.send({ type: 'ready' });
    f.loaded();
    const oldFlush = f.bridge.flush();
    const rejection = expect(oldFlush).rejects.toThrow('文档已切换');
    await vi.advanceTimersByTimeAsync(0);
    const oldRequest = f.last('flush');
    f.bridge.setDocument({ documentId: 'b', value: 'Second', readOnly: false });
    f.send({ type: 'change', documentId: 'a', value: 'Stale' });
    f.send({ type: 'result', documentId: 'a', requestId: oldRequest.requestId, value: 'Stale result' });
    f.loaded('b');
    await rejection;
    expect(f.bridge.getValue()).toBe('Second');
    expect(f.changes).not.toHaveBeenCalled();
    f.bridge.setDocument({ documentId: 'c', value: 'Third', readOnly: false });
    const cLoad = f.last('load');
    f.bridge.setDocument({ documentId: 'b', value: 'Second again', readOnly: false });
    f.send({ type: 'loaded', documentId: 'c', requestId: cLoad.requestId });
    expect(f.statuses.mock.lastCall?.[0]).toBe('loading');
    f.loaded('b');
    expect(f.bridge.getValue()).toBe('Second again');
    f.bridge.dispose();
  });

  it('never accepts edits in read-only documents, including flush results and fallback input', async () => {
    const f = fixture('Default prompt', true);
    f.send({ type: 'ready' });
    f.loaded();
    f.send({ type: 'change', documentId: 'a', value: 'Override' });
    const flushed = f.bridge.flush();
    await vi.advanceTimersByTimeAsync(0);
    f.send({ type: 'result', documentId: 'a', requestId: f.last('flush').requestId, value: 'Override' });
    await expect(flushed).resolves.toBe('Default prompt');
    f.bridge.fail('Offline');
    f.bridge.editSource('Override');
    expect(f.changes).not.toHaveBeenCalled();
    expect(f.bridge.getValue()).toBe('Default prompt');
    f.bridge.dispose();
  });

  it('keeps source editable after CDN timeout and ignores late iframe messages', async () => {
    const f = fixture('---\nname: test\n---\n\nOriginal\n');
    const flushed = f.bridge.flush();
    const rejection = expect(flushed).rejects.toThrow('加载超时');
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(f.bridge.getValue()).toBe('---\nname: test\n---\n\nOriginal\n');
    expect(f.statuses.mock.lastCall?.[0]).toBe('fallback');
    f.bridge.editSource('---\nname: test\n---\n\nEdited\n');
    f.send({ type: 'ready' });
    f.send({ type: 'change', documentId: 'a', value: 'Late runtime' });
    await expect(f.bridge.flush()).resolves.toBe('---\nname: test\n---\n\nEdited\n');
    expect(f.changes).toHaveBeenCalledTimes(1);
    f.bridge.dispose();
  });

  it('rejects an unacknowledged flush and preserves the last emitted input', async () => {
    const f = fixture();
    f.send({ type: 'ready' });
    f.loaded();
    f.send({ type: 'change', documentId: 'a', value: 'Last received' });
    const flushed = f.bridge.flush();
    const rejection = expect(flushed).rejects.toThrow('未响应');
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(f.bridge.getValue()).toBe('Last received');
    f.bridge.dispose();
  });

  it('sends editability and resolved host theme without reloading a document', () => {
    const f = fixture();
    f.send({ type: 'ready' });
    f.loaded();
    f.bridge.setDocument({ documentId: 'a', value: '# Original\r\n\r\n', readOnly: true });
    f.bridge.theme('dark', { '--color-canvas': 'rgb(30, 30, 46)' });
    expect(f.last('editable')).toMatchObject({ readOnly: true });
    expect(f.last('theme')).toMatchObject({ appearance: 'dark', tokens: { '--color-canvas': 'rgb(30, 30, 46)' } });
    expect(f.messages().filter((message) => message.type === 'load')).toHaveLength(1);
    f.bridge.dispose();
  });
});
