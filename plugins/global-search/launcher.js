import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createSearchEngine } from './search.js';

const MAX_RECENT = 30;
const MAX_WRITE_ATTEMPTS = 8;
const DEFAULT_EDITOR_APP = 'Visual Studio Code';
const EDITOR_OPEN_TIMEOUT_MS = 15_000;

function recentPaths(value) {
  if (!Array.isArray(value?.recent)) return [];
  return [...new Set(value.recent.filter((candidate) => typeof candidate === 'string'))].slice(0, MAX_RECENT);
}

/** 设置里的应用名：允许用户顺手写成 `Cursor.app`。 */
function editorApp(settings) {
  const raw = typeof settings?.editorApp === 'string' ? settings.editorApp.trim() : '';
  return (raw || DEFAULT_EDITOR_APP).replace(/\.app$/i, '');
}

/**
 * 应用没装时列表不该出现「用 VS Code 打开」那一行，所以先看 `.app` 在不在。非 macOS 没有
 * 这层目录约定（`code` 命令是否可用要看 PATH），交给打开失败去报，别把整块入口藏掉。
 */
function editorInstalled(app, options) {
  if ((options.platform || process.platform) !== 'darwin') return true;
  const exists = options.exists || existsSync;
  const home = options.home || homedir();
  return ['/Applications', '/System/Applications', join(home, 'Applications')].some((directory) =>
    exists(join(directory, `${app}.app`)),
  );
}

/**
 * 用应用打开：macOS 走 `open -a`（目录作为工作区、文件直接打开，不依赖 `code` 命令是否装进
 * PATH），其他平台走 VS Code 的 `code`。`open` 把「找不到应用」写在 stderr 上，所以等退出码
 * 再决定成败，别一句 spawn 成功就当打开了。
 */
function openWithEditor(app, target, options) {
  const spawnFn = options.spawn || spawn;
  const [command, args] =
    (options.platform || process.platform) === 'darwin' ? ['open', ['-a', app, target]] : ['code', [target]];
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let timer;
    let stderr = '';
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    timer = setTimeout(() => {
      child.kill?.();
      finish(new Error(`打开超时：${target}`));
    }, options.openTimeoutMs ?? EDITOR_OPEN_TIMEOUT_MS);
    timer.unref?.();
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 2_000) stderr += String(chunk);
    });
    child.on('error', (error) => finish(new Error(`无法启动 ${command}：${error?.message || error}`)));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `${command} 退出码 ${code}`));
    });
  });
}

/** Desktop runtime owns the window; this backend only searches and stores recents. */
export default function createLauncher(ctx, options = {}) {
  const engine = createSearchEngine(options);
  let disposed = false;
  let writeQueue = Promise.resolve();
  const ensureActive = () => {
    if (disposed) throw new Error('Global Search launcher has been disposed');
  };
  const editor = () => {
    const app = editorApp(ctx.settings.get());
    return { app, available: editorInstalled(app, options) };
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
        return { ...(await engine.search(ctx.settings.get(), input, recentPaths(snapshot.value))), editor: editor() };
      }
      // 后端仍然不替宿主打开文件：这个动作只负责「交给 VS Code」，Mica 那条路
      // 由页面调 openPath（外壳开一扇新编辑器窗口）。
      if (action === 'openEditor') {
        if (!input || typeof input.path !== 'string') throw new TypeError('openEditor.path must be a string');
        const app = editorApp(ctx.settings.get());
        if (!editorInstalled(app, options)) throw new Error(`没有找到 ${app}，可在插件设置里修改应用名`);
        const config = engine.normalize(ctx.settings.get());
        const item = await engine.validatePath(input.path, config.roots);
        if (!item) throw new Error('只能打开当前搜索目录内存在的文件或文件夹（不包含符号链接）');
        ensureActive();
        await openWithEditor(app, item.path, options);
        return { ok: true, app };
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
