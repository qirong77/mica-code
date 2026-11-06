import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import createLauncher from './launcher.js';
import { createSearchEngine, normalizeSettings, rankItems, scanDirectories, validateRecentPath } from './search.js';

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mica-search-中文 空格-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function file(root: string, relative: string, content = '') {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

function settings(root: string, maxDepth = 6) {
  return { searchDirectories: root, maxDepth };
}

function context(initialSettings: any, initialRecent: string[] = []) {
  let value: any = { recent: initialRecent, unrelated: 'preserved' };
  let version = 0;
  let currentSettings = initialSettings;
  const ctx = {
    settings: { get: () => currentSettings },
    readData: async () => ({ value: structuredClone(value), version }),
    writeData: async (next: any, options: any) => {
      if (options.expectedVersion !== version) return { ok: false, conflict: true };
      value = structuredClone(next);
      version += 1;
      return { ok: true };
    },
    // The backend must leave opening files to the page and host.
    openPath() {
      throw new Error('Backend must not open files');
    },
  };
  return {
    ctx,
    get value() {
      return value;
    },
    get version() {
      return version;
    },
    setSettings(next: any) {
      currentSettings = next;
    },
    externalWrite(next: any) {
      value = structuredClone(next);
      version += 1;
    },
  };
}

test('normalizes newline roots, home expansion, duplicates, and depth bounds without a session cwd', () => {
  const config = normalizeSettings(
    { searchDirectories: '~/中文 空格\n/absolute/one/../two\n~/中文 空格\nrelative', maxDepth: 99 },
    '/home/person',
  );
  assert.deepEqual(config.roots, ['/home/person/中文 空格', '/absolute/two']);
  assert.equal(config.maxDepth, 16);
  assert.equal(config.warnings.length, 1);
  assert.equal(normalizeSettings({ maxDepth: -3 }).maxDepth, 1);
  assert.equal(normalizeSettings({ maxDepth: 'invalid' }).maxDepth, 6);
});

test('indexes roots, Chinese and spaced files, folders, and nested paths; excludes artifacts and symlinks', async (t) => {
  const root = await fixture(t);
  const target = await file(root, '中文 项目/资料/你好 world.ts');
  await file(root, '普通 文件.md');
  await file(root, '.hidden/secret.ts');
  await file(root, 'node_modules/pkg/dependency.ts');
  await file(root, 'dist/output.ts');
  await file(root, 'Library/cache.db');
  await fs.symlink(path.join(root, '中文 项目'), path.join(root, 'linked-directory'));
  await fs.symlink(target, path.join(root, 'linked-file'));
  const index = await scanDirectories(normalizeSettings(settings(root)));
  const paths = index.items.map((item: any) => item.path);
  assert(paths.includes(root));
  assert(paths.includes(path.dirname(target)));
  assert(paths.includes(target));
  for (const name of ['.hidden', 'node_modules', 'dist', 'Library', 'linked-directory', 'linked-file']) {
    assert(
      !paths.some(
        (value: string) => value === path.join(root, name) || value.startsWith(path.join(root, name) + path.sep),
      ),
    );
  }
  assert.equal(rankItems(index, '你好', [], [root])[0].path, target);
  assert.equal(rankItems(index, 'WORLD.TS', [], [root])[0].path, target);
  assert.equal(rankItems(index, '你wts', [], [root])[0].path, target);
  assert.equal(index.truncated, false);
});

test('depth includes boundary folders and marks deeper traversal as truncated', async (t) => {
  const root = await fixture(t);
  const deepFile = await file(root, '一级/二级/三级/深层.txt');
  const index = await scanDirectories(normalizeSettings(settings(root, 2)));
  assert(index.items.some((item: any) => item.path === path.join(root, '一级/二级')));
  assert(!index.items.some((item: any) => item.path === deepFile));
  assert.equal(index.truncated, true);
  assert(index.warnings.some((warning: string) => warning.includes('最大搜索深度 2')));
});

test('overlapping roots are deduplicated while each root gets its own depth allowance', async (t) => {
  const root = await fixture(t);
  const childFile = await file(root, 'nested/child.txt');
  const nested = path.dirname(childFile);
  const index = await scanDirectories(
    normalizeSettings({ searchDirectories: `${root}\n${nested}\n${root}`, maxDepth: 1 }),
  );
  const paths = index.items.map((item: any) => item.path);
  assert.equal(paths.length, new Set(paths).size);
  assert(paths.includes(childFile));
  assert.equal(paths.filter((value: string) => value === nested).length, 1);
});

test('missing roots and permission failures become warnings without losing other results', async (t) => {
  const root = await fixture(t);
  const visible = await file(root, 'visible.txt');
  const denied = path.join(root, 'denied');
  await fs.mkdir(denied);
  const mockFs = {
    ...fs,
    async readdir(directory: string, options: any) {
      if (directory === denied) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return fs.readdir(directory, options);
    },
  };
  const index = await scanDirectories(
    normalizeSettings({ searchDirectories: `${root}\n${path.join(root, 'missing')}`, maxDepth: 6 }),
    { fs: mockFs },
  );
  assert(index.items.some((item: any) => item.path === visible));
  assert(index.warnings.some((warning: string) => warning.includes('ENOENT')));
  assert(index.warnings.some((warning: string) => warning.includes('EACCES') && warning.includes(denied)));
});

test('permission-denied directories cool down across forced refreshes', async (t) => {
  const root = await fixture(t);
  let reads = 0;
  let clock = 1_000;
  const engine = createSearchEngine({
    now: () => clock,
    fs: {
      ...fs,
      readdir: async () => {
        reads++;
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      },
    },
  });
  t.onTestFinished(() => engine.dispose());
  await engine.search(settings(root), { query: '', refresh: true });
  const cooled = await engine.search(settings(root), { query: '', refresh: true });
  assert.equal(reads, 1);
  assert(cooled.warnings.some((warning: string) => warning.includes('冷却')));
  clock += 10 * 60_000 + 1;
  await engine.search(settings(root), { query: '', refresh: true });
  assert.equal(reads, 2);
});

test('entry and directory budgets bound scans and explain incomplete results', async (t) => {
  const root = await fixture(t);
  for (let index = 0; index < 5; index += 1) await file(root, `folder-${index}/file.txt`);
  const limitedEntries = await scanDirectories(normalizeSettings(settings(root)), { limits: { entries: 3 } });
  assert.equal(limitedEntries.items.length, 3);
  assert.equal(limitedEntries.truncated, true);
  const limitedDirectories = await scanDirectories(normalizeSettings(settings(root)), { limits: { directories: 1 } });
  assert.equal(limitedDirectories.truncated, true);
  assert(!limitedDirectories.items.some((item: any) => item.type === 'file'));
  assert(limitedDirectories.warnings.some((warning: string) => warning.includes('预算限制')));
});

test('wall-clock budget returns even when a filesystem operation never settles', async (t) => {
  const root = await fixture(t);
  const mockFs = { ...fs, readdir: () => new Promise(() => {}) };
  const index = await scanDirectories(normalizeSettings(settings(root)), { fs: mockFs, limits: { milliseconds: 20 } });
  assert.equal(index.truncated, true);
  assert.equal(index.items.length, 1);
  assert(index.warnings.some((warning: string) => warning.includes('20ms')));
});

test('recent path timeouts preserve search results, release remember queues, and cancel on dispose', async (t) => {
  const root = await fixture(t);
  const visible = await file(root, 'visible.txt');
  const stuck = await file(root, 'stuck.txt');
  const mockFs = {
    ...fs,
    lstat: (candidate: string) => (candidate === stuck ? new Promise(() => {}) : fs.lstat(candidate)),
  };
  const options = { fs: mockFs, validationTimeoutMs: 20 };
  const engine = createSearchEngine(options);
  t.onTestFinished(() => engine.dispose());
  const result = await engine.search(settings(root), { query: 'visible' }, [stuck]);
  assert.equal(result.items[0].path, visible);
  assert(result.warnings.some((warning: string) => warning.includes('校验超时')));
  const state = context(settings(root));
  const launcher = createLauncher(state.ctx, options);
  t.onTestFinished(() => launcher.dispose());
  const first = launcher.request('remember', { path: stuck });
  const second = launcher.request('remember', { path: visible });
  await assert.rejects(first, /超时/);
  assert.deepEqual(await second, { ok: true });
  const cancelled = engine.validatePath(stuck, [root]);
  engine.dispose();
  await assert.rejects(cancelled, /disposed/);
});

test('name matches rank ahead of path-only matches; result count is capped at 80', () => {
  const items = [
    { path: '/root/target/deep.txt', name: 'deep.txt', type: 'file' },
    { path: '/root/ta-r-get.ts', name: 'ta-r-get.ts', type: 'file' },
    { path: '/root/TARGET.ts', name: 'TARGET.ts', type: 'file' },
  ];
  const ranked = rankItems({ items, topLevel: new Set() }, 'target');
  assert.deepEqual(
    ranked.map((item: any) => item.name),
    ['TARGET.ts', 'ta-r-get.ts', 'deep.txt'],
  );
  const many = Array.from({ length: 100 }, (_, index) => ({
    path: `/root/file-${index}`,
    name: `file-${index}`,
    type: 'file',
  }));
  assert.equal(rankItems({ items: many, topLevel: new Set() }, 'file').length, 80);
});

test('search shares in-flight work, caches for 30s, refreshes, and rebuilds after settings changes', async (t) => {
  const root = await fixture(t);
  const other = await fixture(t);
  await file(root, 'first.txt');
  const otherFile = await file(other, 'other.txt');
  let reads = 0;
  let now = 1_000;
  const mockFs = {
    ...fs,
    async readdir(directory: string, options: any) {
      reads += 1;
      return fs.readdir(directory, options);
    },
  };
  const engine = createSearchEngine({ fs: mockFs, now: () => now });
  t.onTestFinished(() => engine.dispose());
  await Promise.all(Array.from({ length: 3 }, () => engine.search(settings(root), { query: 'txt' })));
  assert.equal(reads, 1);
  const added = await file(root, 'added.txt');
  assert(!(await engine.search(settings(root), { query: 'added' })).items.some((item: any) => item.path === added));
  assert.equal(reads, 1);
  assert.equal((await engine.search(settings(root), { query: 'added', refresh: true })).items[0].path, added);
  assert.equal(reads, 2);
  const later = await file(root, 'later.txt');
  now += 30_001;
  assert.equal((await engine.search(settings(root), { query: 'later' })).items[0].path, later);
  assert.equal(reads, 3);
  const changed = await engine.search(settings(other), { query: 'other' });
  assert.equal(changed.items[0].path, otherFile);
  assert.deepEqual(changed.roots, [other]);
  assert.equal(reads, 4);
});

test('a depth setting change rebuilds the index', async (t) => {
  const root = await fixture(t);
  const target = await file(root, 'nested/deep.txt');
  const engine = createSearchEngine();
  t.onTestFinished(() => engine.dispose());
  assert(!(await engine.search(settings(root, 1), { query: 'deep' })).items.some((item: any) => item.path === target));
  assert.equal((await engine.search(settings(root, 2), { query: 'deep' })).items[0].path, target);
});

test('empty query returns valid recents, roots, and top-level folders; omits deleted or outside recents', async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const recent = await file(root, 'folder/nested/recent.txt');
  const topFile = await file(root, 'ordinary.txt');
  const outsideFile = await file(outside, 'outside.txt');
  const engine = createSearchEngine();
  t.onTestFinished(() => engine.dispose());
  const result = await engine.search(settings(root), { query: '' }, [
    recent,
    outsideFile,
    path.join(root, 'removed.txt'),
  ]);
  assert.equal(result.items[0].path, recent);
  assert(result.items.some((item: any) => item.path === root));
  assert(result.items.some((item: any) => item.path === path.join(root, 'folder')));
  assert(
    !result.items.some(
      (item: any) => item.path === topFile || item.path === outsideFile || item.path.endsWith('removed.txt'),
    ),
  );
  assert(result.indexed >= 5);
});

