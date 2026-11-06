import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_SETTINGS = Object.freeze({
  searchDirectories: '~/Desktop\n~/Documents\n~/Downloads',
  maxDepth: 6,
});
export const DEFAULT_LIMITS = Object.freeze({ entries: 50_000, directories: 10_000, milliseconds: 8_000 });
const CACHE_MILLISECONDS = 30_000;
const ACCESS_COOLDOWN_MILLISECONDS = 10 * 60_000;
const MAX_RESULTS = 80;
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  'Library',
  '__pycache__',
  'venv',
  'Pods',
  'bower_components',
]);
const collator = new Intl.Collator('zh-Hans-u-co-pinyin', { numeric: true, sensitivity: 'base' });

export function normalizeSettings(settings = {}, home = homedir()) {
  settings = settings || {};
  const raw =
    typeof settings.searchDirectories === 'string' ? settings.searchDirectories : DEFAULT_SETTINGS.searchDirectories;
  const roots = [];
  const warnings = [];
  for (const line of raw.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    const expanded = value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
    if (!path.isAbsolute(expanded)) {
      warnings.push(`目录必须是绝对路径或以 ~/ 开头：${value}`);
      continue;
    }
    const normalized = path.resolve(expanded);
    if (!roots.includes(normalized)) roots.push(normalized);
  }
  const depth = settings.maxDepth === '' || settings.maxDepth == null ? 6 : Number(settings.maxDepth);
  const maxDepth = Number.isFinite(depth) ? Math.max(1, Math.min(16, Math.trunc(depth))) : 6;
  return { roots, maxDepth, warnings };
}

export function isWithinRoots(candidate, roots) {
  return roots.some((root) => {
    const relative = path.relative(root, candidate);
    return (
      relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  });
}

function itemFor(filePath, type) {
  return { path: filePath, name: path.basename(filePath) || filePath, type };
}

function warningFor(operation, filePath, error) {
  return `${operation}：${filePath} (${error?.code || error?.message || 'unknown error'})`;
}

/** Roots are depth 0; maxDepth 1 includes their immediate children. */
export async function scanDirectories(config, options = {}) {
  const fs = options.fs || nodeFs;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now || Date.now;
  const deadline = now() + limits.milliseconds;
  const deniedUntil = options.deniedUntil || new Map();
  const items = [];
  const topLevel = new Set();
  const warnings = [];
  const seen = new Set();
  const visited = new Map();
  const queue = [];
  let directories = 0;
  let truncated = false;
  const budgetError = new Error('scan budget exhausted');
  const disposedError = new Error('scan disposed');
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(budgetError), limits.milliseconds);
  });
  // A deadline can expire between filesystem operations. Keep the rejection handled.
  timeout.catch(() => {});
  const warn = (message) => {
    if (warnings.length < 100 && !warnings.includes(message)) warnings.push(message);
  };
  const cooling = (directory) => {
    if ((deniedUntil.get(directory) || 0) <= now()) {
      deniedUntil.delete(directory);
      return false;
    }
    warn(`目录访问被系统拒绝，冷却期间暂不重试：${directory}（稍后自动重试）`);
    return true;
  };
  const warnAccess = (operation, directory, error) => {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      if (deniedUntil.size < 10_000) deniedUntil.set(directory, now() + ACCESS_COOLDOWN_MILLISECONDS);
    }
    warn(warningFor(operation, directory, error));
  };
  const check = () => {
    if (options.isDisposed?.()) throw disposedError;
    if (now() >= deadline) throw budgetError;
  };
  const io = async (operation) => {
    check();
    const result = await Promise.race([operation(), timeout]);
    check();
    return result;
  };
  const add = (filePath, type) => {
    if (seen.has(filePath)) return;
    if (items.length >= limits.entries) throw budgetError;
    seen.add(filePath);
    items.push(itemFor(filePath, type));
  };
  const shouldSkipDirectory = (name) => name.startsWith('.') || IGNORED_DIRECTORIES.has(name);
  try {
    for (const root of config.roots) {
      check();
      if (cooling(root)) continue;
      try {
        const stat = await io(() => fs.lstat(root));
        if (stat.isSymbolicLink()) {
          warn(`忽略符号链接目录：${root}`);
        } else if (!stat.isDirectory()) {
          warn(`搜索根目录不是文件夹：${root}`);
        } else {
          add(root, 'directory');
          queue.push({ directory: root, depth: 0 });
        }
      } catch (error) {
        if (error === budgetError || error === disposedError) throw error;
        warnAccess('无法访问搜索根目录', root, error);
      }
    }
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      check();
      const { directory, depth } = queue[cursor];
      if (cooling(directory)) continue;
      const remaining = config.maxDepth - depth;
      if ((visited.get(directory) ?? -1) >= remaining) continue;
      if (directories >= limits.directories) throw budgetError;
      visited.set(directory, remaining);
      directories += 1;
      let children;
      try {
        // Recheck before reading: a directory may have become a symlink since enumeration.
        const stat = await io(() => fs.lstat(directory));
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
        children = await io(() => fs.readdir(directory, { withFileTypes: true }));
      } catch (error) {
        if (error === budgetError || error === disposedError) throw error;
        warnAccess('无法读取目录', directory, error);
        continue;
      }
      for (const child of children) {
        check();
        if (child.isSymbolicLink()) continue;
        const filePath = path.join(directory, child.name);
        let type = child.isDirectory() ? 'directory' : child.isFile() ? 'file' : null;
        if (!type) {
          try {
            const stat = await io(() => fs.lstat(filePath));
            if (stat.isSymbolicLink()) continue;
            type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null;
          } catch (error) {
            if (error === budgetError || error === disposedError) throw error;
            warn(warningFor('无法访问路径', filePath, error));
            continue;
          }
        }
        if (!type || (type === 'directory' && shouldSkipDirectory(child.name))) continue;
        add(filePath, type);
        if (type === 'directory') {
          if (depth === 0) topLevel.add(filePath);
          if (depth + 1 < config.maxDepth) queue.push({ directory: filePath, depth: depth + 1 });
          else truncated = true;
        }
      }
    }
  } catch (error) {
    if (error === disposedError) throw new Error('Global Search launcher has been disposed');
    if (error !== budgetError) throw error;
    truncated = true;
    warn(
      `扫描达到预算限制（${limits.entries} 条目 / ${limits.directories} 目录 / ${limits.milliseconds}ms），结果可能不完整`,
    );
  } finally {
    clearTimeout(timer);
  }
  if (truncated && !warnings.some((message) => message.includes('预算限制'))) {
    warn(`已达到最大搜索深度 ${config.maxDepth}，更深层目录未扫描`);
  }
  return { items, topLevel, warnings, truncated };
}

