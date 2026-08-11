import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TEST_DIR, '..', '..', '..', '..');

const bunAvailable = process.env.MICA_BIN || spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
const suite = bunAvailable ? describe : describe.skip;

function createMockProvider() {
  const state = {
    mode: 'ok' as 'ok' | 'error',
    requests: [] as unknown[],
    onRequest: undefined as (() => void) | undefined,
  };
  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/v1/responses')) {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk.toString()));
    req.on('end', () => {
      state.requests.push(JSON.parse(body));
      state.onRequest?.();
      if (state.mode === 'error') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock commit provider failed' } }));
        return;
      }
      const text = 'fix: 更新提交流程 🐛';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (event: Record<string, unknown>) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      emit({ type: 'response.created', response: { id: 'commit-resp', object: 'response' } });
      emit({ type: 'response.in_progress', response: { id: 'commit-resp', object: 'response' } });
      emit({
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'commit-msg', type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      });
      emit({
        type: 'response.output_text.delta',
        item_id: 'commit-msg',
        output_index: 0,
        content_index: 0,
        delta: text,
      });
      emit({ type: 'response.output_text.done', item_id: 'commit-msg', output_index: 0, content_index: 0, text });
      emit({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'commit-msg',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        },
      });
      emit({
        type: 'response.completed',
        response: {
          id: 'commit-resp',
          object: 'response',
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      });
      emit({
        type: 'response.done',
        response: {
          id: 'commit-resp',
          object: 'response',
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      });
      res.end();
    });
  });
  return { server, state };
}

let mock: ReturnType<typeof createMockProvider> | null = null;
let baseUrl = '';
const tempPaths = new Set<string>();

