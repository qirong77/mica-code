import { createSearchEngine } from './search.js';

const MAX_RECENT = 30;
const MAX_WRITE_ATTEMPTS = 8;

function recentPaths(value) {
  if (!Array.isArray(value?.recent)) return [];
  return [...new Set(value.recent.filter((candidate) => typeof candidate === 'string'))].slice(0, MAX_RECENT);
}

/** Desktop runtime owns the window; this backend only searches and stores recents. */
export default function createLauncher(ctx, options = {}) {
  const engine = createSearchEngine(options);
  let disposed = false;
  let writeQueue = Promise.resolve();
  const ensureActive = () => {
    if (disposed) throw new Error('Global Search launcher has been disposed');
  };
  const remember = async (candidate) => {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
      ensureActive();
      const config = engine.normalize(ctx.settings.get());
      const item = await engine.validatePath(candidate, config.roots);
      if (!item) throw new Error('只能记住当前搜索目录内存在的文件或文件夹（不包含符号链接）');
      const snapshot = await ctx.readData();
      const previous =
        snapshot.value && typeof snapshot.value === 'object' && !Array.isArray(snapshot.value) ? snapshot.value : {};
      const recent = [item.path, ...recentPaths(previous).filter((filePath) => filePath !== item.path)].slice(
        0,
        MAX_RECENT,
      );
      ensureActive();
      const result = await ctx.writeData({ ...previous, recent }, { expectedVersion: snapshot.version });
      if (result?.conflict === true) continue;
      if (result?.ok !== true) throw new Error(result?.error || '保存最近记录失败');
      return { ok: true };
    }
    throw new Error('最近记录正在被其他窗口更新，请重试');
  };
  return {
    async request(action, input = {}) {
      ensureActive();
      if (action === 'search') {
        if (!input || typeof input.query !== 'string') throw new TypeError('search.query must be a string');
        const snapshot = await ctx.readData();
        ensureActive();
        return engine.search(ctx.settings.get(), input, recentPaths(snapshot.value));
      }
      if (action === 'remember') {
        if (!input || typeof input.path !== 'string') throw new TypeError('remember.path must be a string');
        const operation = writeQueue.then(() => remember(input.path));
        writeQueue = operation.catch(() => {});
        return operation;
      }
      throw new Error(`Unknown Global Search action: ${action}`);
    },
    dispose() {
      disposed = true;
      engine.dispose();
    },
  };
}