test('recent validation rejects sibling-prefix paths and symlink descendants', async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  const target = await file(outside, 'secret.txt');
  await fs.symlink(outside, path.join(root, 'link'));
  assert.equal(await validateRecentPath(target, [root]), null);
  assert.equal(await validateRecentPath(path.join(root, 'link/secret.txt'), [root]), null);
  assert.equal(await validateRecentPath(path.join(root + '-sibling', 'file'), [root]), null);
});

test('first recent write preserves the host null version for a missing data file', async (t) => {
  const root = await fixture(t);
  const target = await file(root, 'first-open.txt');
  let saved: any;
  const launcher = createLauncher({
    settings: { get: () => settings(root) },
    readData: async () => ({ value: null, version: null }),
    writeData: async (value: any, options: any) => {
      assert.equal(options.expectedVersion, null);
      saved = value;
      return { ok: true };
    },
  });
  t.onTestFinished(() => launcher.dispose());
  assert.deepEqual(await launcher.request('remember', { path: target }), { ok: true });
  assert.deepEqual(saved, { recent: [target] });
});

test('remember replays a version conflict against freshly read global data', async (t) => {
  const root = await fixture(t);
  const target = await file(root, 'picked.txt');
  const concurrent = await file(root, 'concurrent.txt');
  const state = context(settings(root));
  const originalWrite = state.ctx.writeData;
  const expectedVersions: number[] = [];
  let conflict = true;
  state.ctx.writeData = async (next: any, options: any) => {
    expectedVersions.push(options.expectedVersion);
    if (conflict) {
      conflict = false;
      state.externalWrite({ recent: [concurrent], unrelated: 'external' });
    }
    return originalWrite(next, options);
  };
  const launcher = createLauncher(state.ctx);
  t.onTestFinished(() => launcher.dispose());
  assert.deepEqual(await launcher.request('remember', { path: target }), { ok: true });
  assert.deepEqual(expectedVersions, [0, 1]);
  assert.deepEqual(state.value.recent, [target, concurrent]);
  assert.equal(state.value.unrelated, 'external');
  const result = await launcher.request('search', { query: '' });
  assert('items' in result);
  assert.equal(result.items[0].path, target);
});

