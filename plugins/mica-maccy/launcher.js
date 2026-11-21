import { join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import { normalizeSettings, searchHistory, togglePin, renameItem, deleteItem, clearHistory } from './model.js';
import { createHistoryStore } from './store.js';
import { createNativeBridge } from './native.js';

const errorText = (error) => (error instanceof Error ? error.message : String(error));

/** Clipboard policy lives entirely in the plugin; the host only schedules and owns windows. */
export default function createLauncher(ctx, options = {}) {
  const platform = options.platform ?? process.platform;
  const supported = platform === 'darwin' && (!!process.env.MICA_SYSTEM_SOCKET || !!options.native);
  const store = options.store ?? createHistoryStore(ctx.dataDirectory);
  let disposed = false;
  let releaseObserver = null;
  let since = null;
  let lastError = '';
  let lastTray = '';
  let nextAttemptAt = 0;
  let failures = 0;
  let lastPruneAt = 0;
  let actionQueue = Promise.resolve();
  let polling = null;
  let cachedSearch = null;
  const settings = () => normalizeSettings(ctx.settings.get());
  const active = (signal) => {
    if (disposed) throw new Error('剪贴板插件已关闭');
    signal?.throwIfAborted();
  };
  const report = (error) => {
    lastError = errorText(error);
    ctx.health?.report({
      issueKey: 'clipboard',
      level: 'error',
      message: lastError,
      hint: '打开 Mica Maccy，检查状态后重试。',
    });
  };

  const native =
    options.native ??
    createNativeBridge({
      directory: join(ctx.dataDirectory, 'native'),
      onError: report,
      onActivate: async (modifiers) => {
        active();
        if (modifiers.altKey && modifiers.shiftKey) {
          await store.mutate((state) => ({ ...state, ignoreNext: true }));
        } else if (modifiers.altKey) {
          await store.mutate((state) => ({ ...state, paused: !state.paused }));
        } else await ctx.control('show');
      },
    });

  function nativeState() {
    return {
      supported,
      accessibility: native.capabilities?.()?.accessibility ?? null,
      error: !supported ? '剪贴板监听和回贴需要在 macOS 桌面版中使用。' : lastError,
    };
  }

  async function updateTray(state, config) {
    if (!releaseObserver) return;
    const value = { showTray: ctx.settings.get().showTray !== 'false', paused: state.paused || config.ignoreEvents };
    const key = JSON.stringify(value);
    if (key === lastTray) return;
    await native.request('tray', value);
    lastTray = key;
  }

  async function performPoll({ signal } = {}) {
    active(signal);
    if (!supported || Date.now() < nextAttemptAt) return { outcome: 'skipped', code: 'clipboard.unavailable' };
    if (!releaseObserver) releaseObserver = acquireProcessLock(join(ctx.dataDirectory, 'observer.lock'));
    if (!releaseObserver) return { outcome: 'skipped', code: 'clipboard.other_observer' };
    try {
      const config = settings();
      const capability = await native.start();
      active(signal);
      if (since === null) since = capability.changeCount;
      const state = await store.read();
      const response = await native.request('poll', {
        since,
        capture: !state.paused && !state.ignoreNext && !config.ignoreEvents,
        ignoredTypes: config.ignoredTypes,
        ignoredApplications: config.ignoredApplications,
        ignoreUniversalClipboard: config.ignoreUniversalClipboard,
        maxItemBytes: config.maxItemBytes,
      });
      active(signal);
      if (response.changed) {
        await store.record(response.snapshot ?? null, config);
        since = response.changeCount;
        cachedSearch = null;
      }
      if (Date.now() - lastPruneAt > 60_000) {
        await store.prune(config);
        lastPruneAt = Date.now();
      }
      await updateTray(await store.read(), config);
      if (lastError) ctx.health?.clear('clipboard');
      lastError = '';
      failures = 0;
      nextAttemptAt = 0;
      return { outcome: response.changed ? 'success' : 'skipped', code: 'clipboard.polled' };
    } catch (error) {
      if (disposed || signal?.aborted) return { outcome: 'cancelled', code: 'clipboard.stopped' };
      report(error);
      // Missing CLT or a broken helper must not recompile twice every second.
      nextAttemptAt = Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(++failures, 6));
      throw error;
    }
  }

  function poll(context) {
    if (polling) return polling;
    const operation = performPoll(context);
    polling = operation;
    void operation
      .finally(() => {
        if (polling === operation) polling = null;
      })
      .catch(() => {});
    return operation;
  }

  // An initialization promise is shared by background polling and foreground requests.
  const ready = store.collectOrphans?.() ?? Promise.resolve();
  void ready.catch(() => {});
  const task = ctx.background.register({
    id: 'clipboard',
    every: () => settings().clipboardCheckInterval,
    immediate: true,
    run: async (context) => {
      await ready;
      return poll(context);
    },
  });

  async function list(input, signal) {
    await ready;
    active(signal);
    const config = settings();
    const state = await store.read();
    let fullText;
    if (typeof input.query === 'string' && input.query.trim()) {
      const key = JSON.stringify(state.items.map((item) => [item.id, item.lastCopiedAt]));
      if (cachedSearch?.key === key) fullText = cachedSearch.text;
      else {
        fullText = await store.textIndex(state.items.filter((item) => item.kind === 'text'));
        cachedSearch = { key, text: fullText };
      }
    }
    active(signal);
    return {
      ...searchHistory(state, input, config, fullText),
      paused: state.paused || config.ignoreEvents,
      ignoreNext: state.ignoreNext,
      settings: {
        pasteAutomatically: config.pasteAutomatically,
        searchMode: config.searchMode,
        sortBy: config.sortBy,
        showFooter: config.showFooter,
        showPreview: config.showPreview,
      },
      native: nativeState(),
    };
  }

  async function select(input, signal) {
    if (!supported) throw new Error('复制到系统剪贴板需要在 macOS 桌面版中使用');
    const mode = input.mode ?? 'default';
    if (!['default', 'copy', 'paste', 'plain'].includes(mode)) throw new Error('未知复制方式');
    const config = settings();
    const selected = (await store.read()).items.find((item) => item.id === input.id);
    const snapshot = await store.payload(input.id);
    const shouldPaste = mode === 'paste' || mode === 'plain' || (mode === 'default' && config.pasteAutomatically);
    const plain = mode === 'plain' || (config.removeFormatting && selected?.kind === 'text');
    active(signal);
    const target = shouldPaste ? await native.request('frontmost') : null;
    active(signal);
    const written = await native.request('write', { snapshot, plain });
    // Our marker prevents self-capture; advancing the observer also avoids consuming
    // an explicit “ignore next copy” on an item selected from this plugin.
    if (releaseObserver) since = written.changeCount;
    active(signal);
    const now = Date.now();
    await store.mutate((state) => ({
      ...state,
      items: state.items.map((item) =>
        item.id === input.id ? { ...item, lastCopiedAt: now, copyCount: item.copyCount + 1 } : item,
      ),
    }));
    cachedSearch = null;
    if (!shouldPaste) {
      await ctx.control('close');
      return { ok: true, pasted: false };
    }
    // Check permission before hiding the window so the actionable error remains visible.
    const status = await native.request('status');
    if (!status.accessibility) {
      throw new Error('已复制到剪贴板。自动粘贴需要开启 Mica Code 的辅助功能权限，请点击设置完成授权。');
    }
    active(signal);
    await ctx.control('close');
    active(signal);
    try {
      await native.request('paste', { targetPid: target.pid });
      return { ok: true, pasted: true };
    } catch (error) {
      // A failed paste must return to an explainable, visible state.
      await ctx.control('show').catch(() => {});
      throw error;
    }
  }

  async function request(action, input = {}, { signal } = {}) {
    active(signal);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('剪贴板动作参数必须是对象');
    await ready;
    active(signal);
    if (action === 'list') return list(input, signal);
    if (action === 'thumbnails') {
      if (!Array.isArray(input.ids) || input.ids.length > 24 || input.ids.some((id) => typeof id !== 'string')) {
        throw new Error('每次最多读取 24 张图片缩略图');
      }
      return { images: await store.thumbnails(input.ids) };
    }
    if (action === 'detail') {
      const state = await store.read();
      const item = state.items.find((candidate) => candidate.id === input.id);
      if (!item) throw new Error('此条目已被移除，请刷新列表');
      const snapshot = await store.payload(input.id);
      active(signal);
      const image = supported && item.kind === 'image' ? await native.request('preview', { snapshot }) : {};
      return {
        item,
        text: snapshot.text ?? '',
        files: snapshot.files ?? [],
        types: snapshot.types ?? [],
        previewImage: snapshot.thumbnail ?? null,
        ...image,
      };
    }
    if (action === 'nativeStatus') {
      nextAttemptAt = 0;
      if (supported) {
        try {
          await poll({ signal });
        } catch {
          /* The current error is shown in the returned state. */
        }
        try {
          const status = await native.request('status');
          return { ...nativeState(), accessibility: status.accessibility === true };
        } catch (error) {
          report(error);
        }
      }
      return nativeState();
    }
    if (action === 'select') return select(input, signal);
    if (action === 'pin') await store.mutate((state) => togglePin(state, input.id));
    else if (action === 'rename') await store.mutate((state) => renameItem(state, input.id, input.title));
    else if (action === 'delete') await store.mutate((state) => deleteItem(state, input.id));
    else if (action === 'clear')
      await store.mutate((state) => clearHistory(state, { includePinned: input.includePinned === true }));
    else if (action === 'pause') {
      if (typeof input.paused !== 'boolean') throw new Error('暂停状态必须是布尔值');
      if (!input.paused && settings().ignoreEvents) await ctx.settings.set({ ignoreEvents: 'false' });
      await store.mutate((state) => ({ ...state, paused: input.paused }));
    } else if (action === 'ignoreNext') await store.mutate((state) => ({ ...state, ignoreNext: true }));
    else throw new Error(`未知剪贴板动作：${action}`);
    cachedSearch = null;
    return { ok: true };
  }

  return {
    request(action, input, context) {
      // Reads may overlap, but writes/selects remain ordered within this instance.
      if (['list', 'detail', 'thumbnails'].includes(action)) return request(action, input, context);
      const operation = actionQueue.then(() => request(action, input, context));
      actionQueue = operation.catch(() => {});
      return operation;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      task.dispose();
      await native.dispose();
      await polling?.catch(() => {});
      await actionQueue;
      await store.dispose();
      releaseObserver?.();
      releaseObserver = null;
      cachedSearch = null;
    },
  };
}