/** Validate each component beneath a configured root; never follow a child symlink. */
export async function validateRecentPath(candidate, roots, options = {}) {
  const controller = new AbortController();
  let timer;
  let onAbort;
  const parentSignal = options.signal;
  try {
    if (parentSignal?.aborted) throw new Error('Global Search launcher has been disposed');
    const timeout = new Promise((_, reject) => {
      const fail = (message) => {
        controller.abort();
        reject(new Error(message));
      };
      onAbort = () => fail('Global Search launcher has been disposed');
      parentSignal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => fail(`最近路径校验超时，已跳过：${candidate}`), options.timeoutMs ?? 1500);
    });
    return await Promise.race([
      validateRecentPathUnbounded(candidate, roots, { ...options, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onAbort);
  }
}

async function validateRecentPathUnbounded(candidate, roots, options = {}) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return null;
  const normalized = path.resolve(candidate);
  const matchingRoots = roots.filter((root) => isWithinRoots(normalized, [root]));
  const fs = options.fs || nodeFs;
  for (const root of matchingRoots) {
    try {
      if (options.signal?.aborted) return null;
      const rootStat = await fs.lstat(root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) continue;
      let stat = rootStat;
      let current = root;
      const relative = path.relative(root, normalized);
      for (const component of relative ? relative.split(path.sep) : []) {
        if (options.signal?.aborted) return null;
        if (!stat.isDirectory()) throw new Error('Parent is not a directory');
        current = path.join(current, component);
        stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error('Symbolic links are excluded');
      }
      if (stat.isDirectory() || stat.isFile()) return itemFor(normalized, stat.isDirectory() ? 'directory' : 'file');
    } catch {
      // Removed paths, permissions, and symlinks are omitted from recent results.
    }
  }
  return null;
}

function subsequenceScore(text, query) {
  let cursor = 0;
  let first = -1;
  let last = -1;
  for (const character of query) {
    const index = text.indexOf(character, cursor);
    if (index < 0) return null;
    if (first < 0) first = index;
    last = index;
    cursor = index + character.length;
  }
  return (first < 0 ? 0 : first) + Math.max(0, last - first + 1 - query.length);
}

function matchScore(item, query) {
  const name = item.name.toLocaleLowerCase();
  const filePath = item.path.toLocaleLowerCase();
  const nameIndex = name.indexOf(query);
  if (nameIndex >= 0) return [name === query ? 0 : 1, nameIndex];
  const nameSequence = subsequenceScore(name, query);
  if (nameSequence !== null) return [2, nameSequence];
  const pathIndex = filePath.indexOf(query);
  if (pathIndex >= 0) return [3, pathIndex];
  const pathSequence = subsequenceScore(filePath, query);
  return pathSequence === null ? null : [4, pathSequence];
}

export function rankItems(index, query, recentItems = [], roots = []) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const compare = (a, b) => collator.compare(a.name, b.name) || collator.compare(a.path, b.path);
  if (!normalizedQuery) {
    const result = [];
    const seen = new Set();
    const add = (item) => {
      if (!seen.has(item.path)) {
        seen.add(item.path);
        result.push(item);
      }
    };
    recentItems.forEach(add);
    const rootSet = new Set(roots);
    index.items
      .filter((item) => rootSet.has(item.path))
      .sort(compare)
      .forEach(add);
    index.items
      .filter((item) => index.topLevel.has(item.path))
      .sort(compare)
      .forEach(add);
    return result.slice(0, MAX_RESULTS);
  }
  const candidates = new Map(index.items.map((item) => [item.path, item]));
  recentItems.forEach((item) => candidates.set(item.path, item));
  const results = [];
  for (const item of candidates.values()) {
    const score = matchScore(item, normalizedQuery);
    if (score) results.push({ item, score });
  }
  results.sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1] || compare(a.item, b.item));
  return results.slice(0, MAX_RESULTS).map(({ item }) => item);
}

