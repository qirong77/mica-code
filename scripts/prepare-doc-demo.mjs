#!/usr/bin/env node
/** Prepare an isolated, disposable documentation workspace. No model requests. */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const BASE_QUEUE = `export class TaskQueue {
  #tail = Promise.resolve();

  add(task) {
    const result = this.#tail.then(() => task());
    this.#tail = result.catch(() => {});
    return result;
  }
}
`;

export const BASE_TESTS = `import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskQueue } from '../src/task-queue.mjs';

test('runs tasks in FIFO order', async () => {
  const queue = new TaskQueue();
  const order = [];
  const first = queue.add(async () => { order.push('first'); return 1; });
  const second = queue.add(async () => { order.push('second'); return 2; });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ['first', 'second']);
});

test('continues after a task fails', async () => {
  const queue = new TaskQueue();
  await assert.rejects(queue.add(() => { throw new Error('task failed'); }), /task failed/);
  assert.equal(await queue.add(() => 'next'), 'next');
});
`;

export const ABORT_QUEUE = `export class TaskQueue {
  #tail = Promise.resolve();

  add(task, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);

    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });

      const run = async () => {
        try {
          signal?.throwIfAborted();
          resolve(await task(signal));
        } catch (error) {
          reject(error);
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      };

      // Keep the queue occupied until a running task settles, even if its
      // caller has already cancelled. Running tasks cooperate via signal.
      this.#tail = this.#tail.then(run, run);
    });
  }
}
`;

export const ABORT_TESTS = BASE_TESTS + `
test('rejects an already aborted signal without running the task', async () => {
  const queue = new TaskQueue();
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(queue.add(() => { called = true; }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(called, false);
});

test('cancels a pending task and continues the queue', async () => {
  const queue = new TaskQueue();
  const controller = new AbortController();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = queue.add(() => gate);
  let called = false;
  const pending = queue.add(() => { called = true; }, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejected;
  release('first');
  assert.equal(await first, 'first');
  assert.equal(await queue.add(() => 'next'), 'next');
  assert.equal(called, false);
});

test('passes the signal to a running task and waits for its cleanup', async () => {
  const queue = new TaskQueue();
  const controller = new AbortController();
  let announceStarted;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  let finishCleanup;
  const cleanup = new Promise((resolve) => { finishCleanup = resolve; });
  let observedAbort = false;
  const running = queue.add(async (signal) => {
    assert.equal(signal, controller.signal);
    announceStarted();
    await new Promise((resolve) => signal.addEventListener('abort', () => {
      observedAbort = true;
      resolve();
    }, { once: true }));
    await cleanup;
  }, { signal: controller.signal });
  await started;
  let nextStarted = false;
  const next = queue.add(() => { nextStarted = true; return 'next'; });
  const rejected = assert.rejects(running, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.equal(observedAbort, true);
  assert.equal(nextStarted, false);
  finishCleanup();
  assert.equal(await next, 'next');
});
`;

const MARKER = '.mica-docs-demo.json';
const repoRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const inside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

