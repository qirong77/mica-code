import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import {
  normalizeState,
  contentId,
  describeCapture,
  shouldIgnoreCapture,
  recordCapture,
  pruneHistory,
} from './model.js';

const validId = (id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Private local history. Metadata and payloads use one cross-process transaction lock. */
export function createHistoryStore(directory) {
  const historyPath = join(directory, 'history.json');
  const clips = join(directory, 'clips');
  let cache = null;
  let signature = '';
  let queue = Promise.resolve();
  let disposed = false;
  const ready = mkdir(clips, { recursive: true, mode: 0o700 }).then(async () => {
    await chmod(directory, 0o700);
    await chmod(clips, 0o700);
  });

  const active = () => {
    if (disposed) throw new Error('剪贴板历史已关闭');
  };
  const payloadPath = (id) => {
    if (!validId(id)) throw new Error('剪贴板条目标识无效');
    return join(clips, `${id}.json`);
  };
  const thumbnailPath = (id) => `${payloadPath(id)}.thumbnail`;

  async function read() {
    await ready;
    active();
    let info;
    try {
      info = await stat(historyPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return normalizeState(null);
    }
    const current = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (cache && current === signature) return structuredClone(cache);
    let value;
    try {
      value = JSON.parse(await readFile(historyPath, 'utf8'));
    } catch {
      throw new Error('剪贴板历史无法读取，已保留原文件。请检查插件数据目录中的 history.json。');
    }
    const state = normalizeState(value);
    cache = state;
    signature = current;
    return structuredClone(state);
  }

  async function atomicWrite(path, value) {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      active();
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  function transact(operation) {
    const run = queue.then(async () => {
      await ready;
      active();
      let release;
      for (let attempt = 0; attempt < 30 && !release; attempt++) {
        active();
        release = acquireProcessLock(join(directory, 'history.lock'));
        if (!release) await wait(10 + attempt * 2);
      }
      if (!release) throw new Error('剪贴板历史正在被另一个窗口更新，请重试');
      try {
        // Re-read after acquiring the lock; a cached list is never the write base.
        signature = '';
        const previous = await read();
        const result = await operation(previous);
        const next = normalizeState(result.state);
        if (JSON.stringify(next) !== JSON.stringify(previous)) {
          await atomicWrite(historyPath, next);
          cache = null;
          signature = '';
          const retained = new Set(next.items.map((item) => item.id));
          for (const item of previous.items)
            if (!retained.has(item.id)) {
              await rm(payloadPath(item.id), { force: true });
              await rm(thumbnailPath(item.id), { force: true });
            }
        }
        return result.result ?? next;
      } finally {
        release();
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  return {
    read,
    /** @param {(state: ReturnType<typeof normalizeState>) => ReturnType<typeof normalizeState> | Promise<ReturnType<typeof normalizeState>>} operation */
    mutate(operation) {
      return transact(async (state) => ({ state: await operation(state) }));
    },
    async record(snapshot, settings, now = Date.now()) {
      return transact(async (state) => {
        if (state.paused || settings.ignoreEvents) return { state, result: { recorded: false } };
        if (state.ignoreNext)
          return { state: { ...state, ignoreNext: false }, result: { recorded: false, ignored: true } };
        if (!snapshot || shouldIgnoreCapture(snapshot, settings)) return { state, result: { recorded: false } };
        const summary = { id: contentId(snapshot.items), ...describeCapture(snapshot) };
        if (summary.bytes > settings.maxItemBytes) return { state, result: { recorded: false } };
        const next = recordCapture(state, summary, settings, now);
        if (!state.items.some((item) => item.id === summary.id)) {
          await atomicWrite(payloadPath(summary.id), { schemaVersion: 1, ...snapshot });
          if (
            typeof snapshot.thumbnail === 'string' &&
            snapshot.thumbnail.length <= 128 * 1024 &&
            /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(snapshot.thumbnail)
          ) {
            await atomicWrite(thumbnailPath(summary.id), snapshot.thumbnail);
          }
        }
        return { state: next, result: { recorded: true, id: summary.id } };
      });
    },
    prune: (settings, now = Date.now()) => transact((state) => ({ state: pruneHistory(state, settings, now) })),
    async payload(id) {
      const state = await read();
      if (!state.items.some((item) => item.id === id)) throw new Error('此剪贴板条目已被移除，请刷新列表');
      let snapshot;
      try {
        snapshot = JSON.parse(await readFile(payloadPath(id), 'utf8'));
      } catch {
        throw new Error('此条目的内容文件无法读取，原历史索引已保留');
      }
      if (snapshot?.schemaVersion !== 1 || !Array.isArray(snapshot.items)) throw new Error('此剪贴板内容形态不再支持');
      return snapshot;
    },
    async textIndex(items) {
      const result = new Map();
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, items.length) }, async () => {
          while (cursor < items.length) {
            const item = items[cursor++];
            try {
              const snapshot = JSON.parse(await readFile(payloadPath(item.id), 'utf8'));
              if (typeof snapshot.text === 'string') result.set(item.id, snapshot.text);
            } catch {
              /* List still exposes intact metadata; selecting a damaged item explains the error. */
            }
          }
        }),
      );
      return result;
    },
    async thumbnails(ids) {
      const state = await read();
      const available = new Set(state.items.filter((item) => item.kind === 'image').map((item) => item.id));
      const images = {};
      await Promise.all(
        [...new Set(ids)].slice(0, 24).map(async (id) => {
          if (!available.has(id)) return;
          try {
            images[id] = JSON.parse(await readFile(thumbnailPath(id), 'utf8'));
          } catch {
            /* A missing thumbnail never makes the original image unusable. */
          }
        }),
      );
      return images;
    },
    async collectOrphans() {
      await transact(async (state) => {
        const retained = new Set(state.items.flatMap((item) => [`${item.id}.json`, `${item.id}.json.thumbnail`]));
        for (const name of await readdir(clips)) {
          if (/^[a-f0-9]{64}\.json(?:\.thumbnail)?$/.test(name) && !retained.has(name))
            await rm(join(clips, name), { force: true });
        }
        return { state };
      });
    },
    async dispose() {
      disposed = true;
      await queue;
      await ready;
      cache = null;
    },
  };
}