export function createSearchEngine(options = {}) {
  const fs = options.fs || nodeFs;
  const now = options.now || Date.now;
  let cache;
  const inflight = new Map();
  const deniedUntil = new Map();
  const validationController = new AbortController();
  const validationOptions = { fs, signal: validationController.signal, timeoutMs: options.validationTimeoutMs };
  let activeKey;
  let disposed = false;
  const normalize = (settings) => normalizeSettings(settings, options.home);
  const ensureActive = () => {
    if (disposed) throw new Error('Global Search launcher has been disposed');
  };
  return {
    normalize,
    validatePath: (candidate, roots) => validateRecentPath(candidate, roots, validationOptions),
    async search(settings, input, recentPaths = []) {
      ensureActive();
      const config = normalize(settings);
      const key = JSON.stringify([config.roots, config.maxDepth]);
      activeKey = key;
      let index;
      if (inflight.has(key)) {
        index = await inflight.get(key);
      } else if (!input.refresh && cache?.key === key && now() - cache.createdAt < CACHE_MILLISECONDS) {
        index = cache.index;
      } else {
        const promise = scanDirectories(config, { ...options, fs, deniedUntil, isDisposed: () => disposed });
        inflight.set(key, promise);
        try {
          index = await promise;
          if (activeKey === key && !disposed) cache = { key, index, createdAt: now() };
        } finally {
          if (inflight.get(key) === promise) inflight.delete(key);
        }
      }
      ensureActive();
      const validationWarnings = [];
      const recentItems = (
        await Promise.all(
          recentPaths.slice(0, 30).map(async (candidate) => {
            if ([...deniedUntil].some(([directory, until]) => until > now() && isWithinRoots(candidate, [directory])))
              return null;
            try {
              return await validateRecentPath(candidate, config.roots, validationOptions);
            } catch (error) {
              ensureActive();
              validationWarnings.push(error.message);
              return null;
            }
          }),
        )
      ).filter(Boolean);
      ensureActive();
      return {
        items: rankItems(index, input.query, recentItems, config.roots),
        roots: config.roots,
        warnings: [...config.warnings, ...index.warnings, ...validationWarnings],
        truncated: index.truncated,
        indexed: index.items.length,
      };
    },
    dispose() {
      disposed = true;
      validationController.abort();
      cache = undefined;
      inflight.clear();
      deniedUntil.clear();
    },
  };
}