beforeAll(async () => {
  mock = createMockProvider();
  await new Promise<void>((resolve) => mock!.server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(mock!.server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => mock!.server.close((error) => (error ? reject(error) : resolve())));
});

afterEach(() => {
  for (const path of tempPaths) rmSync(path, { recursive: true, force: true });
  tempPaths.clear();
  if (mock) {
    mock.state.mode = 'ok';
    mock.state.requests = [];
    mock.state.onRequest = undefined;
  }
});

function makeHome(tag: string): string {
  const home = join(tmpdir(), `mica-commit-flow-${process.pid}-${tag}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  tempPaths.add(home);
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      providers: [
        {
          id: 'mock',
          name: 'Mock',
          protocol: 'openai_responses',
          api_base: baseUrl,
          api_key: 'test-key',
          models: ['mock-chat'],
        },
      ],
    }),
  );
  return home;
}

function makeRepo(tag: string): string {
  const repo = join(tmpdir(), `mica-commit-repo-${process.pid}-${tag}`);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  tempPaths.add(repo);
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.name', 'Mica Flow Test']);
  git(['config', 'user.email', 'mica-flow-test@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'README.md'), 'initial\n');
  git(['add', 'README.md']);
  git(['commit', '-qm', 'chore: initialize test repo']);
  return repo;
}

function makeBareRemote(tag: string): string {
  const remote = join(tmpdir(), `mica-commit-remote-${process.pid}-${tag}`);
  rmSync(remote, { recursive: true, force: true });
  execFileSync('git', ['init', '--bare', '-q', remote], { encoding: 'utf8' });
  tempPaths.add(remote);
  return remote;
}

function configureRemote(repo: string, remote: string): void {
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['remote', 'add', 'origin', remote]);
  git(['push', '-q', '-u', 'origin', 'HEAD']);
}

function rejectRemotePush(remote: string): void {
  const hook = join(remote, 'hooks', 'pre-receive');
  writeFileSync(hook, '#!/bin/sh\necho "remote rejected commit flow push" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
}

function createMergeConflict(repo: string): void {
  const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const baseBranch = git(['branch', '--show-current']).trim();

  git(['checkout', '-qb', 'conflict-side']);
  writeFileSync(join(repo, 'README.md'), 'change from side\n');
  git(['add', 'README.md']);
  git(['commit', '-qm', 'side: conflicting change']);

  git(['checkout', '-q', baseBranch]);
  writeFileSync(join(repo, 'README.md'), 'change from base\n');
  git(['add', 'README.md']);
  git(['commit', '-qm', 'base: conflicting change']);
  spawnSync('git', ['merge', 'conflict-side'], { cwd: repo, stdio: 'ignore' });
}

function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.env.MICA_BIN ?? 'bun',
      [...(process.env.MICA_BIN ? [] : ['apps/cli/src/index.ts']), ...args],
      {
        cwd: ROOT,
        env: { ...process.env, ...env, MICA_NO_DAEMON: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ) as ChildProcess;
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function payload(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
}

function itE2E(name: string, fn: () => Promise<void>): void {
  it(name, fn, 60_000);
}

suite('mica commit real-user flows (mock provider)', () => {
  itE2E('generates a message, commits the working tree, and does not push without a remote', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    const home = makeHome('success');
    const repo = makeRepo('success');
    writeFileSync(join(repo, 'README.md'), 'updated by commit flow\n');

    const result = await runCli(['commit', '--dir', repo], { MICA_HOME: home });
    expect(result.code).toBe(0);
    expect(payload(result.stdout)).toMatchObject({ ok: true, subject: 'fix: 更新提交流程 🐛', pushed: false });
    expect(mock!.state.requests).toHaveLength(1);
    expect(JSON.stringify(mock!.state.requests[0])).toContain('README.md');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repo, encoding: 'utf8' }).trim()).toBe(
      'fix: 更新提交流程 🐛',
    );
  });

  itE2E('returns nothing_to_commit without contacting the provider', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    const home = makeHome('clean');
    const repo = makeRepo('clean');

    const result = await runCli(['commit', '--dir', repo], { MICA_HOME: home });
    expect(result.code).toBe(1);
    expect(payload(result.stdout)).toMatchObject({ ok: false, code: 'nothing_to_commit' });
    expect(mock!.state.requests).toHaveLength(0);
  });

  itE2E('surfaces provider errors without creating a commit', async () => {
    mock!.state.mode = 'error';
    mock!.state.requests = [];
    const home = makeHome('provider-error');
    const repo = makeRepo('provider-error');
    writeFileSync(join(repo, 'README.md'), 'change that should remain uncommitted\n');
    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();

    const result = await runCli(['commit', '--dir', repo], { MICA_HOME: home });
    expect(result.code).toBe(1);
    expect(payload(result.stdout)).toMatchObject({ ok: false, code: 'error' });
    expect(result.stderr).toContain('mock commit provider failed');
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()).toBe(before);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toContain('README.md');
  });

  itE2E('pushes the generated commit to an existing local remote', async () => {
    const home = makeHome('push-success');
    const repo = makeRepo('push-success');
    const remote = makeBareRemote('push-success');
    configureRemote(repo, remote);
    writeFileSync(join(repo, 'README.md'), 'updated and ready to push\n');

    const result = await runCli(['commit', '--dir', repo], { MICA_HOME: home });
    expect(result.code).toBe(0);
    expect(payload(result.stdout)).toMatchObject({ ok: true, pushed: true, subject: 'fix: 更新提交流程 🐛' });
    expect(execFileSync('git', ['--git-dir', remote, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim()).toBe(
      'fix: 更新提交流程 🐛',
    );
  });

  itE2E('returns an error after committing when the remote rejects the push', async () => {
    const home = makeHome('push-error');
    const repo = makeRepo('push-error');
    const remote = makeBareRemote('push-error');
    configureRemote(repo, remote);
    rejectRemotePush(remote);
    writeFileSync(join(repo, 'README.md'), 'change rejected by remote\n');

    const result = await runCli(['commit', '--dir', repo], { MICA_HOME: home });
    expect(result.code).toBe(1);
    expect(payload(result.stdout)).toMatchObject({ ok: false, code: 'error' });
    expect(result.stderr).toContain('remote rejected commit flow push');
    expect(execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repo, encoding: 'utf8' }).trim()).toBe(
      'fix: 更新提交流程 🐛',
    );
    expect(execFileSync('git', ['--git-dir', remote, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).trim()).toBe(
      'chore: initialize test repo',
    );
  });

  itE2E('rejects a repository with unmerged conflict entries before contacting the provider', async () => {
    const home = makeHome('unmerged');
    const repo = makeRepo('unmerged');
    createMergeConflict(repo);

    const result = await runCli(['commit', '--dir', repo], { MICA_HOME: home });
    expect(result.code).toBe(1);
    expect(payload(result.stdout)).toMatchObject({ ok: false, code: 'unmerged' });
    expect(result.stderr).toContain('存在未解决冲突');
    expect(mock!.state.requests).toHaveLength(0);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toContain('UU README.md');
  });

  itE2E('returns nothing_staged if the working tree becomes clean before git add', async () => {
    const home = makeHome('nothing-staged');
    const repo = makeRepo('nothing-staged');
    writeFileSync(join(repo, 'README.md'), 'change removed while generating message\n');
    mock!.state.onRequest = () => writeFileSync(join(repo, 'README.md'), 'initial\n');

    const result = await runCli(['commit', '--dir', repo], { MICA_HOME: home });
    expect(result.code).toBe(1);
    expect(payload(result.stdout)).toMatchObject({ ok: false, code: 'nothing_staged' });
    expect(mock!.state.requests).toHaveLength(1);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repo, encoding: 'utf8' }).trim()).toBe(
      'chore: initialize test repo',
    );
  });
});
