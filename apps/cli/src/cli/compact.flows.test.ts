import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * End-to-end tests for `mica compact --prune-only` (headless session compaction).
 *
 * Unlike the full compact flow (which calls the model to summarize), prune-only
 * mode only trims tool arguments, media, and base64 payloads in-place — no
 * provider request is needed. These tests manually create session JSON files
 * with known content, run `mica compact --prune-only --session <id>`, and verify
 * the result on disk.
 *
 * Runs on every `bun run test` (CI includes bun). MICA_BIN overrides the bun
 * invocation, e.g. point it at a built `dist/mica` binary.
 */
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TEST_DIR, '..', '..', '..', '..');

const bunAvailable = process.env.MICA_BIN || spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
const suite = bunAvailable ? describe : describe.skip;

/** A minimal mock provider server. Not actually called by prune-only compact,
 * but the config must point to a valid-looking provider so the AgentRuntime
 * initializes cleanly. */
function createMockProvider() {
  const server: Server = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  return { server };
}

let mock: ReturnType<typeof createMockProvider> | null = null;
let baseUrl = '';

beforeAll(async () => {
  mock = createMockProvider();
  await new Promise<void>((resolve) => mock!.server.listen(0, '127.0.0.1', resolve));
  const { port } = mock!.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => mock!.server.close((error) => (error ? reject(error) : resolve())));
});