export function prepareDemo(args = process.argv.slice(2)) {
  const positional = args.filter((arg) => !arg.startsWith('--'));
  if (positional.length > 1 || args.some((arg) => arg.startsWith('--') && arg !== '--reset')) {
    throw new Error('Usage: node scripts/prepare-doc-demo.mjs [directory] [--reset]');
  }
  const port = Number(process.env.MICA_DEMO_PROVIDER_PORT || 8898);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MICA_DEMO_PROVIDER_PORT');
  let root = positional[0] ? resolve(positional[0]) : mkdtempSync(join(tmpdir(), 'mica-docs-demo-'));
  // Resolve the parent before creating anything, including paths through symlinks.
  let ancestor = root;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const canonical = resolve(realpathSync(ancestor), relative(ancestor, root));
  if (inside(repoRoot, canonical) || inside(canonical, repoRoot)) {
    throw new Error('Demo directory must be outside the source repository and its ancestors');
  }
  if (existsSync(root)) {
    if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new Error('Demo root must be a regular directory');
    root = realpathSync(root);
    if (readdirSync(root).length) {
      let marker;
      try { marker = JSON.parse(readFileSync(join(root, MARKER), 'utf8')); } catch { /* refuse below */ }
      if (marker?.kind !== 'mica-docs-demo' || marker?.version !== 1 || marker?.root !== root) {
        throw new Error('Refusing to overwrite a non-demo directory');
      }
      if (!args.includes('--reset')) throw new Error('Demo already exists; stop its processes and pass --reset or use a fresh directory');
      for (const name of ['home', 'data', 'logs', 'workspace']) rmSync(join(root, name), { recursive: true, force: true });
    }
  } else {
    mkdirSync(root, { recursive: true });
    root = realpathSync(root);
  }
  const paths = { root, home: join(root, 'home'), data: join(root, 'data'), logs: join(root, 'logs'), workspace: join(root, 'workspace', 'task-queue') };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  mkdirSync(join(paths.home, 'cache'), { recursive: true });
  mkdirSync(join(paths.workspace, 'src'), { recursive: true });
  mkdirSync(join(paths.workspace, 'test'), { recursive: true });
  json(join(root, MARKER), { kind: 'mica-docs-demo', version: 1, root });
  json(join(paths.home, 'config.json'), {
    providers: [{ id: 'demo', api_base: `http://127.0.0.1:${port}/v1`, api_key: 'demo-only-not-a-secret', protocol: 'openai_responses', models: ['mica-demo'], supportsEffort: true, effortLevels: ['low', 'medium', 'high'] }],
    mcpServers: {},
  });
  // Runtime selection belongs to storage.json, not persisted config fields.
  json(join(paths.home, 'storage.json'), { version: 1, lastUsedByDirectory: { [paths.workspace]: { provider: 'demo', model: 'mica-demo', effort: 'medium', providerPreferences: { demo: { model: 'mica-demo', effort: 'medium' } } } } });
  // Fresh local metadata avoids online models.dev discovery during screenshots.
  json(join(paths.home, 'cache', 'models-dev.json'), { version: 1, fetchedAt: Date.now(), payload: { demo: { api: `http://127.0.0.1:${port}/v1`, models: { 'mica-demo': { id: 'mica-demo', limit: { context: 65536 }, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }], modalities: { input: ['text'] } } } } } });
  json(join(paths.home, 'plugins-state.json'), { disabled: ['session-rename', 'memory', 'auto-compact', 'mobile-relay'] });
  json(join(paths.workspace, 'package.json'), { name: 'task-queue-demo', version: '1.0.0', private: true, type: 'module', scripts: { test: 'node --test' }, engines: { node: '>=22' } });
  writeFileSync(join(paths.workspace, 'src', 'task-queue.mjs'), BASE_QUEUE);
  writeFileSync(join(paths.workspace, 'test', 'task-queue.test.mjs'), BASE_TESTS);
  writeFileSync(join(paths.workspace, 'README.md'), '# Task Queue\n\nA tiny serial task queue. Run `node --test`. Documentation fixture only.\n');
  execFileSync(process.execPath, ['--test'], { cwd: paths.workspace, stdio: 'pipe' });
  // Inherited GIT_DIR / GIT_WORK_TREE must never redirect fixture commands.
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...gitArgs) => execFileSync('git', ['-c', `core.hooksPath=${devNull}`, ...gitArgs], { cwd: paths.workspace, env: { ...gitEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_AUTHOR_NAME: 'Mica Demo', GIT_AUTHOR_EMAIL: 'demo@example.invalid', GIT_COMMITTER_NAME: 'Mica Demo', GIT_COMMITTER_EMAIL: 'demo@example.invalid' }, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  git('add', 'package.json', 'README.md', 'src/task-queue.mjs', 'test/task-queue.test.mjs');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Add task queue baseline');
  json(join(root, 'demo.json'), { ...paths, providerPort: port, model: 'mica-demo', prompt: '为任务队列补充 AbortSignal 支持，并验证取消行为' });
  return paths;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(prepareDemo(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
