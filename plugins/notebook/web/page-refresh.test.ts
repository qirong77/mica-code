import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotebookExternalUpdateCheck } from '../external-updates';
import { createNotebookPageRefresh } from './page-refresh';
import { createNotebookDraft } from '../writer';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(
  check: () => Promise<void> = vi.fn(async () => {}),
  visibilityState: DocumentVisibilityState = 'visible',
) {
  const page = Object.assign(new EventTarget(), { visibilityState });
  const window = new EventTarget();
  const refresh = createNotebookPageRefresh({ page, window, check });
  return {
    page,
    window,
    refresh,
    check,
    visibility(state: DocumentVisibilityState) {
      page.visibilityState = state;
      page.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('Notebook page refresh lifecycle', () => {
  it('reuses the initial load, merges restoration events and schedules from completion', async () => {
    vi.useFakeTimers();
    const work = deferred<void>();
    const check = vi.fn(() => work.promise);
    const fixture = setup(check);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(check).not.toHaveBeenCalled();

    fixture.window.dispatchEvent(new Event('focus'));
    fixture.window.dispatchEvent(new Event('mica:transport-resync'));
    fixture.page.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(80);
    expect(check).toHaveBeenCalledTimes(1);
    // A slow request does not create overlapping periodic reads.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(check).toHaveBeenCalledTimes(1);
    work.resolve();
    await vi.advanceTimersByTimeAsync(30_080);
    expect(check).toHaveBeenCalledTimes(2);
    fixture.refresh.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not read or retain polling timers while hidden, including session exit requests', async () => {
    vi.useFakeTimers();
    const fixture = setup(undefined, 'hidden');
    fixture.refresh.request();
    fixture.window.dispatchEvent(new Event('focus'));
    fixture.window.dispatchEvent(new Event('mica:transport-resync'));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fixture.check).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    fixture.visibility('visible');
    await vi.advanceTimersByTimeAsync(80);
    expect(fixture.check).toHaveBeenCalledTimes(1);
    fixture.refresh.request();
    fixture.visibility('hidden');
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fixture.check).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    fixture.refresh.dispose();
  });

  it('does not continue to fetch a body when hidden during the index read; restores with a fresh check', async () => {
    vi.useFakeTimers();
    const indexRead = deferred<void>();
    const readVersion = vi.fn(async () => 'new');
    const changed = vi.fn();
    const draft = createNotebookDraft('note', {
      value: { version: 1, editorState: null },
      version: 'old',
      missing: false,
    });
    let visible = true;
    const observer = createNotebookExternalUpdateCheck({
      available: () => visible,
      waitForWrites: async () => {},
      refreshIndex: () => indexRead.promise,
      current: () => draft,
      readVersion,
      changed,
      error: vi.fn(),
    });
    const fixture = setup(() => observer.check());
    fixture.refresh.request();
    await vi.advanceTimersByTimeAsync(80);
    visible = false;
    fixture.visibility('hidden');
    indexRead.resolve();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(readVersion).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    visible = true;
    fixture.visibility('visible');
    fixture.window.dispatchEvent(new Event('mica:transport-resync'));
    await vi.advanceTimersByTimeAsync(80);
    expect(readVersion).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith('note');
    fixture.refresh.dispose();
    observer.dispose();
  });

  it('ignores a late body result after the selected draft changes and cancels listeners on disposal', async () => {
    vi.useFakeTimers();
    const versionRead = deferred<string>();
    const changed = vi.fn();
    let current = createNotebookDraft('first', {
      value: { version: 1, editorState: null },
      version: 'old',
      missing: false,
    });
    const observer = createNotebookExternalUpdateCheck({
      available: () => true,
      waitForWrites: async () => {},
      refreshIndex: async () => {},
      current: () => current,
      readVersion: () => versionRead.promise,
      changed,
      error: vi.fn(),
    });
    const check = vi.fn(() => observer.check());
    const fixture = setup(check);
    fixture.refresh.request();
    await vi.advanceTimersByTimeAsync(80);
    current = createNotebookDraft('second', {
      value: { version: 1, editorState: null },
      version: 'replacement',
      missing: false,
    });
    versionRead.resolve('new');
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).not.toHaveBeenCalled();

    fixture.refresh.dispose();
    observer.dispose();
    fixture.visibility('visible');
    fixture.window.dispatchEvent(new Event('focus'));
    fixture.window.dispatchEvent(new Event('mica:transport-resync'));
    fixture.refresh.request();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(check).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