/** Create a temp MICA_HOME with a config.json pointing at the mock provider. */
function makeHome(tag: string): string {
  const home = join(tmpdir(), `mica-compact-flow-${process.pid}-${tag}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify(
      {
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
      },
      null,
      2,
    ),
  );
  mkdirSync(join(home, 'sessions'), { recursive: true });
  return home;
}

/** Run a one-shot `mica <args>` CLI and collect stdout/stderr. */
function runCli(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.env.MICA_BIN ?? 'bun',
      [...(process.env.MICA_BIN ? [] : ['apps/cli/src/index.ts']), ...args],
      {
        cwd: ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ) as ChildProcess;
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** E2E tests spawn a real child process; the 5s vitest default is too short. */
function itE2E(name: string, fn: () => Promise<void>): void {
  it(name, fn, 60_000);
}

/** Write a session JSON file into `<home>/sessions/<id>.json`. */
function writeSession(home: string, sessionId: string, session: Record<string, unknown>): void {
  writeFileSync(join(home, 'sessions', `${sessionId}.json`), JSON.stringify(session, null, 2));
}

/** Read a session JSON file from `<home>/sessions/<id>.json`. */
function readSession(home: string, sessionId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'sessions', `${sessionId}.json`), 'utf8'));
}

const SESSION_CWD = join(tmpdir(), `mica-compact-test-work-${process.pid}`);

beforeAll(() => {
  mkdirSync(SESSION_CWD, { recursive: true });
});

afterAll(() => {
  rmSync(SESSION_CWD, { recursive: true, force: true });
});

suite('mica compact --prune-only flows', () => {
  itE2E('--prune-only replaces tool arguments with placeholder and keeps conversation intact', async () => {
    const home = makeHome('prune-args');
    const sessionId = 'test-prune-args';
    const longArguments = JSON.stringify({
      file_path: '/some/long/path/to/file.txt',
      content: `hello world this is a long content that should be pruned during compact ${'x'.repeat(5_000)}`,
    });

    const now = new Date().toISOString();
    writeSession(home, sessionId, {
      version: 1,
      id: sessionId,
      title: 'Prune Args Test',
      createdAt: now,
      updatedAt: now,
      cwd: SESSION_CWD,
      turnState: 'completed',
      revision: 1,
      snapshot: {
        providerId: 'mock',
        model: 'mock-chat',
        effort: 'low',
        role: 'default',
        protocol: 'openai_responses',
        messages: [
          { type: 'message', role: 'user', content: '请创建一个文件' },
          {
            type: 'function_call',
            id: 'call_1',
            call_id: 'call_1',
            name: 'write_file',
            arguments: longArguments,
          },
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: '写入成功',
          },
          { type: 'message', role: 'assistant', content: '已创建文件' },
        ],
        conversationMessages: [
          { role: 'user', content: '请创建一个文件' },
          { role: 'assistant', content: '已创建文件' },
        ],
        usageHistory: [],
        lastUsage: undefined,
      },
    });

    const result = await runCli(['compact', '--prune-only', '--session', sessionId, '--dir', SESSION_CWD], {
      MICA_HOME: home,
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
    expect(parsed.ok).toBe(true);

    const after = readSession(home, sessionId);
    const messages = (after.snapshot as Record<string, unknown[]>).messages as Array<Record<string, unknown>>;
    const functionCall = messages.find((m) => m.type === 'function_call');
    expect(functionCall).toBeTruthy();

    // The original long arguments must be gone.
    const args = functionCall!.arguments as string;
    expect(args).not.toContain('hello world');
    expect(args).not.toContain('/some/long/path');

    // The arguments field must still be valid JSON.
    expect(() => JSON.parse(args)).not.toThrow();
    // The placeholder indicates truncation.
    const parsedArgs = JSON.parse(args);
    expect(parsedArgs._truncated).toBe(true);
  });

  itE2E('compact with --prune-only on a session with < 2 messages returns not_needed', async () => {
    const home = makeHome('prune-short');
    const sessionId = 'test-prune-short';
    const now = new Date().toISOString();

    writeSession(home, sessionId, {
      version: 1,
      id: sessionId,
      title: 'Short Session',
      createdAt: now,
      updatedAt: now,
      cwd: SESSION_CWD,
      turnState: 'completed',
      revision: 1,
      snapshot: {
        providerId: 'mock',
        model: 'mock-chat',
        effort: 'low',
        role: 'default',
        protocol: 'openai_responses',
        messages: [{ type: 'message', role: 'user', content: '只有一条消息' }],
        conversationMessages: [{ role: 'user', content: '只有一条消息' }],
        usageHistory: [],
        lastUsage: undefined,
      },
    });

    const result = await runCli(['compact', '--prune-only', '--session', sessionId, '--dir', SESSION_CWD], {
      MICA_HOME: home,
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
    expect(parsed.ok).toBe(false);
    expect(parsed.code).toBe('not_needed');
  });

  itE2E('compact --prune-only preserves usageHistory', async () => {
    const home = makeHome('prune-usage');
    const sessionId = 'test-prune-usage';
    const now = new Date().toISOString();
    const usageRecord = {
      provider: 'openai_responses',
      turnId: 1,
      requestIndex: 0,
      messageCount: 4,
      model: 'mock-chat',
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
      totalTokens: 150,
      paidTokenRate: 1,
    };

    // Include a tool call with long arguments so prune-only actually has
    // something to prune (ensuring ok: true rather than not_needed).
    const longToolArguments = JSON.stringify({
      file_path: '/some/path/to/output.txt',
      content: 'A'.repeat(5000),
    });

    writeSession(home, sessionId, {
      version: 1,
      id: sessionId,
      title: 'Usage Preserve Test',
      createdAt: now,
      updatedAt: now,
      cwd: SESSION_CWD,
      turnState: 'completed',
      revision: 1,
      snapshot: {
        providerId: 'mock',
        model: 'mock-chat',
        effort: 'low',
        role: 'default',
        protocol: 'openai_responses',
        messages: [
          { type: 'message', role: 'user', content: '请创建文件并总结' },
          {
            type: 'function_call',
            id: 'call_1',
            call_id: 'call_1',
            name: 'write_file',
            arguments: longToolArguments,
          },
          {
            type: 'function_call_output',
            call_id: 'call_1',
            output: '写入成功',
          },
          { type: 'message', role: 'assistant', content: '已完成操作' },
        ],
        conversationMessages: [
          { role: 'user', content: '请创建文件并总结' },
          { role: 'assistant', content: '已完成操作' },
        ],
        usageHistory: [usageRecord],
        lastUsage: usageRecord,
      },
    });

    const result = await runCli(['compact', '--prune-only', '--session', sessionId, '--dir', SESSION_CWD], {
      MICA_HOME: home,
    });

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
    expect(parsed.ok).toBe(true);

    const after = readSession(home, sessionId);
    const snapshot = after.snapshot as Record<string, unknown>;
    const usageHistory = snapshot.usageHistory as unknown[];
    const lastUsage = snapshot.lastUsage as Record<string, unknown> | undefined;

    // usageHistory must be preserved with the same length and content.
    expect(usageHistory.length).toBe(1);
    expect(usageHistory[0]).toMatchObject({
      provider: 'openai_responses',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });

    // lastUsage must also be preserved.
    expect(lastUsage).toBeTruthy();
    expect(lastUsage).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
  });
});