test('remember handles structured CAS conflicts, serializes local writers, and caps/deduplicates 30 recents', async (t) => {
  const root = await fixture(t);
  const paths = await Promise.all(Array.from({ length: 32 }, (_, index) => file(root, `recent-${index}.txt`)));
  const state = context(settings(root), paths.slice(0, 30));
  const originalWrite = state.ctx.writeData;
  let conflict = true;
  state.ctx.writeData = async (next: any, options: any): Promise<any> => {
    if (conflict) {
      conflict = false;
      return { ok: false, conflict: true };
    }
    return originalWrite(next, options);
  };
  const launcher = createLauncher(state.ctx);
  t.onTestFinished(() => launcher.dispose());
  await Promise.all([
    launcher.request('remember', { path: paths[30] }),
    launcher.request('remember', { path: paths[31] }),
  ]);
  await launcher.request('remember', { path: paths[30] });
  assert.equal(state.value.recent.length, 30);
  assert.equal(new Set(state.value.recent).size, 30);
  assert.deepEqual(state.value.recent.slice(0, 2), [paths[30], paths[31]]);
  assert.equal(state.version, 3);
});

test('remember rejects missing/outside paths and uses changed roots immediately', async (t) => {
  const root = await fixture(t);
  const other = await fixture(t);
  const target = await file(root, 'remember.txt');
  const otherFile = await file(other, 'other.txt');
  const state = context(settings(root));
  const launcher = createLauncher(state.ctx);
  t.onTestFinished(() => launcher.dispose());
  await assert.rejects(launcher.request('remember', { path: path.join(root, 'missing') }));
  await assert.rejects(launcher.request('remember', { path: otherFile }));
  await launcher.request('remember', { path: target });
  state.setSettings(settings(other));
  await assert.rejects(launcher.request('remember', { path: target }));
  const result = await launcher.request('search', { query: '' });
  assert('items' in result);
  assert(!result.items.some((item: any) => item.path === target));
  assert.equal(state.version, 1);
});

test('launcher rejects invalid actions and all requests after disposal', async (t) => {
  const root = await fixture(t);
  const launcher = createLauncher(context(settings(root)).ctx);
  await assert.rejects(launcher.request('open', { path: root }), /Unknown/);
  await assert.rejects(launcher.request('search', { query: null }), /query/);
  launcher.dispose();
  await assert.rejects(launcher.request('search', { query: '' }), /disposed/);
});
