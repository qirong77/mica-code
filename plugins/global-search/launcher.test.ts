import { test } from 'vitest';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import createLauncher from './launcher.js';

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mica-open-中文 空格-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function file(root: string, relative: string) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '');
  return target;
}

function settings(root: string, editorApp?: string) {
  return { searchDirectories: root, maxDepth: '6', ...(editorApp ? { editorApp } : {}) };
}

function context(initialSettings: any) {
  let value: any = { recent: [] };
  let version = 0;
  return {
    settings: { get: () => initialSettings },
    readData: async () => ({ value: structuredClone(value), version }),
    writeData: async (next: any, options: any) => {
      if (options?.expectedVersion !== version) return { ok: false, conflict: true };
      value = structuredClone(next);
      version += 1;
      return { ok: true };
    },
  };
}

/** 记下命令并立刻用一个子进程的样子回报结果；不开真实应用。 */
function spawnRecorder({ code = 0, stderr = '', error = null }: { code?: number; stderr?: string; error?: Error | null } = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawn = (command: string, args: string[]) => {
    calls.push({ command, args });
    const child: any = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (stderr) child.stderr.emit('data', stderr);
      if (error) child.emit('error', error);
      else child.emit('close', code);
    });
    return child;
  };
  return { spawn, calls };
}

const installed = () => true;

test('openEditor hands the path to open -a with the configured app', async (t) => {
  const root = await fixture(t);
  const target = await file(root, '中文 项目/资料.ts');
  const { spawn, calls } = spawnRecorder();
  const launcher = createLauncher(context(settings(root)), { platform: 'darwin', home: root, exists: installed, spawn });
  t.onTestFinished(() => launcher.dispose());

  assert.deepEqual(await launcher.request('openEditor', { path: target }), {
    ok: true,
    app: 'Visual Studio Code',
  });
  assert.deepEqual(calls, [{ command: 'open', args: ['-a', 'Visual Studio Code', target] }]);
});

test('openEditor reports what open wrote to stderr instead of assuming success', async (t) => {
  const root = await fixture(t);
  const target = await file(root, 'report.md');
  const { spawn } = spawnRecorder({ code: 1, stderr: "Unable to find application named 'Visual Studio Code'\n" });
  const launcher = createLauncher(context(settings(root)), { platform: 'darwin', home: root, exists: installed, spawn });
  t.onTestFinished(() => launcher.dispose());

  await assert.rejects(launcher.request('openEditor', { path: target }), /Unable to find application named/);
});

test('openEditor refuses paths outside the configured roots and never spawns', async (t) => {
  const root = await fixture(t);
  const outside = await file(path.join(root, '..'), `outside-${path.basename(root)}.md`);
  t.onTestFinished(() => fs.rm(outside, { force: true }));
  const { spawn, calls } = spawnRecorder();
  const launcher = createLauncher(context(settings(root)), { platform: 'darwin', home: root, exists: installed, spawn });
  t.onTestFinished(() => launcher.dispose());

  await assert.rejects(launcher.request('openEditor', { path: outside }), /只能打开当前搜索目录内存在的文件或文件夹/);
  await assert.rejects(launcher.request('openEditor', { path: path.join(root, 'missing.md') }), /只能打开当前搜索目录内存在的文件或文件夹/);
  assert.deepEqual(calls, []);
});

test('editorApp setting is honoured and a trailing .app is dropped', async (t) => {
  const root = await fixture(t);
  const target = await file(root, 'workspace');
  const { spawn, calls } = spawnRecorder();
  const launcher = createLauncher(context(settings(root, ' Cursor.app ')), {
    platform: 'darwin',
    home: root,
    exists: installed,
    spawn,
  });
  t.onTestFinished(() => launcher.dispose());

  assert.deepEqual(await launcher.request('openEditor', { path: target }), { ok: true, app: 'Cursor' });
  assert.deepEqual(calls[0], { command: 'open', args: ['-a', 'Cursor', target] });
});

test('search reports the editor so the page knows whether to draw its rows', async (t) => {
  const root = await fixture(t);
  await file(root, 'notes.md');
  const launcher = createLauncher(context(settings(root)), { platform: 'darwin', home: root, exists: installed });
  t.onTestFinished(() => launcher.dispose());
  const available = (await launcher.request('search', { query: '' })) as { editor: { app: string; available: boolean } };
  assert.deepEqual(available.editor, { app: 'Visual Studio Code', available: true });

  const missing = createLauncher(context(settings(root)), {
    platform: 'darwin',
    home: root,
    exists: () => false,
    spawn: spawnRecorder().spawn,
  });
  t.onTestFinished(() => missing.dispose());
  const unavailable = (await missing.request('search', { query: '' })) as { editor: { available: boolean } };
  assert.equal(unavailable.editor.available, false);
  await assert.rejects(missing.request('openEditor', { path: root }), /没有找到 Visual Studio Code/);
});

test('platforms without LaunchServices fall back to the code command', async (t) => {
  const root = await fixture(t);
  const target = await file(root, 'app.ts');
  const { spawn, calls } = spawnRecorder();
  const launcher = createLauncher(context(settings(root)), { platform: 'linux', home: root, spawn });
  t.onTestFinished(() => launcher.dispose());

  assert.deepEqual(await launcher.request('openEditor', { path: target }), { ok: true, app: 'Visual Studio Code' });
  assert.deepEqual(calls, [{ command: 'code', args: [target] }]);
});
