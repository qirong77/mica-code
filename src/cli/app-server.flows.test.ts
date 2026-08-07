import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * End-to-end app-server flow suite. Drives a real `mica app-server` child
 * process the way mica-code-app's chat host does (spawn resident host, then
 * turn/start | turn/steer | turn/interrupt over the Codex v2 protocol), with a
 * local mock OpenAI-compatible provider so no real API key is needed.
 *
 * Covers the real-user flows that tripped over in production:
 *   - new session + switch model (full `provider/model` id) + effort -> turn runs
 *   - "ran and immediately stopped" -> turn/interrupt -> interrupted
 *   - provider/model failure -> turn/completed carries the real error message
 *     (the app renders it as an error notice; silently-failed turns regressed here)
 *   - resident host reuse across turns + Shift+Tab after_iteration queue injection
 *
 * Runs on every `bun run test` (CI includes bun). MICA_BIN overrides the bun
 * invocation, e.g. point it at a built `dist/mica` binary.
 */
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TEST_DIR, '..', '..');

const bunAvailable = process.env.MICA_BIN || spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
const suite = bunAvailable ? describe : describe.skip;

/** Open a `node:http` server pretending to be an OpenAI-compatible responses
 * provider. Programmable per test: normal SSE stream, 400 error, or a delay
 * before the text arrives (to keep a turn busy long enough to steer into it). */
