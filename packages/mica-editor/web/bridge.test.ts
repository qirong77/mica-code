import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMarkdownBridge, createMarkdownEchoHistory, MARKDOWN_ECHO_LIMIT, type MarkdownEditorStatus } from './bridge.js';
import { MARKDOWN_CHANNEL } from '../protocol.js';

function fixture(value = '# Original\r\n\r\n', readOnly = false) {
  const target = { postMessage: vi.fn() } as unknown as Window;
  const changes = vi.fn();
  const saves = vi.fn();
  const statuses = vi.fn<(status: MarkdownEditorStatus, message?: string) => void>();
  const bridge = createMarkdownBridge({ token: 'secret', target: () => target, onChange: changes, onSave: saves, onStatus: statuses, timeoutMs: 100 });
  const send = (data: Record<string, unknown>, overrides: Record<string, unknown> = {}) => bridge.receive({
    source: target,
    data: { channel: MARKDOWN_CHANNEL, token: 'secret', loadId: last('load')?.requestId, ...data },
    ...overrides,
  } as MessageEvent);
  const messages = () => vi.mocked(target.postMessage).mock.calls.map(([message]) => message as Record<string, unknown>);
  const last = (type: string) => messages().filter((message) => message.type === type).at(-1)!;
  bridge.setDocument({ documentId: 'a', value, readOnly });
  const loaded = (id = 'a') => send({ type: 'loaded', requestId: last('load').requestId, documentId: id });
  return { bridge, changes, saves, statuses, target, send, last, loaded, messages };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('Markdown iframe bridge', () => {
  it('accepts the shortcut snapshot before invoking the host save, including an initially clean file', () => {
    const f = fixture('initial');
    f.send({ type: 'ready' });
    f.loaded();
    f.saves.mockImplementation(() => expect(f.bridge.getValue()).toBe('last input'));
    f.send({ type: 'save', documentId: 'a', value: 'last input' });
    expect(f.changes).toHaveBeenCalledWith('a', 'last input');
    expect(f.saves).toHaveBeenCalledWith('a', 'last input');
    expect(f.changes.mock.invocationCallOrder[0]).toBeLessThan(f.saves.mock.invocationCallOrder[0]);
    f.send({ type: 'save', documentId: 'a', value: 'last input' });
    expect(f.changes).toHaveBeenCalledTimes(1);
    expect(f.saves).toHaveBeenCalledTimes(2);
    f.bridge.dispose();
  });

  it('ignores save requests before load and from stale, readonly or unauthenticated documents', () => {
    const f = fixture('original');
    const request = { type: 'save', documentId: 'a', value: 'wrong' };
    f.send(request);
    f.send({ type: 'ready' });
    f.send(request);
    f.loaded();
    f.send(request, { source: {} });
    f.send({ ...request, token: 'wrong' });
    f.send({ ...request, channel: 'wrong' });
    f.send({ ...request, documentId: 'old' });
    f.send({ ...request, value: null });
    f.bridge.setDocument({ documentId: 'a', value: 'original', readOnly: true });
    f.send(request);
    expect(f.changes).not.toHaveBeenCalled();
    expect(f.saves).not.toHaveBeenCalled();
    expect(f.bridge.getValue()).toBe('original');
    f.bridge.dispose();
  });

  it('does not save the wrong document if change handling switches documents synchronously', () => {
    const f = fixture('initial');
    f.send({ type: 'ready' });
    f.loaded();
    f.changes.mockImplementation(() => f.bridge.setDocument({ documentId: 'b', value: 'other', readOnly: false }));
    f.send({ type: 'save', documentId: 'a', value: 'last input' });
    expect(f.saves).not.toHaveBeenCalled();
    expect(f.bridge.getValue()).toBe('other');
    f.bridge.dispose();
  });

  it('bounds delayed echo memory while retaining recent controlled updates', () => {
    const history = createMarkdownEchoHistory();
    for (let index = 0; index < MARKDOWN_ECHO_LIMIT * 2; index++) history.remember(`revision ${index}`);
    expect(history.size).toBe(MARKDOWN_ECHO_LIMIT);
    expect(history.consume('revision 0')).toBe(false);
    expect(history.consume(`revision ${MARKDOWN_ECHO_LIMIT * 2 - 2}`)).toBe(true);
    expect(history.size).toBe(1);
    expect(history.consume(`revision ${MARKDOWN_ECHO_LIMIT * 2 - 1}`)).toBe(true);
    expect(history.size).toBe(0);
  });

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

  it('ignores changes and save shortcuts from a replaced editor of the same document', () => {
    const f = fixture('initial');
    f.send({ type: 'ready' });
    f.loaded();
    const previous = f.last('load').requestId;
    f.bridge.setDocument({ documentId: 'a', value: 'external replacement', readOnly: false });
    f.loaded();
    f.send({ type: 'change', documentId: 'a', loadId: previous, value: 'stale editor' });
    f.send({ type: 'save', documentId: 'a', loadId: previous, value: 'stale editor' });
    f.send({ type: 'change', documentId: 'a', loadId: undefined, value: 'missing identity' });
    expect(f.changes).not.toHaveBeenCalled();
    expect(f.saves).not.toHaveBeenCalled();
    expect(f.bridge.getValue()).toBe('external replacement');
    f.send({ type: 'change', documentId: 'a', value: 'fresh editor' });
    expect(f.changes).toHaveBeenCalledWith('a', 'fresh editor');
    f.bridge.dispose();
  });

  it('rejects the old flush if accepting its last input synchronously switches documents', async () => {
    const f = fixture('initial');
    f.send({ type: 'ready' });
    f.loaded();
    const flushed = f.bridge.flush();
    const switched = expect(flushed).rejects.toThrow('文档已切换');
    await vi.advanceTimersByTimeAsync(0);
    f.changes.mockImplementation(() => f.bridge.setDocument({ documentId: 'b', value: 'other file', readOnly: false }));
    f.send({ type: 'result', documentId: 'a', requestId: f.last('flush').requestId, value: 'last input' });
    await switched;
    expect(f.bridge.getValue()).toBe('other file');
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