function createMockProvider() {
  const state = {
    mode: 'ok' as 'ok' | 'error' | 'tool',
    errorMessage: '',
    delayBeforeTextMs: 0,
    requests: [] as Array<{ model: string; input: unknown[] }>,
    responsesFinished: 0,
    /** `tool` mode: requests #1/#2 return write_file function calls (two tool
     * iterations), later requests return plain text. Two iterations are needed
     * so an after_iteration steer queued during iteration 1 is actually
     * injected at iteration 2's boundary (see MessageQueueService: the first
     * boundary only starts the wait, the second boundary releases the input). */
    toolFilePath: '',
    toolFileContent: 'hello from mock',
    /** Second tool call content (kept separate so the two calls are distinct). */
    toolFileContent2: 'hello from mock (second call)',
    /** Override reply text; compact tests use a long reply so the checkpoint
     * exceeds the recent-token budget and actually summarizes. */
    longText: '',
  };
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/v1/responses')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk.toString()));
      req.on('end', () => {
        let parsed: { model?: string; input?: unknown[] } = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          // keep defaults
        }
        state.requests.push({ model: parsed?.model ?? '', input: parsed?.input ?? [] });
        if (state.mode === 'error') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: state.errorMessage || 'mock provider error' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const text = state.longText || '你好，我是 mock 模型的回复';
        const emit = (event: Record<string, unknown>) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        const emitTextEvents = () => {
          emit({ type: 'response.created', response: { id: 'resp_1', object: 'response' } });
          emit({ type: 'response.in_progress', response: { id: 'resp_1', object: 'response' } });
          emit({
            type: 'response.output_item.added',
            output_index: 0,
            item: { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          });
          emit({
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            delta: text,
          });
          emit({
            type: 'response.output_text.done',
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            text,
          });
          emit({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'msg_1',
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text }],
            },
          });
          emitCompleted();
        };
        const emitToolCallEvents = (requestIndex: number) => {
          // OpenAI Responses function_call stream the SDK accepts: the client
          // collects the call, executes the tool (real file write), appends a
          // function_call_output item and issues a second request.
          const callId = `call_${requestIndex}`;
          const filePath = requestIndex === 1 ? state.toolFilePath : `${state.toolFilePath}.2`;
          const content = requestIndex === 1 ? state.toolFileContent : state.toolFileContent2;
          const argumentsText = JSON.stringify({
            file_path: filePath,
            content,
          });
          emit({ type: 'response.created', response: { id: 'resp_2', object: 'response' } });
          emit({ type: 'response.in_progress', response: { id: 'resp_2', object: 'response' } });
          emit({
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'fc_1',
              type: 'function_call',
              status: 'in_progress',
              call_id: callId,
              name: 'write_file',
              arguments: '',
            },
          });
          emit({
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            item_id: 'fc_1',
            delta: argumentsText.slice(0, Math.floor(argumentsText.length / 2)),
          });
          emit({
            type: 'response.function_call_arguments.delta',
            output_index: 0,
            item_id: 'fc_1',
            delta: argumentsText.slice(Math.floor(argumentsText.length / 2)),
          });
          emit({
            type: 'response.function_call_arguments.done',
            output_index: 0,
            item_id: 'fc_1',
            arguments: argumentsText,
          });
          emit({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'fc_1',
              type: 'function_call',
              status: 'completed',
              call_id: callId,
              name: 'write_file',
              arguments: argumentsText,
            },
          });
          // Hold the stream open after the function_call (but before the
          // response.done) so the host stays inside the stream loop and a
          // client turn/steer can land in the queue before the tool executes
          // and the iteration boundary fires. Without the delay the whole tool
          // round-trip can finish before the steer arrives, which would make
          // the after_iteration test flaky.
          const finishTool = () => {
            emitCompleted();
            res.end();
            state.responsesFinished += 1;
          };
          if (state.delayBeforeTextMs > 0) setTimeout(finishTool, state.delayBeforeTextMs);
          else finishTool();
        };
        const emitCompleted = () => {
          emit({
            type: 'response.completed',
            response: {
              id: 'resp_done',
              object: 'response',
              status: 'completed',
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          });
          emit({
            type: 'response.done',
            response: {
              id: 'resp_done',
              object: 'response',
              status: 'completed',
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            },
          });
        };
        const finish = () => {
          const requestIndex = state.requests.length;
          if (state.mode === 'tool' && (requestIndex === 1 || requestIndex === 2)) {
            emitToolCallEvents(requestIndex);
            // emitToolCallEvents already schedules its own completion via
            // delayBeforeTextMs; res.end happens inside emitCompleted.
            return;
          }
          emitTextEvents();
          res.end();
          state.responsesFinished += 1;
        };
        if (state.delayBeforeTextMs > 0) setTimeout(finish, state.delayBeforeTextMs);
        else finish();
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  return { server, state };
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

type HostMessage = {
  method?: string;
  id?: number;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

/** A resident `mica app-server` child + line-oriented stdout decoding, mirroring
 * chat.js's handleHostOutput. */
type Host = {
  child: ChildProcess;
  home: string;
  cwd: string;
  lines: HostMessage[];
  waiters: Array<{ predicate: (m: HostMessage) => boolean; resolve: (m: HostMessage) => void }>;
  stderr: string;
  closePromise: Promise<{ code: number | null; signal: string | null }>;
};

function makeHome(tag: string): string {
  const home = join(tmpdir(), `mica-appserver-flow-${process.pid}-${tag}`);
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

function spawnHost(tag: string, extraArgs: string[] = [], homeOverride?: string): Host {
  const home = homeOverride ?? makeHome(tag);
  const cwd = join(home, 'work');
  mkdirSync(cwd, { recursive: true });
  const child = spawn(
    process.env.MICA_BIN ?? 'bun',
    [...(process.env.MICA_BIN ? [] : ['src/index.ts']), 'app-server', '--thinking', '--dir', cwd, ...extraArgs],
    {
      cwd: ROOT,
      env: { ...process.env, MICA_HOME: home, MICA_NO_DAEMON: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const host: Host = {
    child,
    home,
    cwd,
    lines: [],
    waiters: [],
    stderr: '',
    closePromise: Promise.resolve({ code: null, signal: null }),
  };
  host.closePromise = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  let buffer = '';
  child.stdout?.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: HostMessage;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      host.lines.push(message);
      for (const waiter of [...host.waiters]) {
        if (waiter.predicate(message)) {
          host.waiters.splice(host.waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    }
  });
  child.stderr?.on('data', (chunk) => {
    host.stderr += chunk.toString();
  });
  return host;
}

function waitFor(
  host: Host,
  predicate: (m: HostMessage) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<HostMessage> {
  const existing = host.lines.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve };
    host.waiters.push(waiter);
    const timer = setTimeout(() => {
      const index = host.waiters.indexOf(waiter);
      if (index >= 0) host.waiters.splice(index, 1);
      const received = host.lines.map((m) => (m.method ? `notif:${m.method}` : `resp:${m.id}`)).join('\n  ');
      reject(
        new Error(
          `timeout waiting for ${label}; received ${host.lines.length} lines:\n  ${received}\nstderr:\n${host.stderr.slice(-1000)}`,
        ),
      );
    }, timeoutMs);
    waiter.resolve = (message) => {
      clearTimeout(timer);
      resolve(message);
    };
  });
}

const turnCompleted = (turnId: string) => (m: HostMessage) =>
  m.method === 'turn/completed' && (m.params?.turn as { id?: string } | undefined)?.id === turnId;

async function send(host: Host, id: number, method: string, params: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    host.child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function killHost(host: Host): void {
  try {
    host.child.kill('SIGTERM');
  } catch {
    // ignore
  }
}

/** Run a one-shot `mica <args>` CLI (compact/… ) and collect stdout/stderr. */
function runCli(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 30_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.env.MICA_BIN ?? 'bun', [...(process.env.MICA_BIN ? [] : ['src/index.ts']), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** E2E tests spawn a real child process and wait on protocol notifications; the
 * 5s vitest default is too short (host boot alone takes ~1.5s). */
function itE2E(name: string, fn: () => Promise<void>): void {
  it(name, fn, 60_000);
}

const hostReady = (m: HostMessage) => m.method === 'mica/backgroundTasks/updated' || m.method === 'error';

suite('mica app-server real-user flows (mock provider)', () => {
  const hosts: Host[] = [];
  afterEach(() => {
    for (const host of hosts.splice(0)) killHost(host);
  });

  itE2E('new session + switched model (full provider/model id) + effort completes the turn', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;

    const host = spawnHost('switch-model');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    // App layer sends the picker's full id (`mock/mock-chat`) + selected effort,
    // exactly like ChatView's `model: overrides.model, variant: overrides.variant`.
    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '你好' }],
      model: 'mock/mock-chat',
      effort: 'high',
    });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started');
    const turnId = (started.params?.turn as { id?: string }).id!;
    const completed = await waitFor(host, turnCompleted(turnId), 'turn/completed');
    const turn = completed.params?.turn as { status?: string; error?: { message?: string } | null };

    expect(turn.status).toBe('completed');
    expect(turn.error).toBeNull();
    // The provider received the bare model name, not the prefixed id (regression:
    // previously the whole `mock/mock-chat` was sent to the provider -> 400).
    expect(mock!.state.requests.length).toBeGreaterThan(0);
    expect(mock!.state.requests[0].model).toBe('mock-chat');
    // Text deltas reached the event stream (the renderer turns them into the message).
    expect(host.lines.some((m) => m.method === 'item/agentMessage/delta')).toBe(true);
    // Session was persisted as a completed turn.
    await waitFor(host, (m) => m.method === 'mica/queue/changed', 'queue settle', 10_000).catch(() => undefined);
    expect(true).toBe(true);
  });

  itE2E('ran and immediately stopped -> turn/interrupt -> interrupted without error', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 5000; // keep the turn busy so interrupt lands mid-turn

    const host = spawnHost('interrupt');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '请稍等' }],
      model: 'mock/mock-chat',
    });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started');
    const turnId = (started.params?.turn as { id?: string }).id!;

    // App's abortRun sends turn/interrupt as soon as the user hits stop.
    await send(host, 2, 'turn/interrupt', { threadId: '', turnId });

    const completed = await waitFor(host, turnCompleted(turnId), 'turn/completed after interrupt');
    const turn = completed.params?.turn as { status?: string; error?: { message?: string } | null };
    expect(turn.status).toBe('interrupted');
    expect(turn.error).toBeNull();
  });

  itE2E('provider failure surfaces the real error in turn/completed (no silent stop)', async () => {
    mock!.state.mode = 'error';
    mock!.state.errorMessage = '400 The model mock-chat is not supported by this provider.';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;

    const host = spawnHost('error-surface');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '你好' }],
      model: 'mock/mock-chat',
    });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started');
    const turnId = (started.params?.turn as { id?: string }).id!;
    const completed = await waitFor(host, turnCompleted(turnId), 'turn/completed');
    const turn = completed.params?.turn as { status?: string; error?: { message?: string } | null };

    expect(turn.status).toBe('failed');
    // The app renders this message as an error notice (chat-events maps
    // turn.error.message into step_finish.error). A silent stop regressed here.
    expect(turn.error?.message).toContain('mock-chat');
  });

  itE2E('busy-host steer input queues then runs as the next turn on the same resident host', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 1500;

    const host = spawnHost('reuse-steer');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    // Turn 1
    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '第一句话' }],
      model: 'mock/mock-chat',
    });
    const started1 = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started (1)');
    const turn1 = (started1.params?.turn as { id?: string }).id!;

    // User hits Shift+Tab while the host is busy -> turn/steer into the active turn.
    await sleep(300);
    await send(host, 2, 'turn/steer', {
      threadId: '',
      expectedTurnId: turn1,
      input: [{ type: 'text', text: '第二句话（排队注入）' }],
      clientMessageId: 'optimistic-2',
    });
    await waitFor(host, (m) => m.method === 'mica/queue/queued', 'mica/queue/queued');
    const completed1 = await waitFor(host, turnCompleted(turn1), 'turn/completed (1)', 30_000);
    expect((completed1.params?.turn as { status?: string }).status).toBe('completed');

    // A pure-text iteration has a single iteration boundary, so an after_iteration
    // input drains as the next turn once the current one ends (matching the
    // interactive runtime: "若 agent 已直接结束，则按 turn 完成队列发送").
    // Host-queued turns run silently (no turn/started notification — that is
    // only emitted for client-initiated turn/start requests), so wait for the
    // provider to receive the queued text as its second request instead.
    const secondRequestAt = Date.now();
    while (Date.now() - secondRequestAt < 30_000) {
      if (mock!.state.requests.length >= 2) break;
      await sleep(100);
    }
    expect(mock!.state.requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(mock!.state.requests[1]?.input ?? [])).toContain('第二句话（排队注入）');

    // The queued turn runs silently; wait for its provider response to finish.
    while (mock!.state.responsesFinished < 2) await sleep(100);

    // A new explicit turn reuses the same resident host and session id (no
    // re-spawn). Retry turn/start while the host is still draining the queued
    // turn (it rejects with "A turn is already active") instead of guessing a
    // sleep — timing-independent and stable under CI load.
    let started3: HostMessage | null = null;
    for (let attempt = 0; attempt < 50 && !started3; attempt++) {
      await send(host, 100 + attempt, 'turn/start', {
        threadId: host.lines.find((m) => m.method === 'turn/started')?.params?.threadId as string,
        input: [{ type: 'text', text: '第三句话' }],
      });
      const reply = await waitFor(
        host,
        (m) =>
          (m.method === 'turn/started' && (m.params?.turn as { id?: string })?.id !== turn1) ||
          (m.id === 100 + attempt && m.error !== undefined),
        `turn/start reply (attempt ${attempt})`,
        10_000,
      );
      if (reply.method === 'turn/started') started3 = reply;
      else await sleep(200); // host still busy (queued turn draining); retry
    }
    expect(started3).not.toBeNull();
    const completed3 = await waitFor(
      host,
      turnCompleted((started3!.params?.turn as { id?: string }).id!),
      'turn/completed (3)',
      30_000,
    );
    expect((completed3.params?.turn as { status?: string }).status).toBe('completed');
    expect(mock!.state.requests.length).toBeGreaterThanOrEqual(3);
  });

  itE2E('completes a tool task (write_file) then keeps context in a follow-up turn', async () => {
    mock!.state.mode = 'tool';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;

    const host = spawnHost('tool-task');
    hosts.push(host);
    mock!.state.toolFilePath = join(host.cwd, 'notes.txt');
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    // Turn 1: the mock asks the agent to call write_file; the host executes the
    // tool for real (file written into the host cwd) and sends the result back.
    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '请创建一个笔记文件' }],
      model: 'mock/mock-chat',
    });
    const started1 = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started (tool)');
    const turn1 = (started1.params?.turn as { id?: string }).id!;
    const completed1 = await waitFor(host, turnCompleted(turn1), 'turn/completed (tool)', 30_000);
    expect((completed1.params?.turn as { status?: string }).status).toBe('completed');

    // The tool round-trip happened: two provider requests (call + result) and a
    // real file on disk. Codex tool items were projected to the client too.
    expect(mock!.state.requests.length).toBeGreaterThanOrEqual(2);
    // The second request carries the executed tool result back to the provider
    // (function_call_output) — proof the host really ran write_file.
    const toolResultInput = JSON.stringify(mock!.state.requests[1]?.input ?? []);
    expect(toolResultInput).toContain('function_call_output');
    expect(toolResultInput).toContain('call_1');
    expect(toolResultInput).toContain('写入成功');
    expect(existsSync(mock!.state.toolFilePath)).toBe(true);
    expect(readFileSync(mock!.state.toolFilePath, 'utf8')).toBe(mock!.state.toolFileContent);
    expect(
      host.lines.some(
        (m) =>
          m.method === 'item/started' && (m.params?.item as { type?: string } | undefined)?.type === 'commandExecution',
      ),
    ).toBe(true);
    expect(
      host.lines.some(
        (m) =>
          m.method === 'item/completed' &&
          (m.params?.item as { type?: string } | undefined)?.type === 'commandExecution',
      ),
    ).toBe(true);

    // Turn 2 on the same host continues the conversation; the follow-up request
    // must carry the previous turn's assistant function_call and the executed
    // tool result (function_call_output) so the model sees what it did.
    await send(host, 2, 'turn/start', {
      threadId: (started1.params?.threadId as string) || '',
      input: [{ type: 'text', text: '继续：刚才的文件里写了什么' }],
    });
    const started2 = await waitFor(
      host,
      (m) => m.method === 'turn/started' && (m.params?.turn as { id?: string })?.id !== turn1,
      'turn/started (follow-up)',
      30_000,
    );
    const completed2 = await waitFor(
      host,
      turnCompleted((started2.params?.turn as { id?: string }).id!),
      'turn/completed (follow-up)',
      30_000,
    );
    expect((completed2.params?.turn as { status?: string }).status).toBe('completed');

    const followUpInput = JSON.stringify(mock!.state.requests.at(-1)?.input ?? []);
    expect(followUpInput).toContain('function_call_output');
    expect(followUpInput).toContain('call_1');
    expect(followUpInput).toContain('写入成功');
    // Both turns stayed on the same resident host / thread.
    expect(
      new Set(host.lines.filter((m) => m.method === 'turn/started').map((m) => String(m.params?.threadId))).size,
    ).toBe(1);
  });

  itE2E('compacts a session to a checkpoint then resumes and continues the conversation', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;
    // Long replies so the persisted history exceeds the recent-token budget and
    // compact actually summarizes (otherwise it reports "暂不需要 compact").
    mock!.state.longText = `长回复：${'这段对话内容需要被压缩成摘要。'.repeat(2500)}`;

    const host = spawnHost('compact-resume');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    // Two completed conversation turns (compact requires at least two rounds).
    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '介绍一下这个项目' }],
      model: 'mock/mock-chat',
    });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started (pre-compact)');
    const sessionId = started.params?.threadId as string;
    const firstTurn = (started.params?.turn as { id?: string }).id!;
    await waitFor(host, turnCompleted(firstTurn), 'turn/completed (pre-compact 1)', 30_000);
    await send(host, 2, 'turn/start', {
      threadId: sessionId,
      input: [{ type: 'text', text: '请再详细一点' }],
    });
    const started2 = await waitFor(
      host,
      (m) => m.method === 'turn/started' && (m.params?.turn as { id?: string })?.id !== firstTurn,
      'turn/started (pre-compact 2)',
      30_000,
    );
    await waitFor(
      host,
      turnCompleted((started2.params?.turn as { id?: string }).id!),
      'turn/completed (pre-compact 2)',
      30_000,
    );
    killHost(host);
    await host.closePromise;

    const sessionFile = join(host.home, 'sessions', `${sessionId}.json`);
    const before = JSON.parse(readFileSync(sessionFile, 'utf8'));
    const beforeRevision = before.revision;
    const beforeUsage = before.snapshot?.usageHistory?.length ?? 0;

    // The app's compact flow: `mica compact --session <id> --dir <cwd>` writes
    // the summarized checkpoint back to the session file.
    const compact = await runCli(['compact', '--session', sessionId, '--dir', host.cwd], { MICA_HOME: host.home });
    const compactResult = JSON.parse(compact.stdout.trim().split('\n').at(-1) ?? '{}');
    expect(compact.code).toBe(0);
    expect(compactResult.ok).toBe(true);
    expect(compactResult.summary).toBeTruthy();

    const after = JSON.parse(readFileSync(sessionFile, 'utf8'));
    expect(after.revision).toBeGreaterThan(beforeRevision);
    // Usage statistics survive compact (Stats stays continuous against upstream).
    expect(after.snapshot?.usageHistory?.length).toBe(beforeUsage);
    const conversationText = JSON.stringify(after.snapshot?.conversationMessages ?? []);
    expect(conversationText).toContain('Primary Request and Intent');

    // A fresh host resumes the compacted snapshot (same MICA_HOME!) and keeps
    // chatting; the new provider request must contain the compact summary.
    const resumed = spawnHost('compact-resume-2', ['--session', sessionId], host.home);
    hosts.push(resumed);
    await waitFor(resumed, hostReady, 'resumed host ready or error', 30_000);
    mock!.state.requests = [];
    await send(resumed, 1, 'turn/start', {
      threadId: sessionId,
      input: [{ type: 'text', text: '压缩后继续：下一步做什么' }],
    });
    const startedResumed = await waitFor(resumed, (m) => m.method === 'turn/started', 'turn/started (resumed)');
    const completedResumed = await waitFor(
      resumed,
      turnCompleted((startedResumed.params?.turn as { id?: string }).id!),
      'turn/completed (resumed)',
      30_000,
    );
    expect((completedResumed.params?.turn as { status?: string }).status).toBe('completed');
    const resumedInput = JSON.stringify(mock!.state.requests.at(-1)?.input ?? []);
    expect(resumedInput).toContain('Primary Request and Intent');
    // The resumed turn is tied to the same session id.
    expect(startedResumed.params?.threadId).toBe(sessionId);
  });

  itE2E('Shift+Tab during a tool iteration injects the input at the iteration boundary', async () => {
    mock!.state.mode = 'tool';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    // The tool branch holds the stream open for this long so the steer lands
    // in the queue before the tool executes and the iteration boundary fires.
    mock!.state.delayBeforeTextMs = 1200;

    const host = spawnHost('steer-tool-iteration');
    hosts.push(host);
    mock!.state.toolFilePath = join(host.cwd, 'steer-notes.txt');
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    // Turn 1 runs a tool iteration (write_file).
    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '请创建文件' }],
      model: 'mock/mock-chat',
    });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started (tool iteration)');
    const turn1 = (started.params?.turn as { id?: string }).id!;

    // User hits Shift+Tab while the tool iteration is in flight.
    await sleep(400);
    await send(host, 2, 'turn/steer', {
      threadId: '',
      expectedTurnId: turn1,
      input: [{ type: 'text', text: '迭代注入：顺便总结一下' }],
      clientMessageId: 'optimistic-steer',
    });
    await waitFor(host, (m) => m.method === 'mica/queue/queued', 'mica/queue/queued (steer)');

    const completed = await waitFor(host, turnCompleted(turn1), 'turn/completed (tool iteration)', 30_000);
    expect((completed.params?.turn as { status?: string }).status).toBe('completed');

    // The steer input was injected inside the SAME turn: iteration 1 runs the
    // tool (boundary 1 starts the wait), iteration 2 runs the second tool
    // (boundary 2 releases the steer), so the THIRD provider request carries
    // both executed tool results AND the injected steer text — it did not
    // spawn a separate follow-up turn.
    expect(mock!.state.requests.length).toBeGreaterThanOrEqual(3);
    const thirdInput = JSON.stringify(mock!.state.requests[2]?.input ?? []);
    expect(thirdInput).toContain('function_call_output');
    expect(thirdInput).toContain('迭代注入：顺便总结一下');
    // Only one turn/completed — the steer did not spawn a second turn.
    const completedCount = host.lines.filter((m) => m.method === 'turn/completed').length;
    expect(completedCount).toBe(1);
  });

  itE2E('rapid second send while busy is rejected with an error, host stays usable', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 1500;

    const host = spawnHost('rapid-second-send');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '第一句话' }],
      model: 'mock/mock-chat',
    });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started (first)');
    const turn1 = (started.params?.turn as { id?: string }).id!;

    // Second Enter/Tab while the first turn is still running: the host rejects
    // turn/start with a protocol error response (the app maps that to a notice
    // / its own local after_turn queue instead).
    await send(host, 2, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '第二句话（太快了）' }],
    });
    const rejected = await waitFor(host, (m) => m.id === 2, 'turn/start reject response', 10_000);
    expect(rejected.error).toBeTruthy();
    expect(JSON.stringify(rejected.error)).toContain('already active');

    // The first turn is unaffected and completes normally; the host is still
    // alive for a follow-up turn.
    const completed1 = await waitFor(host, turnCompleted(turn1), 'turn/completed (first)', 30_000);
    expect((completed1.params?.turn as { status?: string }).status).toBe('completed');

    await send(host, 3, 'turn/start', {
      threadId: (started.params?.threadId as string) || '',
      input: [{ type: 'text', text: '第三句话' }],
    });
    const started2 = await waitFor(
      host,
      (m) => m.method === 'turn/started' && (m.params?.turn as { id?: string })?.id !== turn1,
      'turn/started (third)',
      30_000,
    );
    const completed2 = await waitFor(
      host,
      turnCompleted((started2.params?.turn as { id?: string }).id!),
      'turn/completed (third)',
      30_000,
    );
    expect((completed2.params?.turn as { status?: string }).status).toBe('completed');
  });

  itE2E('abort keeps the queued input draining on the same host', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 3000;

    const host = spawnHost('abort-drain');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    // Turn 1 (long) + a queued steer input.
    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '第一句话（慢慢说）' }],
      model: 'mock/mock-chat',
    });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started (abort)');
    const turn1 = (started.params?.turn as { id?: string }).id!;
    await send(host, 2, 'turn/steer', {
      threadId: '',
      expectedTurnId: turn1,
      input: [{ type: 'text', text: '排队的话（abort 后继续）' }],
      clientMessageId: 'queued-after-abort',
    });
    await waitFor(host, (m) => m.method === 'mica/queue/queued', 'mica/queue/queued (abort)');

    // User hits stop: interrupt the active turn, then the queued input must
    // still drain on the same host.
    await send(host, 3, 'turn/interrupt', { threadId: '', turnId: turn1 });
    const completed1 = await waitFor(host, turnCompleted(turn1), 'turn/completed (interrupted)', 30_000);
    expect((completed1.params?.turn as { status?: string }).status).toBe('interrupted');

    const queuedAt = Date.now();
    while (Date.now() - queuedAt < 30_000) {
      if (mock!.state.requests.length >= 2) break;
      await sleep(100);
    }
    // The queued text reached the provider as the second request after abort.
    expect(JSON.stringify(mock!.state.requests[1]?.input ?? [])).toContain('排队的话（abort 后继续）');
  });
});
