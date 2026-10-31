import { describe, expect, it } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
const ROOT = join(TEST_DIR, '..', '..', '..', '..');

const bunAvailable = process.env.MICA_BIN || spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
const suite = bunAvailable ? describe : describe.skip;

/** Open a `node:http` server pretending to be an OpenAI-compatible responses
 * provider. Programmable per test: normal SSE stream, 400 error, or a delay
 * before the text arrives (to keep a turn busy long enough to steer into it). */
function createMockProvider() {
  const state = {
    mode: 'ok' as 'ok' | 'error' | 'tool' | 'shell' | 'wait',
    errorMessage: '',
    delayBeforeTextMs: 0,
    requests: [] as Array<{
      model: string;
      input: unknown[];
      reasoning?: { effort?: string };
      /** System prompt the request carried (role prompt included); role-switch
       * tests assert the switched role actually reached the provider. */
      instructions?: string;
    }>,
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
    /** `shell` mode: the command the mock asks `background_tasks_start` to
     * start, so the tests can drive `mica/backgroundTasks/*`.
     * `/bin/echo` instead of the shell builtin: bash block-buffers builtin output
     * when stdout is a file, so on Linux the first lines only land once `sleep`
     * returns — the external binary writes to the fd immediately. */
    shellCommand: '/bin/echo tick-1; /bin/echo tick-2; sleep 60',
    /** `wait` mode: the `wait_for` arguments the mock emits on request #1, so
     * the tests can drive `mica/waitTasks/updated` (a long wait keeps the turn
     * blocked while the host streams its snapshot). */
    waitArguments: { kind: 'duration', seconds: 20, poll_interval_ms: 500 },
    /** Override reply text; compact tests use a long reply so the checkpoint
     * exceeds the recent-token budget and actually summarizes. */
    longText: '',
    includeReasoning: false,
    /** `input_tokens` reported on every completed response. Auto-compaction
     * thresholds are compared against it, so tests raise it past a threshold. */
    inputTokens: 10,
  };
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/v1/responses')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk.toString()));
      req.on('end', () => {
        let parsed: {
          model?: string;
          input?: unknown[];
          reasoning?: { effort?: string };
          instructions?: string;
        } = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          // keep defaults
        }
        const { model = '', input = [], reasoning, instructions } = parsed;
        state.requests.push({ model, input, reasoning, instructions });
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
          if (state.includeReasoning) {
            emit({
              type: 'response.reasoning_summary_text.delta',
              item_id: 'reasoning_1',
              output_index: 0,
              content_index: 0,
              delta: 'thinking...',
            });
            emit({
              type: 'response.reasoning_summary_text.done',
              item_id: 'reasoning_1',
              output_index: 0,
              content_index: 0,
              text: 'thinking...',
            });
          }
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
        /** `shell` mode: one `background_tasks_start` call, answered immediately —
         * the task it starts outlives this response (and the turn), which is
         * exactly the state `mica/backgroundTasks/*` has to reach. */
        const emitShellCallEvents = () => {
          const argumentsText = JSON.stringify({ command: state.shellCommand });
          emit({ type: 'response.created', response: { id: 'resp_3', object: 'response' } });
          emit({ type: 'response.in_progress', response: { id: 'resp_3', object: 'response' } });
          emit({
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'fc_shell',
              type: 'function_call',
              status: 'in_progress',
              call_id: 'call_shell',
              name: 'background_tasks_start',
              arguments: '',
            },
          });
          emit({
            type: 'response.function_call_arguments.done',
            output_index: 0,
            item_id: 'fc_shell',
            arguments: argumentsText,
          });
          emit({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'fc_shell',
              type: 'function_call',
              status: 'completed',
              call_id: 'call_shell',
              name: 'background_tasks_start',
              arguments: argumentsText,
            },
          });
          emitCompleted();
          res.end();
          state.responsesFinished += 1;
        };
        /** `wait` mode: one `wait_for` call that keeps the turn blocked for
         * `state.waitArguments.seconds`, so the host has to publish
         * `mica/waitTasks/updated` while the turn is still running. */
        const emitWaitCallEvents = () => {
          const argumentsText = JSON.stringify(state.waitArguments);
          emit({ type: 'response.created', response: { id: 'resp_4', object: 'response' } });
          emit({ type: 'response.in_progress', response: { id: 'resp_4', object: 'response' } });
          emit({
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'fc_wait',
              type: 'function_call',
              status: 'in_progress',
              call_id: 'call_wait',
              name: 'wait_for',
              arguments: '',
            },
          });
          emit({
            type: 'response.function_call_arguments.done',
            output_index: 0,
            item_id: 'fc_wait',
            arguments: argumentsText,
          });
          emit({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'fc_wait',
              type: 'function_call',
              status: 'completed',
              call_id: 'call_wait',
              name: 'wait_for',
              arguments: argumentsText,
            },
          });
          emitCompleted();
          res.end();
          state.responsesFinished += 1;
        };
        const emitCompleted = () => {
          emit({
            type: 'response.completed',
            response: {
              id: 'resp_done',
              object: 'response',
              status: 'completed',
              usage: {
                input_tokens: state.inputTokens,
                output_tokens: 5,
                total_tokens: state.inputTokens + 5,
              },
            },
          });
          emit({
            type: 'response.done',
            response: {
              id: 'resp_done',
              object: 'response',
              status: 'completed',
              usage: {
                input_tokens: state.inputTokens,
                output_tokens: 5,
                total_tokens: state.inputTokens + 5,
              },
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
          if (state.mode === 'shell' && requestIndex === 1) {
            emitShellCallEvents();
            return;
          }
          if (state.mode === 'wait' && requestIndex === 1) {
            emitWaitCallEvents();
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

type MockProvider = ReturnType<typeof createMockProvider>;

/** Everything one test owns: its own mock provider (its own port, its own
 * programmable state), its own hosts, and the `MICA_HOME` dirs to clean up.
 * Tests run concurrently (`it.concurrent`), so none of this may be shared. */
type MockContext = {
  mock: MockProvider;
  baseUrl: string;
  hosts: Host[];
};

const mockContext = new AsyncLocalStorage<MockContext>();

function currentMock(): MockContext {
  const context = mockContext.getStore();
  if (!context) throw new Error('flow test ran outside its mock context');
  return context;
}

/** Per-test programmable provider state. Kept nameable as `mock.state` so the
 * 200+ call sites stay unchanged while each concurrent test gets its own. */
const mock = {
  get state() {
    return currentMock().mock.state;
  },
};

/** Hosts spawned by the running test; `itE2E` kills them afterwards. */
const hosts = {
  push(host: Host): void {
    currentMock().hosts.push(host);
  },
};

type HostMessage = {
  method?: string;
  id?: number;
  params?: Record<string, unknown>;
  emittedAtMs?: number;
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
            api_base: currentMock().baseUrl,
            api_key: 'test-key',
            models: ['mock-chat'],
            effortLevels: ['low', 'medium', 'high'],
          },
        ],
      },
      null,
      2,
    ),
  );
  mkdirSync(join(home, 'sessions'), { recursive: true });
  // 这些用例量的是 turn 机制（请求顺序、排队、中断），不是自动起标题：插件现在默认
  // 复用会话模型，会在每轮之前多打一次模型请求，把请求序列对乱。要测标题行为时单独开。
  writeFileSync(join(home, 'plugins-state.json'), JSON.stringify({ disabled: ['session-rename'] }));
  return home;
}

/**
 * Provider that declares no effort levels at all (and whose model name models.dev
 * does not know). This is the endpoint shape that used to take the whole host
 * down when the desktop replayed its last-chosen `--variant`.
 */
function makeHomeWithoutEffortLevels(tag: string): string {
  const home = makeHome(tag);
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify(
      {
        providers: [
          {
            id: 'mock',
            name: 'Mock',
            protocol: 'openai_responses',
            api_base: currentMock().baseUrl,
            api_key: 'test-key',
            models: ['mock-chat'],
          },
        ],
      },
      null,
      2,
    ),
  );
  return home;
}

/** makeHome variant with a slow stdio MCP server (3s initialize delay), used to
 * verify the host becomes ready before MCP init finishes and the first turn
 * waits for it. */
function makeHomeWithSlowMcp(tag: string): string {
  const home = makeHome(tag);
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify(
      {
        providers: [
          {
            id: 'mock',
            name: 'Mock',
            protocol: 'openai_responses',
            api_base: currentMock().baseUrl,
            api_key: 'test-key',
            models: ['mock-chat'],
            effortLevels: ['low', 'medium', 'high'],
          },
        ],
        mcpServers: {
          slow: { command: process.execPath, args: [join(home, 'slow-mcp-server.mjs')] },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(home, 'slow-mcp-server.mjs'),
    [
      "import { createInterface } from 'node:readline';",
      'const rl = createInterface({ input: process.stdin });',
      'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
      "const respond = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
      "rl.on('line', async (line) => {",
      '  let msg;',
      '  try { msg = JSON.parse(line); } catch { return; }',
      "  if (msg.method === 'initialize') {",
      '    await sleep(3000);',
      "    respond(msg.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'slow-mock', version: '1.0.0' } });",
      "  } else if (msg.method === 'tools/list') {",
      '    respond(msg.id, { tools: [] });',
      '  }',
      '});',
      '',
    ].join('\n'),
  );
  return home;
}

function spawnHost(tag: string, extraArgs: string[] = [], homeOverride?: string): Host {
  const home = homeOverride ?? makeHome(tag);
  const cwd = join(home, 'work');
  mkdirSync(cwd, { recursive: true });
  const child = spawn(
    process.env.MICA_BIN ?? 'bun',
    [...(process.env.MICA_BIN ? [] : ['apps/cli/src/index.ts']), 'app-server', '--dir', cwd, ...extraArgs],
    {
      cwd: ROOT,
      env: { ...process.env, MICA_HOME: home },
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

/** Write one unencoded protocol line so parse failures can be exercised through
 * the same real child-process stdin transport as normal requests. */
async function sendRaw(host: Host, line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    host.child.stdin!.write(`${line}\n`, (error) => (error ? reject(error) : resolve()));
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
    const child = spawn(
      process.env.MICA_BIN ?? 'bun',
      [...(process.env.MICA_BIN ? [] : ['apps/cli/src/index.ts']), ...args],
      {
        cwd: ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
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

/** UI conversation message content -> plain text (string or content blocks). */
function contentTextOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : '',
    )
    .join('');
}

/** E2E tests spawn a real child process and wait on protocol notifications; the
 * 5s vitest default is too short (host boot alone takes ~1.5s).
 *
 * Each test is fully self-contained (own mock provider + own `MICA_HOME`), so
 * they run concurrently: the wall clock of this file is then a few host boots
 * instead of 39 of them in a row. `maxConcurrency` in vitest.config.ts caps how
 * many real `mica` children run at once. */
function itE2E(name: string, fn: () => Promise<void>): void {
  it.concurrent(
    name,
    async () => {
      const context = await startMockContext();
      try {
        await mockContext.run(context, fn);
      } finally {
        await stopMockContext(context);
      }
    },
    60_000,
  );
}

async function startMockContext(): Promise<MockContext> {
  const provider = createMockProvider();
  await new Promise<void>((resolve) => provider.server.listen(0, '127.0.0.1', resolve));
  const { port } = provider.server.address() as AddressInfo;
  return { mock: provider, baseUrl: `http://127.0.0.1:${port}/v1`, hosts: [] };
}

/** Kill the test's hosts, drop their `MICA_HOME` dirs, close the mock server.
 * Hosts get a hard deadline so one wedged child cannot hold the file open. */
async function stopMockContext(context: MockContext): Promise<void> {
  for (const host of context.hosts) killHost(host);
  await Promise.all(context.hosts.map((host) => Promise.race([host.closePromise, sleep(5_000)])));
  // Resumed hosts can share one home; remove it once, after every writer exits.
  for (const home of new Set(context.hosts.map((host) => host.home))) {
    rmSync(home, { recursive: true, force: true });
  }
  await new Promise<void>((resolve) => context.mock.server.close(() => resolve()));
}

const hostReady = (m: HostMessage) => m.method === 'mica/backgroundTasks/updated' || m.method === 'error';

suite('mica app-server real-user flows (mock provider)', () => {
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
    expect(
      host.lines.find(
        (m) =>
          m.method === 'item/completed' && (m.params?.item as { type?: string } | undefined)?.type === 'agentMessage',
      )?.params?.item,
    ).toMatchObject({ type: 'agentMessage', text: '你好，我是 mock 模型的回复' });
    // Session was persisted as a completed turn.
    const sessionFiles = readdirSync(join(host.home, 'sessions')).filter((file) => file.endsWith('.json'));
    expect(sessionFiles).toHaveLength(1);
    const session = JSON.parse(readFileSync(join(host.home, 'sessions', sessionFiles[0]!), 'utf8')) as {
      turnState?: string;
    };
    expect(session.turnState).toBe('completed');
  });

  itE2E('mica/turn/editMessage rewrites a sent message, drops what followed it and reruns', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;

    const host = spawnHost('edit-message');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'turn/start', { threadId: '', input: [{ type: 'text', text: '第一条' }] });
    const firstStart = await waitFor(host, (m) => m.method === 'turn/started', 'first turn/started');
    const firstTurnId = (firstStart.params?.turn as { id: string }).id;
    await waitFor(host, turnCompleted(firstTurnId), 'first turn/completed');

    await send(host, 2, 'turn/start', { threadId: '', input: [{ type: 'text', text: '第二条' }] });
    const secondStart = await waitFor(
      host,
      (m) => m.method === 'turn/started' && (m.params?.turn as { id?: string })?.id !== firstTurnId,
      'second turn/started',
    );
    const secondTurnId = (secondStart.params?.turn as { id: string }).id;
    await waitFor(host, turnCompleted(secondTurnId), 'second turn/completed');

    const requestsBeforeEdit = mock!.state.requests.length;

    await send(host, 3, 'mica/turn/editMessage', { prompt: '第一条', text: '第一条（改）' });

    // 客户端先收到历史替换（据此重载会话），再是新一轮的 turn 生命周期。
    await waitFor(host, (m) => m.method === 'mica/sessionHistory/replaced', 'history replaced');
    const editedStart = await waitFor(
      host,
      (m) =>
        m.method === 'turn/started' &&
        ![firstTurnId, secondTurnId].includes((m.params?.turn as { id?: string })?.id ?? ''),
      'edited turn/started',
    );
    const editedTurnId = (editedStart.params?.turn as { id: string }).id;
    await waitFor(host, turnCompleted(editedTurnId), 'edited turn/completed');

    // 被编辑消息之后的整轮（第二条 + 它的回答）必须从会话里消失，只剩改写后的那条。
    const sessionFiles = readdirSync(join(host.home, 'sessions')).filter((file) => file.endsWith('.json'));
    expect(sessionFiles).toHaveLength(1);
    const session = JSON.parse(readFileSync(join(host.home, 'sessions', sessionFiles[0]!), 'utf8')) as {
      snapshot?: { conversationMessages?: Array<{ role?: string; content?: unknown }> };
    };
    const userTexts = (session.snapshot?.conversationMessages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => contentTextOf(message.content));
    expect(userTexts).toEqual(['第一条（改）']);

    // 重跑时发给模型的历史里不能再带被截断的那一轮。
    expect(mock!.state.requests.length).toBeGreaterThan(requestsBeforeEdit);
    const rerunInput = JSON.stringify(mock!.state.requests.at(-1)!.input);
    expect(rerunInput).toContain('第一条（改）');
    expect(rerunInput).not.toContain('第二条');
  });

  itE2E('mica/btw/ask answers out-of-band without touching the main conversation', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;
    // 让模型先流出一段思考：它必须和正文一起到达客户端（btw 是运行实例，不是黑盒）。
    mock!.state.includeReasoning = true;

    const host = spawnHost('btw');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    // 先跑一轮：btw 拿主流程的对话记录当背景，桌面端也只在会话存在时才让问。
    await send(host, 1, 'turn/start', { threadId: '', input: [{ type: 'text', text: '你好' }] });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started');
    const turnId = (started.params?.turn as { id?: string }).id!;
    await waitFor(host, turnCompleted(turnId), 'turn/completed');

    const requestsBeforeBtw = mock!.state.requests.length;
    const entries = (m: HostMessage) => m.params?.entries as Array<Record<string, unknown>> | undefined;

    // 请求立刻返回（同步等一次模型回答会把中断/排队/撤回堵在它后面），
    // 答案经 mica/btw/updated 推回。
    await send(host, 2, 'mica/btw/ask', { question: '这个方案可行吗' });
    const ack = await waitFor(host, (m) => m.id === 2, 'btw ack');
    expect(ack.result).toMatchObject({ ok: true });
    const running = await waitFor(
      host,
      (m) => m.method === 'mica/btw/updated' && entries(m)?.[0]?.status === 'running',
      'btw running snapshot',
    );
    const answered = await waitFor(
      host,
      (m) => m.method === 'mica/btw/updated' && entries(m)?.[0]?.status === 'completed',
      'btw answer',
    );
    // 同一线程：追问复用同一个子代理，只有「新话题」才换线程。
    expect(running.params?.id).toBe(answered.params?.id);
    expect(entries(answered)?.[0]).toMatchObject({
      question: '这个方案可行吗',
      answer: '你好，我是 mock 模型的回复',
      // 流式期间推回的那段思考留在条目上（与主对话的回合日志同一语义）
      thinking: 'thinking...',
    });

    // 子代理的提示词带上了主流程的对话记录（btw 模式说明 + 背景记录）。
    expect(mock!.state.requests.length).toBe(requestsBeforeBtw + 1);
    const btwRequest = mock!.state.requests.at(-1)!;
    expect(btwRequest.instructions).toContain('btw');
    expect(btwRequest.instructions).toContain('你好');

    // 主流程完全不受影响：会话里没有 btw 的问答，turn 仍是正常完成，用量单独记账。
    const sessionFiles = readdirSync(join(host.home, 'sessions')).filter((file) => file.endsWith('.json'));
    expect(sessionFiles).toHaveLength(1);
    const session = JSON.parse(readFileSync(join(host.home, 'sessions', sessionFiles[0]!), 'utf8')) as {
      turnState?: string;
      snapshot?: {
        conversationMessages?: Array<{ role?: string; content?: unknown }>;
        subagentUsageHistory?: Array<{ subagentType?: string; status?: string }>;
      };
    };
    expect(session.turnState).toBe('completed');
    const userTexts = (session.snapshot?.conversationMessages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => contentTextOf(message.content));
    expect(userTexts).toEqual(['你好']);
    expect(session.snapshot?.subagentUsageHistory).toMatchObject([{ subagentType: 'btw', status: 'completed' }]);

    // 新开一条线程（抽屉的 `+`）：空问题只把 tab 建出来，不提问、不占用任何子代理。
    await send(host, 3, 'mica/btw/ask', { question: '' });
    const created = await waitFor(host, (m) => m.id === 3, 'btw thread created');
    const createdId = (created.result as { threadId?: string })?.threadId;
    expect(createdId).toBeTruthy();
    expect(createdId).not.toBe(answered.params?.id);

    // tab 清单（重开页面/重开 app 后恢复用）里两条线程都在，且各自带着自己的问答。
    await send(host, 4, 'mica/btw/threads', {});
    const listed = await waitFor(host, (m) => m.id === 4, 'btw threads listed');
    const list = ((listed.result as { threads?: Array<{ id: string; entries: unknown[] }> }).threads || []) as Array<{
      id: string;
      entries: unknown[];
    }>;
    expect(list.map((item) => item.id)).toEqual(expect.arrayContaining([createdId!]));
    expect(list.find((item) => item.id === createdId)?.entries).toHaveLength(0);

    // 关掉一个 tab：host 侧线程随之消失。
    await send(host, 5, 'mica/btw/close', { threadId: createdId });
    expect((await waitFor(host, (m) => m.id === 5, 'btw close')).result).toMatchObject({ ok: true });
    await send(host, 6, 'mica/btw/threads', {});
    const afterClose = await waitFor(host, (m) => m.id === 6, 'btw threads after close');
    const remaining = (afterClose.result as { threads?: Array<{ id: string }> }).threads || [];
    expect(remaining.map((item) => item.id)).not.toContain(createdId);
    expect(remaining.map((item) => item.id)).toContain(answered.params?.id as string);
  });

  itE2E('By The Way threads survive a host restart (persisted per session)', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;

    const hostA = spawnHost('btw-persist-a');
    // 不 push 进 hosts：hostB 会用同一个 home（resume 同一个会话），
    // 收尾清理会并行 rm 两个同路径的目录而抛 ENOTEMPTY。hostA 由我们自己关掉。
    await waitFor(hostA, hostReady, 'host A ready or error', 30_000);
    await send(hostA, 1, 'turn/start', { threadId: '', input: [{ type: 'text', text: '起个会话' }] });
    const started = await waitFor(hostA, (m) => m.method === 'turn/started', 'turn/started');
    await waitFor(hostA, turnCompleted((started.params?.turn as { id?: string }).id!), 'turn/completed');
    const sessionFileA = readdirSync(join(hostA.home, 'sessions')).find((file) => file.endsWith('.json'));
    expect(sessionFileA).toBeTruthy();
    const sessionId = sessionFileA!.replace(/\.json$/, '');

    await send(hostA, 2, 'mica/btw/ask', { question: '记住这个问题' });
    const ack = await waitFor(hostA, (m) => m.id === 2, 'btw ack');
    const threadId = (ack.result as { threadId?: string })?.threadId!;
    await waitFor(
      hostA,
      (m) =>
        m.method === 'mica/btw/updated' &&
        (m.params?.entries as Array<{ status?: string }> | undefined)?.[0]?.status === 'completed',
      'btw answered',
    );

    // 关掉 host（模拟退出 app），再用同一个 MICA_HOME resume 同一个会话。
    hostA.child.stdin?.end();
    await hostA.closePromise;
    expect(existsSync(join(hostA.home, 'btw', `${sessionId}.json`))).toBe(true);

    const hostB = spawnHost('btw-persist-b', ['--session', sessionId], hostA.home);
    hosts.push(hostB);
    await waitFor(hostB, hostReady, 'host B ready or error', 30_000);

    await send(hostB, 1, 'mica/btw/threads', {});
    const listed = await waitFor(hostB, (m) => m.id === 1, 'btw threads after restart');
    const threads =
      (listed.result as { threads?: Array<{ id: string; entries: Array<{ question?: string }> }> }).threads || [];
    // 抽屉里的 tab 与问答都还在：这正是「关掉 app 再打开」应该看到的
    expect(threads.map((item) => item.id)).toContain(threadId);
    expect(threads.find((item) => item.id === threadId)?.entries[0]).toMatchObject({
      question: '记住这个问题',
    });
  });

  itE2E('mica/btw/ask answers while the main turn is still running', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    // 让主流程这一轮卡在「等模型第一个字」上：提问必须落在 turn 还没结束的窗口里，
    // 否则测的又只是「空闲时能问」。
    mock!.state.delayBeforeTextMs = 3_000;

    const host = spawnHost('btw-running');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'turn/start', { threadId: '', input: [{ type: 'text', text: '先做点长活' }] });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started');
    const turnId = (started.params?.turn as { id?: string }).id!;

    const entries = (m: HostMessage) => m.params?.entries as Array<Record<string, unknown>> | undefined;

    // 主流程仍在跑：请求必须被当下收下（答案稍后经快照推回），而不是等这一轮结束。
    await send(host, 2, 'mica/btw/ask', { question: '主流程跑着的时候能问吗' });
    const ack = await waitFor(host, (m) => m.id === 2, 'btw ack');
    expect(ack.result).toMatchObject({ ok: true });
    expect(host.lines.some((m) => m.method === 'turn/completed')).toBe(false);

    const running = await waitFor(
      host,
      (m) => m.method === 'mica/btw/updated' && entries(m)?.[0]?.status === 'running',
      'btw running snapshot mid-turn',
    );
    // 快照里的线程 id 与主流程会话无关，但条目确实带着这一问。
    expect(entries(running)?.[0]).toMatchObject({ question: '主流程跑着的时候能问吗' });

    const answered = await waitFor(
      host,
      (m) => m.method === 'mica/btw/updated' && entries(m)?.[0]?.status === 'completed',
      'btw answer mid-turn',
    );
    expect(entries(answered)?.[0]).toMatchObject({ answer: '你好，我是 mock 模型的回复' });

    // 快照同时带这条线程自己的上下文占用（桌面抽屉底部的「模型 · ctx」就读它）：
    // 它是最近一次请求的 input，而不是主会话那份 tokenUsage。
    const context = answered.params?.context as Record<string, unknown> | undefined;
    expect(context).toMatchObject({ model: expect.any(String), requests: 1 });
    expect(Number(context?.tokens)).toBeGreaterThan(0);

    // 这条线程的历史里没有工具结果/图片 → 本地快速压缩如实回报「暂不需要」，
    // 而不是假装成功（面板据此提示原因）。
    await send(host, 3, 'mica/btw/compact', {});
    const compacted = await waitFor(host, (m) => m.id === 3, 'btw compact response');
    expect(compacted.result).toMatchObject({ ok: false });

    // 主流程照常跑完，且这一问没有落进会话历史。
    await waitFor(host, turnCompleted(turnId), 'turn/completed');
    const sessionFiles = readdirSync(join(host.home, 'sessions')).filter((file) => file.endsWith('.json'));
    const session = JSON.parse(readFileSync(join(host.home, 'sessions', sessionFiles[0]!), 'utf8')) as {
      turnState?: string;
      snapshot?: { conversationMessages?: Array<{ role?: string; content?: unknown }> };
    };
    expect(session.turnState).toBe('completed');
    const userTexts = (session.snapshot?.conversationMessages ?? [])
      .filter((message) => message.role === 'user')
      .map((message) => contentTextOf(message.content));
    expect(userTexts).toEqual(['先做点长活']);
  });

  itE2E('mica/session/rename persists an empty named session before the first turn', async () => {
    const host = spawnHost('rename-draft');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    // 还没有任何消息就改名（桌面端「给新对话起个名字」）：空会话要当场落盘，
    // 名字记成手动标题，并把 sessionId 交回客户端去绑定。
    await send(host, 1, 'mica/session/rename', { title: '先起个名字' });
    const renamed = await waitFor(host, (m) => m.id === 1, 'rename response', 10_000);
    expect(renamed.error).toBeUndefined();
    const sessionId = (renamed.result as { sessionId?: string }).sessionId;
    expect(typeof sessionId).toBe('string');
    expect(renamed.result).toMatchObject({ ok: true, title: '先起个名字' });

    const file = join(host.home, 'sessions', `${sessionId}.json`);
    expect(existsSync(file)).toBe(true);
    const session = JSON.parse(readFileSync(file, 'utf8')) as {
      title?: string;
      titleSource?: string;
      snapshot?: { conversationMessages?: unknown[] };
    };
    expect(session).toMatchObject({ title: '先起个名字', titleSource: 'manual' });
    expect(session.snapshot?.conversationMessages ?? []).toHaveLength(0);
  });

  itE2E('mica/session/rename renames the session while its turn is running', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    // 让这一轮停在「等模型第一个字」上：改名请求必须落在 turn 还没结束的窗口里。
    mock!.state.delayBeforeTextMs = 3_000;

    const host = spawnHost('rename-running');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'turn/start', { threadId: '', input: [{ type: 'text', text: '随便写点东西' }] });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started');
    const turnId = (started.params?.turn as { id?: string }).id!;

    // 常驻 host 持有会话文件（每一轮都按内存快照落盘），所以运行中改名只能经它；
    // 它当场返回，不等这一轮结束。
    await send(host, 2, 'mica/session/rename', { title: '运行中改名' });
    const renamed = await waitFor(host, (m) => m.id === 2, 'rename response', 5_000);
    expect(renamed.error).toBeUndefined();
    expect(renamed.result).toMatchObject({ ok: true, title: '运行中改名' });
    expect(host.lines.some((m) => m.method === 'turn/completed')).toBe(false);

    await waitFor(host, turnCompleted(turnId), 'turn/completed');

    // 这一轮自己的保存不能把标题覆盖回派生标题。
    const sessionFiles = readdirSync(join(host.home, 'sessions')).filter((file) => file.endsWith('.json'));
    expect(sessionFiles).toHaveLength(1);
    const session = JSON.parse(readFileSync(join(host.home, 'sessions', sessionFiles[0]!), 'utf8')) as {
      title?: string;
      titleSource?: string;
      turnState?: string;
    };
    expect(session).toMatchObject({ title: '运行中改名', titleSource: 'manual', turnState: 'completed' });

    // 空标题是协议层错误，不是「静默成功」。
    await send(host, 3, 'mica/session/rename', { title: '   ' });
    const invalid = await waitFor(host, (m) => m.id === 3 && m.error !== undefined, 'empty title');
    expect(invalid.error).toMatchObject({ code: -32602, message: 'title must not be empty' });
  });

  itE2E('--thinking forwards reasoning events through the app-server CLI entrypoint', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;
    mock!.state.includeReasoning = true;

    const host = spawnHost('thinking', ['--thinking']);
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '请先思考再回答' }],
    });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'thinking turn started');
    const turnId = (started.params?.turn as { id?: string }).id!;
    await waitFor(host, turnCompleted(turnId), 'thinking turn completed', 30_000);

    expect(
      host.lines.some(
        (message) => message.method === 'item/reasoning/textDelta' && message.params?.delta === 'thinking...',
      ),
    ).toBe(true);
  });

  itE2E('unknown protocol methods return -32601 and keep the resident host usable', async () => {
    const host = spawnHost('unknown-method');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'mica/doesNotExist', {});
    const unknown = await waitFor(host, (message) => message.id === 1 && message.error !== undefined, 'unknown method');
    expect(unknown.error).toMatchObject({ code: -32601, message: 'Method not found: mica/doesNotExist' });

    await send(host, 2, 'thread/start', { threadId: '' });
    const thread = await waitFor(
      host,
      (message) => message.id === 2 && message.result !== undefined,
      'thread after error',
    );
    expect(thread.result).toMatchObject({ thread: { id: expect.any(String) } });
  });

  itE2E('malformed JSON returns a parse error and keeps the resident host usable', async () => {
    const host = spawnHost('malformed-json');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await sendRaw(host, '{"id":1,"method":"thread/start"');
    const parseError = await waitFor(
      host,
      (message) => message.id === -32700 && message.error !== undefined,
      'malformed JSON parse error',
    );
    expect(parseError.error).toMatchObject({ code: -32600, message: 'Parse error' });

    await send(host, 2, 'thread/start', { threadId: '' });
    const thread = await waitFor(
      host,
      (message) => message.id === 2 && message.result !== undefined,
      'thread after parse error',
    );
    expect(thread.result).toMatchObject({ thread: { id: expect.any(String) } });
  });

  itE2E(
    'thread/resume rejects missing, non-string, and unknown session ids without contacting the provider',
    async () => {
      mock!.state.requests = [];
      const host = spawnHost('resume-errors');
      hosts.push(host);
      await waitFor(host, hostReady, 'host ready or error', 30_000);

      await send(host, 1, 'thread/resume', {});
      const missingId = await waitFor(
        host,
        (message) => message.id === 1 && message.error !== undefined,
        'missing thread id',
      );
      expect(missingId.error).toMatchObject({ code: -32602, message: 'threadId must not be empty' });

      await send(host, 2, 'thread/resume', { threadId: 42 });
      const nonStringId = await waitFor(
        host,
        (message) => message.id === 2 && message.error !== undefined,
        'non-string thread id',
      );
      expect(nonStringId.error).toMatchObject({ code: -32602, message: 'threadId must not be empty' });

      await send(host, 3, 'thread/resume', { threadId: 'missing-session-id' });
      const missingSession = await waitFor(
        host,
        (message) => message.id === 3 && message.error !== undefined,
        'missing session',
      );
      expect(missingSession.error).toMatchObject({ code: -32602, message: 'Session not found: missing-session-id' });
      expect(mock!.state.requests).toHaveLength(0);
    },
  );

  itE2E('invalid turn input and idle steer return -32602 without starting a provider request', async () => {
    mock!.state.requests = [];
    const host = spawnHost('turn-errors');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'turn/start', { threadId: '', input: [] });
    const invalidInput = await waitFor(
      host,
      (message) => message.id === 1 && message.error !== undefined,
      'invalid input',
    );
    expect(invalidInput.error).toMatchObject({ code: -32602, message: 'input must contain at least one item' });

    await send(host, 2, 'turn/start', { threadId: '', input: [null] });
    const invalidItem = await waitFor(
      host,
      (message) => message.id === 2 && message.error !== undefined,
      'invalid input item',
    );
    expect(invalidItem.error).toMatchObject({ code: -32602, message: 'input contains an invalid item' });

    await send(host, 3, 'turn/steer', {
      threadId: '',
      expectedTurnId: 'not-active',
      input: [{ type: 'text', text: '不能注入' }],
    });
    const idleSteer = await waitFor(host, (message) => message.id === 3 && message.error !== undefined, 'idle steer');
    expect(idleSteer.error).toMatchObject({ code: -32602, message: 'no active turn to steer' });
    expect(mock!.state.requests).toHaveLength(0);
    expect(host.lines.some((message) => message.method === 'turn/started')).toBe(false);
  });

  itE2E('active steer validates turn id and input without disturbing the running turn', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.delayBeforeTextMs = 5000;

    const host = spawnHost('steer-validation');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '保持运行，等待参数校验' }],
    });
    const started = await waitFor(host, (message) => message.method === 'turn/started', 'validation turn started');
    const turnId = (started.params?.turn as { id?: string }).id!;

    await send(host, 2, 'turn/steer', {
      threadId: '',
      input: [{ type: 'text', text: '缺少 turn id' }],
    });
    const missingTurnId = await waitFor(
      host,
      (message) => message.id === 2 && message.error !== undefined,
      'missing expected turn id',
    );
    expect(missingTurnId.error).toMatchObject({ code: -32602, message: 'expectedTurnId must not be empty' });

    await send(host, 3, 'turn/steer', {
      threadId: '',
      expectedTurnId: 'stale-turn-id',
      input: [{ type: 'text', text: '过期 turn id' }],
    });
    const staleTurnId = await waitFor(
      host,
      (message) => message.id === 3 && message.error !== undefined,
      'stale expected turn id',
    );
    expect(staleTurnId.error).toMatchObject({
      code: -32602,
      message: `expected active turn id \`stale-turn-id\` but found \`${turnId}\``,
    });

    await send(host, 4, 'turn/steer', { threadId: '', expectedTurnId: turnId, input: [] });
    const invalidSteerInput = await waitFor(
      host,
      (message) => message.id === 4 && message.error !== undefined,
      'invalid steer input',
    );
    expect(invalidSteerInput.error).toMatchObject({ code: -32602, message: 'input must contain at least one item' });
    expect(host.lines.some((message) => message.method === 'mica/queue/queued')).toBe(false);

    await send(host, 5, 'turn/interrupt', { threadId: '', turnId });
    const completed = await waitFor(host, turnCompleted(turnId), 'validation turn interrupted', 30_000);
    expect((completed.params?.turn as { status?: string }).status).toBe('interrupted');
  });

  itE2E('idle and stale interrupts are idempotent and do not poison the next turn', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.delayBeforeTextMs = 0;

    const host = spawnHost('stale-interrupt');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    // A stop request can race ahead of turn/started and carry ids from an old
    // host. It must remain a harmless, acknowledged no-op while this host is idle.
    await send(host, 1, 'turn/interrupt', { threadId: 'wrong-thread-id', turnId: 'wrong-turn-id' });
    const idleInterrupt = await waitFor(host, (message) => message.id === 1, 'idle interrupt response');
    expect(idleInterrupt.error).toBeUndefined();
    expect(idleInterrupt.result).toEqual({});
    expect(mock!.state.requests).toHaveLength(0);

    await send(host, 2, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '第一轮正常执行' }],
    });
    const started1 = await waitFor(host, (message) => message.method === 'turn/started', 'first turn started');
    const turn1 = (started1.params?.turn as { id?: string }).id!;
    const completed1 = await waitFor(host, turnCompleted(turn1), 'first turn completed', 30_000);
    expect((completed1.params?.turn as { status?: string }).status).toBe('completed');

    // Replaying stop for an already-completed turn is also acknowledged and
    // must not leave an abort signal armed for the following turn.
    await send(host, 3, 'turn/interrupt', { threadId: started1.params?.threadId ?? '', turnId: turn1 });
    const staleInterrupt = await waitFor(host, (message) => message.id === 3, 'stale interrupt response');
    expect(staleInterrupt.error).toBeUndefined();
    expect(staleInterrupt.result).toEqual({});

    mock!.state.delayBeforeTextMs = 5_000;
    await send(host, 4, 'turn/start', {
      threadId: (started1.params?.threadId as string) || '',
      input: [{ type: 'text', text: '第二轮仍应正常执行' }],
    });
    const started2 = await waitFor(
      host,
      (message) => message.method === 'turn/started' && (message.params?.turn as { id?: string })?.id !== turn1,
      'second turn started',
    );
    const turn2 = (started2.params?.turn as { id?: string }).id!;
    await send(host, 5, 'turn/interrupt', {
      threadId: started2.params?.threadId ?? '',
      turnId: turn1,
    });
    const activeStaleInterrupt = await waitFor(host, (message) => message.id === 5, 'active stale interrupt');
    expect(JSON.stringify(activeStaleInterrupt.error)).toContain('expected active turn id');
    const completed2 = await waitFor(host, turnCompleted(turn2), 'second turn completed', 30_000);
    expect((completed2.params?.turn as { status?: string }).status).toBe('completed');
    expect(mock!.state.requests).toHaveLength(2);
  });

  itE2E('slow MCP init does not block host ready; the first turn waits for it', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;

    const home = makeHomeWithSlowMcp('slow-mcp');
    const host = spawnHost('slow-mcp', [], home);
    hosts.push(host);

    const ready = await waitFor(host, hostReady, 'host ready or error', 30_000);
    const readyAt = ready.emittedAtMs ?? 0;

    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '你好' }],
      model: 'mock/mock-chat',
    });
    // The MCP server sleeps 3s before answering initialize. The host must have
    // become ready before that (background MCP init), and the turn/started
    // notification only fires after MCP is up -> started trails ready by ~3s.
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started');
    const startedAt = started.emittedAtMs ?? 0;
    expect(startedAt - readyAt).toBeGreaterThan(1500);

    const turnId = (started.params?.turn as { id?: string }).id!;
    const completed = await waitFor(host, turnCompleted(turnId), 'turn/completed');
    expect((completed.params?.turn as { status?: string }).status).toBe('completed');
  });

  itE2E('degraded MCP config warns instead of erroring and the host keeps serving', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;

    const home = makeHome('mcp-warning');
    // A missing --mcp-config makes micaMcp.init() reject. That is a degradation
    // (host serves without MCP tools), so it must be a `warning` notification:
    // a Codex `error` would make the desktop app end the run it is about to run.
    const host = spawnHost('mcp-warning', ['--mcp-config', join(home, 'missing-mcp.json')], home);
    hosts.push(host);

    const warning = await waitFor(host, (m) => m.method === 'warning', 'degradation warning', 30_000);
    expect(JSON.stringify(warning.params)).toContain('MCP init failed');
    expect(host.lines.some((m) => m.method === 'error')).toBe(false);

    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '降级后仍可对话' }],
      model: 'mock/mock-chat',
    });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started after degradation');
    const turnId = (started.params?.turn as { id?: string }).id!;
    const completed = await waitFor(host, turnCompleted(turnId), 'turn/completed after degradation', 30_000);
    expect((completed.params?.turn as { status?: string }).status).toBe('completed');
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
    const sessionFiles = readdirSync(join(host.home, 'sessions')).filter((file) => file.endsWith('.json'));
    expect(sessionFiles).toHaveLength(1);
    const session = JSON.parse(readFileSync(join(host.home, 'sessions', sessionFiles[0]!), 'utf8')) as unknown;
    expect(JSON.stringify(session)).toContain('你好');
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
    // The drained turn is a real turn for the client: it announces its own
    // turn/started (new id) and finishes with turn/completed, so the app can
    // abort it and knows when the host is idle again.
    const started2 = await waitFor(
      host,
      (m) => m.method === 'turn/started' && (m.params?.turn as { id?: string })?.id !== turn1,
      'drained turn/started (2)',
      30_000,
    );
    const turn2 = (started2.params?.turn as { id?: string }).id!;
    const completed2 = await waitFor(host, turnCompleted(turn2), 'turn/completed (2)', 30_000);
    expect((completed2.params?.turn as { status?: string }).status).toBe('completed');
    expect(mock!.state.requests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(mock!.state.requests[1]?.input ?? [])).toContain('第二句话（排队注入）');

    // A new explicit turn reuses the same resident host and session id (no
    // re-spawn). Retry turn/start in case the host is still winding down (it
    // rejects with "A turn is already active") instead of guessing a sleep —
    // timing-independent and stable under CI load.
    let started3: HostMessage | null = null;
    for (let attempt = 0; attempt < 50 && !started3; attempt++) {
      await send(host, 100 + attempt, 'turn/start', {
        threadId: host.lines.find((m) => m.method === 'turn/started')?.params?.threadId as string,
        input: [{ type: 'text', text: '第三句话' }],
      });
      const reply = await waitFor(
        host,
        (m) =>
          (m.method === 'turn/started' &&
            (m.params?.turn as { id?: string })?.id !== turn1 &&
            (m.params?.turn as { id?: string })?.id !== turn2) ||
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

    // A fresh host resumes the compacted snapshot through the standard Codex
    // thread/resume request (same MICA_HOME!) and keeps chatting; the new
    // provider request must contain the compact summary.
    const resumed = spawnHost('compact-resume-2', [], host.home);
    hosts.push(resumed);
    await waitFor(resumed, hostReady, 'resumed host ready or error', 30_000);
    await send(resumed, 1, 'thread/resume', { threadId: sessionId });
    const resumedThread = await waitFor(resumed, (m) => m.id === 1 && m.result !== undefined, 'thread/resume response');
    expect((resumedThread.result as { thread?: { id?: string } }).thread?.id).toBe(sessionId);
    mock!.state.requests = [];
    await send(resumed, 2, 'turn/start', {
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

  itE2E('mica/queue/recall pulls a queued steer back out of the host slot', async () => {
    mock!.state.mode = 'tool';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 1200;

    const host = spawnHost('queue-recall');
    hosts.push(host);
    mock!.state.toolFilePath = join(host.cwd, 'recall-notes.txt');
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '请创建文件' }],
      model: 'mock/mock-chat',
    });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started (recall)');
    const turn1 = (started.params?.turn as { id?: string }).id!;

    // Busy Enter/Tab/Shift+Tab: the steer waits in the host's single slot.
    await sleep(400);
    await send(host, 2, 'turn/steer', {
      threadId: '',
      expectedTurnId: turn1,
      input: [{ type: 'text', text: '撤回我：这句话不该被注入' }],
      clientMessageId: 'optimistic-recall',
    });
    await waitFor(host, (m) => m.method === 'mica/queue/queued', 'mica/queue/queued (recall)');

    // shift + ← in the app: recall over the Mica extension request.
    await send(host, 3, 'mica/queue/recall', { clientMessageId: 'optimistic-recall' });
    const recalled = await waitFor(host, (m) => m.id === 3, 'queue recall response', 10_000);
    expect(recalled.error).toBeFalsy();
    expect(recalled.result).toMatchObject({
      ok: true,
      input: { id: 'optimistic-recall', text: '撤回我：这句话不该被注入' },
      pending: [],
    });
    const changed = host.lines.filter((m) => m.method === 'mica/queue/changed').pop();
    expect((changed?.params as { pending?: unknown[] } | undefined)?.pending).toEqual([]);

    const completed = await waitFor(host, turnCompleted(turn1), 'turn/completed (recall)', 30_000);
    expect((completed.params?.turn as { status?: string }).status).toBe('completed');
    // The recalled text never reached the provider, in this turn or a follow-up.
    expect(JSON.stringify(mock!.state.requests.map((request) => request.input ?? []))).not.toContain(
      '撤回我：这句话不该被注入',
    );
    // Recalling fails once the slot is empty instead of silently succeeding.
    await send(host, 4, 'mica/queue/recall', { clientMessageId: 'optimistic-recall' });
    const missing = await waitFor(host, (m) => m.id === 4, 'queue recall (empty) response', 10_000);
    expect(missing.result).toMatchObject({ ok: false, input: null });
  });

  // 用户点「重新编辑」时先 hold 再 recall：hold 期间的迭代边界不能把用户正在改的
  // 文本注入进去。host 的 stdin 是顺序的，所以 hold 一定先于那两个边界生效。
  itE2E('mica/queue/hold freezes the queued steer until the recall takes it back', async () => {
    mock!.state.mode = 'tool';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 1200;

    const host = spawnHost('queue-hold');
    hosts.push(host);
    mock!.state.toolFilePath = join(host.cwd, 'hold-notes.txt');
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '请创建文件' }],
      model: 'mock/mock-chat',
    });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started (hold)');
    const turn1 = (started.params?.turn as { id?: string }).id!;

    await sleep(400);
    await send(host, 2, 'turn/steer', {
      threadId: '',
      expectedTurnId: turn1,
      input: [{ type: 'text', text: '冻结我：编辑期间不该被注入' }],
      clientMessageId: 'optimistic-hold',
    });
    await waitFor(host, (m) => m.method === 'mica/queue/queued', 'mica/queue/queued (hold)');

    await send(host, 3, 'mica/queue/hold', { clientMessageId: 'optimistic-hold', held: true });
    const held = await waitFor(host, (m) => m.id === 3, 'queue hold response', 10_000);
    expect(held.error).toBeFalsy();
    expect(held.result).toMatchObject({ ok: true, held: true });

    // 冻结之后再撤回（用户把文本拿回输入框）：中途没有 mica/queue/dequeue。
    await send(host, 4, 'mica/queue/recall', { clientMessageId: 'optimistic-hold' });
    const recalled = await waitFor(host, (m) => m.id === 4, 'queue recall (held) response', 10_000);
    expect(recalled.result).toMatchObject({
      ok: true,
      input: { id: 'optimistic-hold', text: '冻结我：编辑期间不该被注入' },
    });
    expect(host.lines.some((m) => m.method === 'mica/queue/dequeue')).toBe(false);

    const completed = await waitFor(host, turnCompleted(turn1), 'turn/completed (hold)', 30_000);
    expect((completed.params?.turn as { status?: string }).status).toBe('completed');
    expect(JSON.stringify(mock!.state.requests.map((request) => request.input ?? []))).not.toContain(
      '冻结我：编辑期间不该被注入',
    );
  });

  itE2E("auto compact plugin shrinks the running turn's next request", async () => {
    mock!.state.mode = 'tool';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;
    // 上下文占用超过快速压缩阈值（阈值的单位是 k，usage 的 input_tokens 是原始值）。
    mock!.state.inputTokens = 250_000;
    // 一次巨大的 write_file 正文：快速压缩把正文换成指向性摘要，同一 turn 的下一次
    // 请求立刻变小 —— 这正是「不等所有任务跑完」才有的收益。
    mock!.state.toolFileContent = 'y'.repeat(20_000);

    // 阈值归插件自己的设置管（配置页 Plugins 一节写的也是这个文件），所以在起进程
    // 之前就写好：插件的 setup 读一次设置。
    const home = makeHome('auto-compact-plugin');
    mkdirSync(join(home, 'plugin-settings'), { recursive: true });
    writeFileSync(
      join(home, 'plugin-settings', 'auto-compact.json'),
      JSON.stringify({
        enabled: 'true',
        quickThresholdK: '200',
        quickLimit: '1',
        modelThresholdK: '120',
        modelLimit: '0',
        minIntervalMinutes: '0',
      }),
    );

    const host = spawnHost('auto-compact-plugin', [], home);
    hosts.push(host);
    mock!.state.toolFilePath = join(host.cwd, 'auto-compact-notes.txt');
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '写一个很大的文件' }],
      model: 'mock/mock-chat',
    });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started (auto compact)');
    const turnId = (started.params?.turn as { id?: string }).id!;
    await waitFor(host, turnCompleted(turnId), 'turn/completed (auto compact)', 30_000);

    // 第二次请求带的就是压缩后的历史：2 万字符正文只剩摘要，工具结果换成占位符。
    const secondInput = mock!.state.requests[1]!.input as Array<{
      type?: string;
      arguments?: string;
      output?: unknown;
    }>;
    const call = secondInput.find((item) => item.type === 'function_call');
    expect(call?.arguments).toContain('[omitted 20000 chars]');
    expect(call?.arguments).not.toContain('yyyyyyyyyy');
    expect(secondInput.find((item) => item.type === 'function_call_output')?.output).toBe(
      '[Old tool result content cleared during compact]',
    );

    // 压缩后的历史随 turn 落盘（重开会话读到的就是压缩后的上下文）。
    const sessionFiles = readdirSync(join(host.home, 'sessions')).filter((file) => file.endsWith('.json'));
    expect(sessionFiles).toHaveLength(1);
    const session = JSON.parse(readFileSync(join(host.home, 'sessions', sessionFiles[0]!), 'utf8')) as {
      snapshot?: { messages?: unknown[] };
    };
    expect(JSON.stringify(session.snapshot?.messages ?? [])).toContain(
      '[Old tool result content cleared during compact]',
    );
  });

  itE2E('mica/input/activity compacts the stored history after the session sat idle', async () => {
    mock!.state.mode = 'tool';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;
    // 上下文占用远低于任何阈值：这一条压不压完全由「人回来了」决定。
    mock!.state.inputTokens = 10;
    mock!.state.toolFileContent = 'y'.repeat(20_000);

    const home = makeHome('input-activity');
    mkdirSync(join(home, 'plugin-settings'), { recursive: true });
    writeFileSync(
      join(home, 'plugin-settings', 'auto-compact.json'),
      JSON.stringify({
        enabled: 'true',
        // 阈值抬到用不到的高度：能压下来只能是空闲触发那条路。
        quickThresholdK: '10000',
        modelThresholdK: '10000',
        quickLimit: '999',
        modelLimit: '0',
        minIntervalMinutes: '0',
        // 0.02 分钟 = 1.2s：等得起，同时证明「要空闲够久」。
        idleMinutes: '0.02',
      }),
    );

    const host = spawnHost('input-activity', [], home);
    hosts.push(host);
    mock!.state.toolFilePath = join(host.cwd, 'idle-compact-notes.txt');
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '写一个很大的文件' }],
      model: 'mock/mock-chat',
    });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started (input activity)');
    const turnId = (started.params?.turn as { id?: string }).id!;
    await waitFor(host, turnCompleted(turnId), 'turn/completed (input activity)', 30_000);

    const sessionPath = () =>
      join(
        host.home,
        'sessions',
        readdirSync(join(host.home, 'sessions')).filter((file) => file.endsWith('.json'))[0]!,
      );
    // turn 结束时历史是完整的（阈值没到、也没有空闲触发）。
    expect(readFileSync(sessionPath(), 'utf8')).not.toContain('[Old tool result content cleared');
    const requestsBeforeActivity = mock!.state.requests.length;

    // 会话空闲够久之后用户回到输入框：宿主把这一下敲字翻成运行期事件，插件据此
    // 在轮次之外把已经落盘的历史压小——下一轮请求不必再为这段工具结果付费。
    await sleep(1_500);
    await send(host, 2, 'mica/input/activity', {});
    await waitFor(host, (m) => m.id === 2, 'mica/input/activity response');

    // 压缩不等回包（用户还在打字），轮询落盘结果。
    let persisted = '';
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      persisted = readFileSync(sessionPath(), 'utf8');
      if (persisted.includes('[Old tool result content cleared during compact]')) break;
      await sleep(100);
    }
    expect(persisted).toContain('[Old tool result content cleared during compact]');
    // 记账与压缩是同一次写：文件里必须已经有计数与那次 notice。分开写会出现
    // 「历史压了、pluginState 还是旧的」——用户关掉页面后就再也对不上账。
    expect(persisted).toContain('"quickRuns": 1');
    expect(persisted).toContain('已快速压缩历史');
    // 效果写成「压缩前 → 压缩后（省 N%）」：只报省下多少读不出量级。
    expect(persisted).toMatch(/已快速压缩历史：[\d.]+M?K? → [\d.]+M?K?（省 \d+%）/);
    // 输入框左下角的 ctx 徽标读 displayUsage：压缩后它必须降到压缩后的占用，
    // 否则界面还写着压缩前的数字，看着像没生效（lastUsage 保持不变是 Stats 的口径）。
    const idleSnapshot = JSON.parse(persisted).snapshot as {
      displayUsage?: { totalTokens?: number; compactedAt?: string };
    };
    expect(idleSnapshot.displayUsage?.totalTokens).toBeGreaterThan(0);
    expect(idleSnapshot.displayUsage?.compactedAt).toEqual(expect.any(String));
    // 轮次之外改掉的历史要通知客户端重载，否则页面一直显示压缩前的记录。
    await waitFor(host, (m) => m.method === 'mica/sessionHistory/replaced', 'history replaced notification', 10_000);
    // 压缩是同步的，它跑着的时候宿主连 stdin 都读不到：动手之前先告诉客户端
    // （`mica/host/maintenance`），客户端据此把这几秒里的发送排进队列、压完再补发。
    // 顺序必须是「开始 → 换历史 → 结束」，页面才能先换上新记录再发排队那条。
    const maintenance = host.lines.filter((m) => m.method === 'mica/host/maintenance');
    expect(maintenance.map((m) => m.params?.active)).toEqual([true, false]);
    expect(maintenance.every((m) => m.params?.reason === 'compaction')).toBe(true);
    const beganAt = host.lines.indexOf(maintenance[0]!);
    const endedAt = host.lines.indexOf(maintenance[1]!);
    const replacedAt = host.lines.findIndex((m) => m.method === 'mica/sessionHistory/replaced');
    expect(beganAt).toBeLessThan(replacedAt);
    expect(replacedAt).toBeLessThan(endedAt);
    // 请求数没变：这次压缩全在本地，没有偷偷发起一次模型请求。
    expect(mock!.state.requests).toHaveLength(requestsBeforeActivity);
    expect(host.lines.filter((m) => m.method === 'error')).toEqual([]);
  });

  itE2E('capabilities/set pins the session selection over the config defaults', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;
    type CapabilityGetResult = {
      selection?: { disabledTools?: string[] };
      mcpServers?: { name: string; status: string }[];
    };

    // 桌面端把受控浏览器 / 终端按会话挂进 --mcp-config，它们不在用户的 config.json 里。
    // 能力目录必须照样列出来，否则界面上看不到也关不掉这些内置 server。
    const home = makeHome('capabilities-pin');
    const mcpConfigPath = join(home, 'session-mcp.json');
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: { 'builtin-demo': { type: 'http', url: 'http://127.0.0.1:1/mcp/demo' } },
      }),
      'utf-8',
    );

    const host = spawnHost('capabilities-pin', ['--mcp-config', mcpConfigPath], home);
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    // 一条会话先跑起来，拿到 session id（草稿会话的 set 只留在内存里）。
    await send(host, 1, 'turn/start', { threadId: '', input: [{ type: 'text', text: '你好' }] });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started (capabilities)');
    await waitFor(host, turnCompleted((started.params?.turn as { id?: string }).id!), 'turn/completed (capabilities)');

    // 没定制过的会话跟随 config 默认值（这个 home 里没有 capabilityDefaults）。
    await send(host, 2, 'mica/capabilities/get', {});
    const initial = await waitFor(host, (m) => m.id === 2, 'capabilities/get (initial)');
    const initialSelection = (initial.result as CapabilityGetResult).selection;
    expect(initialSelection?.disabledTools).toEqual([]);
    expect((initial.result as CapabilityGetResult).mcpServers?.map((server) => server.name)).toContain('builtin-demo');

    // 用户在会话里改过之后就固定用这份选择，再 get 拿到的还是它。
    await send(host, 3, 'mica/capabilities/set', {
      selection: { version: 1, disabledSkills: [], disabledTools: ['run_shell'], disabledMcpServers: [] },
    });
    const saved = await waitFor(host, (m) => m.id === 3, 'capabilities/set');
    expect(saved.result).toMatchObject({ ok: true, selection: { disabledTools: ['run_shell'] } });

    await send(host, 4, 'mica/capabilities/get', {});
    const after = await waitFor(host, (m) => m.id === 4, 'capabilities/get (after set)');
    const afterSelection = (after.result as CapabilityGetResult).selection;
    expect(afterSelection?.disabledTools).toEqual(['run_shell']);

    // 标志跟着快照落盘，resume 时才知道这条会话要不要跟随默认值。
    const sessionFiles = readdirSync(join(host.home, 'sessions')).filter((file) => file.endsWith('.json'));
    const persisted = JSON.parse(readFileSync(join(host.home, 'sessions', sessionFiles[0]!), 'utf8')) as {
      snapshot?: { capabilitiesCustomized?: unknown; capabilitySelection?: { disabledTools?: string[] } };
    };
    expect(persisted.snapshot?.capabilitiesCustomized).toBe(true);
    expect(persisted.snapshot?.capabilitySelection?.disabledTools).toEqual(['run_shell']);
  });

  itE2E('session notes round-trip through the protocol, the session file and the next prompt', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;

    const host = spawnHost('session-notes');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    // 工具必须在这个进程里注册好，否则模型根本看不到有什么可写。
    await send(host, 99, 'mica/capabilities/get', {});
    const capabilities = await waitFor(host, (m) => m.id === 99, 'capabilities/get (notes)');
    expect((capabilities.result as { tools?: { name: string }[] }).tools?.map((tool) => tool.name)).toContain(
      'session_notes',
    );

    // 草稿会话（还没有 session id）就能读写：面板不必等第一条消息才可用。
    await send(host, 1, 'mica/notes/get', {});
    const empty = await waitFor(host, (m) => m.id === 1, 'notes/get (empty)');
    expect(empty.result).toMatchObject({ content: '' });

    await send(host, 2, 'mica/notes/set', { content: '# 决策\n\n- 用 Bun 跑测试  \n\n' });
    const saved = await waitFor(host, (m) => m.id === 2, 'notes/set');
    // 归一化：行尾空白和末尾空行不落盘，否则每次打开都像「被改过」。
    expect(saved.result).toMatchObject({ content: '# 决策\n\n- 用 Bun 跑测试' });
    await waitFor(host, (m) => m.method === 'mica/notes/updated', 'notes/updated');

    // 下一轮请求的 system prompt 末尾必须带上它 —— 这是「压缩不掉」的落点。
    await send(host, 3, 'turn/start', { threadId: '', input: [{ type: 'text', text: '开始干活' }] });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'notes turn started', 30_000);
    await waitFor(host, turnCompleted((started.params?.turn as { id?: string }).id!), 'notes turn completed', 30_000);
    const instructions = mock!.state.requests[0]?.instructions ?? '';
    expect(instructions).toContain('<session-notes>');
    expect(instructions).toContain('- 用 Bun 跑测试');
    expect(instructions.trimEnd().endsWith('</session-notes>')).toBe(true);

    // 落在会话快照里、不在 messages 里：所以 compact 改不到它。
    const sessionFile = readdirSync(join(host.home, 'sessions')).filter((f) => f.endsWith('.json'))[0]!;
    const sessionId = sessionFile.replace(/\.json$/, '');
    const persisted = JSON.parse(readFileSync(join(host.home, 'sessions', sessionFile), 'utf8')) as {
      snapshot?: { pluginState?: Record<string, unknown>; messages?: unknown[] };
    };
    expect(persisted.snapshot?.pluginState?.['session-notes']).toBe('# 决策\n\n- 用 Bun 跑测试');
    expect(JSON.stringify(persisted.snapshot?.messages ?? [])).not.toContain('<session-notes>');

    // 换一个宿主重开同一会话：笔记跟着回来（resume 走的是快照，不是配置文件）。
    // 同一个 MICA_HOME 起第二个宿主：验证的是「从会话文件恢复」，不是换了个家目录
    const reopened = spawnHost('session-notes-reopen', [], host.home);
    hosts.push(reopened);
    await waitFor(reopened, hostReady, 'reopened host ready or error', 30_000);
    await send(reopened, 1, 'thread/resume', { threadId: sessionId });
    const resumed = await waitFor(reopened, (m) => m.id === 1, 'thread/resume (notes)');
    expect(resumed.error, JSON.stringify(resumed.error)).toBeUndefined();
    await send(reopened, 2, 'mica/notes/get', {});
    const restored = await waitFor(reopened, (m) => m.id === 2, 'notes/get (reopened)');
    expect(restored.result).toMatchObject({ content: '# 决策\n\n- 用 Bun 跑测试' });
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

  itE2E('turn/start is refused while another process holds the session turn lease', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;
    mock!.state.longText = '';

    const home = makeHome('remote-lease');
    const host = spawnHost('remote-lease', [], home);
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    // First turn creates the session and must release the lease when it ends.
    await send(host, 1, 'turn/start', { threadId: '', input: [{ type: 'text', text: '先建一个会话' }] });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started (first)');
    const sessionId = (started.params?.threadId as string) || '';
    expect(sessionId).toBeTruthy();
    const turn1 = (started.params?.turn as { id?: string }).id!;
    await waitFor(host, turnCompleted(turn1), 'turn/completed (first)', 30_000);

    const lockDir = join(home, 'sessions', '.turn-locks');
    const lockPath = join(lockDir, `${sessionId}.lock`);
    expect(existsSync(lockPath)).toBe(false);
    expect(mock!.state.requests.length).toBe(1);

    // A browser tab driven by the other runtime instance (or a TUI terminal)
    // starts a turn on the same session: its turn lease is alive, so this host
    // must refuse instead of writing the same session file concurrently.
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, token: 'another-process', createdAt: new Date().toISOString() }),
      'utf8',
    );

    await send(host, 2, 'turn/start', {
      threadId: sessionId,
      input: [{ type: 'text', text: '别处正在跑时发的这条' }],
    });
    const rejected = await waitFor(host, (m) => m.id === 2, 'turn/start reject response', 10_000);
    expect(rejected.error).toBeTruthy();
    expect(JSON.stringify(rejected.error)).toContain('另一个窗口或终端');
    // No turn started and the prompt never reached the provider.
    expect(host.lines.filter((m) => m.method === 'turn/started').length).toBe(1);
    expect(mock!.state.requests.length).toBe(1);

    // Once the other process releases the lease the same host works again.
    rmSync(lockPath, { force: true });
    await send(host, 3, 'turn/start', {
      threadId: sessionId,
      input: [{ type: 'text', text: '锁释放后的这条' }],
    });
    const started2 = await waitFor(
      host,
      (m) => m.method === 'turn/started' && (m.params?.turn as { id?: string })?.id !== turn1,
      'turn/started (after release)',
      30_000,
    );
    const completed2 = await waitFor(
      host,
      turnCompleted((started2.params?.turn as { id?: string }).id!),
      'turn/completed (after release)',
      30_000,
    );
    expect((completed2.params?.turn as { status?: string }).status).toBe('completed');
    expect(mock!.state.requests.length).toBe(2);
  });

  itE2E('abort keeps the queued input pending instead of starting it', async () => {
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
      input: [{ type: 'text', text: '排队的话（abort 后不该发出去）' }],
      clientMessageId: 'queued-after-abort',
    });
    await waitFor(host, (m) => m.method === 'mica/queue/queued', 'mica/queue/queued (abort)');

    // turn/started precedes provider IO. Interrupting before the first request
    // arrives makes the queued input request #1, invalidating the count assertion.
    const requestDeadline = Date.now() + 10_000;
    while (mock!.state.requests.length === 0 && Date.now() < requestDeadline) await sleep(10);
    expect(mock!.state.requests.length).toBeGreaterThanOrEqual(1);

    // User hits stop: only the active turn is interrupted.
    await send(host, 3, 'turn/interrupt', { threadId: '', turnId: turn1 });
    const completed1 = await waitFor(host, turnCompleted(turn1), 'turn/completed (interrupted)', 30_000);
    expect((completed1.params?.turn as { status?: string }).status).toBe('interrupted');

    // 中止的一轮不会把排队输入变成下一轮：否则用户点完停止会看到「先停、再把排队
    // 的话发出去、再马上停一次」。它留在单槽里，状态仍是 pending（可撤回）。
    const pendingChanged = await waitFor(
      host,
      (m) =>
        m.method === 'mica/queue/changed' &&
        JSON.stringify(m.params?.pending ?? []).includes('排队的话（abort 后不该发出去）'),
      'queued input stays pending after abort',
      30_000,
    );
    expect(pendingChanged.params?.pending).toHaveLength(1);
    // 留出「偷偷起一轮」的窗口，然后确认宿主没有再发第二次 provider 请求、也没有
    // 第二个 turn/started。
    await sleep(1500);
    expect(mock!.state.requests).toHaveLength(1);
    expect(host.lines.filter((m) => m.method === 'turn/started')).toHaveLength(1);

    // 撤回（桌面 Shift+←）照旧可用，原文回到客户端。
    await send(host, 4, 'mica/queue/recall', { clientMessageId: 'queued-after-abort' });
    const recalled = await waitFor(host, (m) => m.id === 4, 'queue recall after abort', 10_000);
    expect(recalled.result).toMatchObject({
      ok: true,
      input: { id: 'queued-after-abort', text: '排队的话（abort 后不该发出去）' },
      pending: [],
    });
  });

  // 桌面端点停止是「撤回排队 + 中断」一次动作：撤回不带 clientMessageId（页面可能还没
  // 收到确认，不知道那条的 id），取回原文后排队槽必须真的是空的，否则中断完它还会被当成
  // 下一轮发出去。
  itE2E('recall before interrupt leaves the queue empty and sends nothing', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 3000;

    const host = spawnHost('stop-recall');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '第一句话（慢慢说）' }],
      model: 'mock/mock-chat',
    });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started (stop recall)');
    const turn1 = (started.params?.turn as { id?: string }).id!;
    await send(host, 2, 'turn/steer', {
      threadId: '',
      expectedTurnId: turn1,
      input: [{ type: 'text', text: '排队的话（应该回到输入框）' }],
      clientMessageId: 'queued-before-stop',
    });
    await waitFor(host, (m) => m.method === 'mica/queue/queued', 'mica/queue/queued (stop recall)');

    // 停止按钮做的事：先不带 id 撤回（取槽里那一条），再中断。
    await send(host, 3, 'mica/queue/recall', {});
    const recalled = await waitFor(host, (m) => m.id === 3, 'queue recall (stop)', 10_000);
    expect(recalled.error).toBeFalsy();
    expect(recalled.result).toMatchObject({
      ok: true,
      input: { id: 'queued-before-stop', text: '排队的话（应该回到输入框）' },
      pending: [],
    });

    await send(host, 4, 'turn/interrupt', { threadId: '', turnId: turn1 });
    const completed = await waitFor(host, turnCompleted(turn1), 'turn/completed (stop recall)', 30_000);
    expect((completed.params?.turn as { status?: string }).status).toBe('interrupted');

    // 撤回之后再中止：没有第二轮、排队的话也从没进过 provider。
    await sleep(1000);
    expect(mock!.state.requests).toHaveLength(1);
    expect(host.lines.filter((m) => m.method === 'turn/started')).toHaveLength(1);
    expect(JSON.stringify(mock!.state.requests.map((request) => request.input ?? []))).not.toContain(
      '排队的话（应该回到输入框）',
    );
  });

  itE2E('two hosts racing on one session keep persisting both turns (no silent skip)', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;
    mock!.state.longText = '';

    const home = makeHome('race');
    const hostA = spawnHost('race-a', [], home);
    hosts.push(hostA);
    await waitFor(hostA, hostReady, 'host A ready or error', 30_000);
    const latestStartedId = (host: Host) => {
      const startedAll = host.lines.filter((m) => m.method === 'turn/started');
      return (startedAll[startedAll.length - 1]?.params?.turn as { id?: string } | undefined)?.id ?? '';
    };
    const waitForNewStarted = async (host: Host, label: string) => {
      const before = host.lines.filter((m) => m.method === 'turn/started').length;
      await waitFor(host, () => host.lines.filter((x) => x.method === 'turn/started').length > before, label, 30_000);
    };

    await send(hostA, 1, 'turn/start', { threadId: '', input: [{ type: 'text', text: 'A-1 第一条' }] });
    await waitForNewStarted(hostA, 'A turn 1 started');
    await waitFor(hostA, turnCompleted(latestStartedId(hostA)), 'A turn 1 completed', 30_000);

    const sessionFile = readdirSync(join(home, 'sessions')).find((file) => file.endsWith('.json'));
    expect(sessionFile).toBeTruthy();
    const sessionId = sessionFile!.replace(/\.json$/, '');
    const sessionPath = join(home, 'sessions', sessionFile!);

    const hostB = spawnHost('race-b', ['--session', sessionId], home);
    hosts.push(hostB);
    await waitFor(hostB, hostReady, 'host B ready or error', 30_000);
    await sleep(200);

    await send(hostA, 2, 'turn/start', {
      threadId: sessionId,
      input: [{ type: 'text', text: 'A-2 第二条' }],
    });
    await waitForNewStarted(hostA, 'A turn 2 started');
    await waitFor(hostA, turnCompleted(latestStartedId(hostA)), 'A turn 2 completed', 30_000);

    // Host B runs a turn with a stale persisted signature: it must still save.
    await send(hostB, 3, 'turn/start', {
      threadId: sessionId,
      input: [{ type: 'text', text: 'B-1 第三条（B 的 turn）' }],
    });
    await waitForNewStarted(hostB, 'B turn started');
    await waitFor(hostB, turnCompleted(latestStartedId(hostB)), 'B turn completed', 30_000);
    await sleep(150);

    const disk = JSON.parse(readFileSync(sessionPath, 'utf-8')) as {
      turnState?: string;
      snapshot?: { messages?: unknown[] };
    };
    expect(JSON.stringify(disk)).toContain('B-1 第三条（B 的 turn）');
    expect(disk.turnState).toBe('completed');
    const userTexts = (disk.snapshot?.messages ?? [])
      .filter((m) => (m as { type?: string }).type === 'message' && (m as { role?: string }).role === 'user')
      .map((m) => JSON.stringify(m));
    expect(JSON.stringify(userTexts)).toContain('A-1 第一条');
    expect(JSON.stringify(userTexts)).toContain('A-2 第二条');
    expect(JSON.stringify(userTexts)).toContain('B-1 第三条（B 的 turn）');

    // Host A keeps persisting afterwards too.
    await send(hostA, 4, 'turn/start', {
      threadId: sessionId,
      input: [{ type: 'text', text: 'A-3 第五条' }],
    });
    await waitForNewStarted(hostA, 'A turn 3 started');
    await waitFor(hostA, turnCompleted(latestStartedId(hostA)), 'A turn 3 completed', 30_000);
    await sleep(150);
    const disk2 = JSON.parse(readFileSync(sessionPath, 'utf-8')) as { snapshot?: { messages?: unknown[] } };
    expect(JSON.stringify(disk2)).toContain('A-3 第五条');
  });

  itE2E('--role override without a session is returned by thread/start and used for the turn', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;

    const home = makeHome('role-override');
    mkdirSync(join(home, 'role'), { recursive: true });
    writeFileSync(join(home, 'role', 'reviewer.md'), 'Always review the change before answering.');
    const host = spawnHost('role-override', ['--role', 'reviewer'], home);
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'thread/start', { threadId: '' });
    const started = await waitFor(host, (m) => m.id === 1 && m.result !== undefined, 'thread/start response');
    expect((started.result as { role?: string }).role).toBe('reviewer');

    await send(host, 2, 'turn/start', {
      threadId: (started.result as { thread?: { id?: string } }).thread?.id ?? '',
      input: [{ type: 'text', text: '请检查这个改动' }],
    });
    const turnStarted = await waitFor(host, (m) => m.method === 'turn/started', 'role turn started');
    const turnId = (turnStarted.params?.turn as { id?: string }).id!;
    await waitFor(host, turnCompleted(turnId), 'role turn completed', 30_000);
    expect(mock!.state.requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(mock!.state.requests[0]?.input ?? [])).toContain('请检查这个改动');
  });

  itE2E('turn/start switches the role on the resident host and persists it for the session', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;

    const home = makeHome('role-switch-turn');
    mkdirSync(join(home, 'role'), { recursive: true });
    writeFileSync(join(home, 'role', 'reviewer.md'), 'Always review the change before answering.');
    writeFileSync(join(home, 'role', 'writer.md'), 'Answer as a short poem about the request.');
    // 常驻 host 只 spawn 一次，所以 --role 在进程生命周期内不会再变；桌面端在会话
    // 中途换的角色只能靠 turn/start 的 role 参数（Mica 扩展）落到 agent 上。
    const host = spawnHost('role-switch-turn', [], home);
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'thread/start', { threadId: '' });
    const started = await waitFor(host, (m) => m.id === 1 && m.result !== undefined, 'thread/start response');
    const sessionId = (started.result as { thread?: { id?: string } }).thread?.id ?? '';
    expect((started.result as { role?: string }).role).toBe('default');

    await send(host, 2, 'turn/start', {
      threadId: sessionId,
      input: [{ type: 'text', text: '换个角色' }],
      role: 'reviewer',
    });
    const started1 = await waitFor(host, (m) => m.method === 'turn/started', 'role-switch turn 1 started', 30_000);
    await waitFor(
      host,
      turnCompleted((started1.params?.turn as { id?: string }).id!),
      'role-switch turn 1 completed',
      30_000,
    );
    // 角色提示词真的进了这次请求，而不只是渲染层显示成 reviewer。
    expect(mock!.state.requests[0]?.instructions ?? '').toContain('Always review the change');
    // 落盘：下次打开这个 session，role 就是 reviewer（桌面端据此显示在会话框里）。
    const sessionPath = join(home, 'sessions', `${sessionId}.json`);
    const afterFirst = JSON.parse(readFileSync(sessionPath, 'utf-8')) as {
      snapshot?: { role?: string };
    };
    expect(afterFirst.snapshot?.role).toBe('reviewer');

    // 同一个常驻 host 上再换一次同样生效（不是只在首轮碰巧走通）。
    await send(host, 3, 'turn/start', {
      threadId: sessionId,
      input: [{ type: 'text', text: '再换一个角色' }],
      role: 'writer',
    });
    const started2 = await waitFor(
      host,
      (m) =>
        m.method === 'turn/started' &&
        (m.params?.turn as { id?: string })?.id !== (started1.params?.turn as { id?: string })?.id,
      'role-switch turn 2 started',
      30_000,
    );
    await waitFor(
      host,
      turnCompleted((started2.params?.turn as { id?: string }).id!),
      'role-switch turn 2 completed',
      30_000,
    );
    expect(mock!.state.requests[1]?.instructions ?? '').toContain('Answer as a short poem');
    const afterSecond = JSON.parse(readFileSync(sessionPath, 'utf-8')) as {
      snapshot?: { role?: string };
    };
    expect(afterSecond.snapshot?.role).toBe('writer');
  });

  itE2E('--max-turns stops tool iteration after the configured limit', async () => {
    mock!.state.mode = 'tool';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;

    const host = spawnHost('max-turns', ['--max-turns', '1']);
    hosts.push(host);
    mock!.state.toolFilePath = join(host.cwd, 'should-not-finish.txt');
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '请调用工具完成任务' }],
    });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'max-turns started');
    const turnId = (started.params?.turn as { id?: string }).id!;
    const completed = await waitFor(host, turnCompleted(turnId), 'max-turns completed', 30_000);
    const turn = completed.params?.turn as { status?: string; error?: { message?: string } | null };

    expect(mock!.state.requests).toHaveLength(1);
    expect(turn.status).toBe('failed');
    expect(turn.error?.message).toContain('maximum of 1 turns');
  });

  itE2E('--model + --variant overrides survive --session resume', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;

    // Phase 1: create a session with the default model (mock/mock-chat).
    const home = makeHome('model-resume');
    const hostA = spawnHost('model-resume-a', [], home);
    hosts.push(hostA);
    await waitFor(hostA, hostReady, 'host A ready or error', 30_000);

    await send(hostA, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '初始化会话' }],
    });
    const startedA = await waitFor(hostA, (m) => m.method === 'turn/started', 'A turn started');
    const turnIdA = (startedA.params?.turn as { id?: string }).id!;
    await waitFor(hostA, turnCompleted(turnIdA), 'A turn completed', 30_000);

    const sessionFile = readdirSync(join(home, 'sessions')).find((file) => file.endsWith('.json'));
    expect(sessionFile).toBeTruthy();
    const sessionId = sessionFile!.replace(/\.json$/, '');

    // Phase 2: resume the session with --model override to a different model.
    // The mock provider records the model name from each request, so we can
    // verify the override reached the provider (not the session's old model).
    mock!.state.requests = [];
    const hostB = spawnHost(
      'model-resume-b',
      ['--session', sessionId, '--model', 'mock/mock-chat-override', '--variant', 'high'],
      home,
    );
    hosts.push(hostB);
    await waitFor(hostB, hostReady, 'host B ready or error', 30_000);

    // turn/start WITHOUT a model param: the --model override should survive.
    await send(hostB, 1, 'turn/start', {
      threadId: sessionId,
      input: [{ type: 'text', text: '续聊' }],
    });
    const startedB = await waitFor(hostB, (m) => m.method === 'turn/started', 'B turn started');
    const turnIdB = (startedB.params?.turn as { id?: string }).id!;
    await waitFor(hostB, turnCompleted(turnIdB), 'B turn completed', 30_000);

    // Both overrides must win over the session snapshot's original model and
    // effort.
    expect(mock!.state.requests.length).toBeGreaterThan(0);
    expect(mock!.state.requests[0].model).toBe('mock-chat-override');
    expect(mock!.state.requests[0].reasoning?.effort).toBe('high');
  });

  itE2E('--variant (effort) override survives --session resume', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;

    // Phase 1: create a session with low effort.
    const home = makeHome('variant-resume');
    const hostA = spawnHost('variant-resume-a', [], home);
    hosts.push(hostA);
    await waitFor(hostA, hostReady, 'host A ready or error', 30_000);

    await send(hostA, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '初始化会话' }],
      effort: 'low',
    });
    const startedA = await waitFor(hostA, (m) => m.method === 'turn/started', 'A turn started');
    const turnIdA = (startedA.params?.turn as { id?: string }).id!;
    await waitFor(hostA, turnCompleted(turnIdA), 'A turn completed', 30_000);

    const sessionFile = readdirSync(join(home, 'sessions')).find((file) => file.endsWith('.json'));
    expect(sessionFile).toBeTruthy();
    const sessionId = sessionFile!.replace(/\.json$/, '');

    // Phase 2: resume with --variant high. The session snapshot has effort=low,
    // but the CLI override must win.
    mock!.state.requests = [];
    const hostB = spawnHost('variant-resume-b', ['--session', sessionId, '--variant', 'high'], home);
    hosts.push(hostB);
    await waitFor(hostB, hostReady, 'host B ready or error', 30_000);

    await send(hostB, 1, 'turn/start', {
      threadId: sessionId,
      input: [{ type: 'text', text: '续聊' }],
    });
    const startedB = await waitFor(hostB, (m) => m.method === 'turn/started', 'B turn started');
    const turnIdB = (startedB.params?.turn as { id?: string }).id!;
    await waitFor(hostB, turnCompleted(turnIdB), 'B turn completed', 30_000);

    expect(mock!.state.requests.length).toBeGreaterThan(0);
    expect(mock!.state.requests[0].reasoning?.effort).toBe('high');
  });

  itE2E('--model + --variant overrides survive thread/resume (Codex protocol path)', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;

    // Phase 1: create a session with the default model.
    const home = makeHome('model-thread-resume');
    const hostA = spawnHost('model-thread-resume-a', ['--model', 'mock/mock-chat-override'], home);
    hosts.push(hostA);
    await waitFor(hostA, hostReady, 'host A ready or error', 30_000);

    // First turn uses the --model override (no model param in turn/start).
    await send(hostA, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '初始化会话' }],
    });
    const startedA = await waitFor(hostA, (m) => m.method === 'turn/started', 'A turn started');
    const turnIdA = (startedA.params?.turn as { id?: string }).id!;
    await waitFor(hostA, turnCompleted(turnIdA), 'A turn completed', 30_000);

    // Verify the override reached the provider on the first turn.
    expect(mock!.state.requests[0].model).toBe('mock-chat-override');

    const sessionFile = readdirSync(join(home, 'sessions')).find((file) => file.endsWith('.json'));
    expect(sessionFile).toBeTruthy();
    const sessionId = sessionFile!.replace(/\.json$/, '');

    // Phase 2: a NEW host with the same --model override sends thread/resume
    // (Codex protocol path), then turn/start without a model param.
    mock!.state.requests = [];
    const hostB = spawnHost('model-thread-resume-b', ['--model', 'mock/mock-chat-override', '--variant', 'high'], home);
    hosts.push(hostB);
    await waitFor(hostB, hostReady, 'host B ready or error', 30_000);

    await send(hostB, 1, 'thread/resume', { threadId: sessionId });
    await waitFor(hostB, (m) => m.id === 1 && m.result !== undefined, 'thread/resume response');

    await send(hostB, 2, 'turn/start', {
      threadId: sessionId,
      input: [{ type: 'text', text: '续聊' }],
    });
    const startedB = await waitFor(hostB, (m) => m.method === 'turn/started', 'B turn started');
    const turnIdB = (startedB.params?.turn as { id?: string }).id!;
    await waitFor(hostB, turnCompleted(turnIdB), 'B turn completed', 30_000);

    // Both CLI overrides must survive thread/resume.
    expect(mock!.state.requests.length).toBeGreaterThan(0);
    expect(mock!.state.requests[0].model).toBe('mock-chat-override');
    expect(mock!.state.requests[0].reasoning?.effort).toBe('high');
  });

  itE2E('mica/backgroundTasks/{output,kill} read and stop a real background shell task', async () => {
    mock!.state.mode = 'shell';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;

    const host = spawnHost('background-tasks');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'turn/start', { threadId: '', input: [{ type: 'text', text: '起一个后台任务' }] });
    await waitFor(host, (m) => m.method === 'turn/started', 'turn/started');

    // The snapshot only carries tasks that are still starting/running, so its
    // arrival is also the proof that the tool really spawned one.
    const snapshotWithTask = await waitFor(
      host,
      (m) =>
        m.method === 'mica/backgroundTasks/updated' &&
        Array.isArray(m.params?.tasks) &&
        (m.params.tasks as unknown[]).length > 0,
      'background task snapshot',
    );
    const task = (snapshotWithTask.params!.tasks as Array<{ id: string; status: string; command: string }>)[0]!;
    expect(task.status === 'running' || task.status === 'starting').toBe(true);
    expect(task.command).toContain('tick-1');

    // Output: the host reads the task's own output file and reports the window
    // it returned, so the desktop can show what it is not seeing. The file already
    // holds mica's task header when the snapshot is pushed, so poll until the child
    // writes its own line: a loaded runner can serve the request before that.
    let output: { ok: boolean; content: string; size: number; task: { status: string } | null } | undefined;
    const deadline = Date.now() + 15_000;
    for (let attempt = 0; ; attempt += 1) {
      // Fresh ids per attempt: waitFor replays earlier matching lines.
      const requestId = 200 + attempt;
      await send(host, requestId, 'mica/backgroundTasks/output', { taskId: task.id, tailBytes: 4096 });
      const outputResponse = await waitFor(
        host,
        (m) => m.id === requestId && m.result !== undefined,
        'output response',
      );
      output = outputResponse.result as typeof output;
      if (output?.content.includes('tick-1') || Date.now() > deadline) break;
      await sleep(100);
    }
    if (!output) throw new Error('no background task output response');
    if (!output.content.includes('tick-1')) {
      // Name what the host actually returned: a missing file (size 0) and a file
      // that only holds mica's header are different failures.
      throw new Error(
        `background task output is missing tick-1 (size=${output.size}, status=${
          output.task?.status
        }, content=${JSON.stringify(output.content.slice(0, 160))})`,
      );
    }
    expect(output.ok).toBe(true);
    expect(output.content).toContain('tick-1');
    expect(output.size).toBeGreaterThan(0);
    expect(output.task?.status === 'running' || output.task?.status === 'starting').toBe(true);

    // Unknown ids degrade with a result instead of an error notification.
    await send(host, 3, 'mica/backgroundTasks/output', { taskId: 'ffffffffffff' });
    const unknown = await waitFor(host, (m) => m.id === 3 && m.result !== undefined, 'unknown task response');
    expect(unknown.result).toMatchObject({ ok: false, content: '', task: null });

    // Kill: the same request the desktop's ✕ button sends.
    await send(host, 4, 'mica/backgroundTasks/kill', { taskId: task.id });
    const killResponse = await waitFor(host, (m) => m.id === 4 && m.result !== undefined, 'kill response');
    expect(killResponse.result).toMatchObject({ ok: true });

    // The host pushes an immediate snapshot, and a stopped task is no longer in it.
    await waitFor(
      host,
      (m) => m.method === 'mica/backgroundTasks/updated' && (m.params?.tasks as unknown[]).length === 0,
      'empty task snapshot after kill',
    );

    // A finished task is gone from the snapshot, so the output request has to
    // carry its final status (otherwise the modal would keep showing "running").
    await send(host, 5, 'mica/backgroundTasks/output', { taskId: task.id });
    const afterKill = await waitFor(host, (m) => m.id === 5 && m.result !== undefined, 'post-kill output');
    expect((afterKill.result as { task: { status: string } }).task.status).toBe('killed');
  });

  itE2E('mica/waitTasks/updated publishes blocked waits and releases them on interrupt', async () => {
    mock!.state.mode = 'wait';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;
    mock!.state.waitArguments = { kind: 'duration', seconds: 20, poll_interval_ms: 500 };

    const host = spawnHost('wait-tasks');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'turn/start', { threadId: '', input: [{ type: 'text', text: '等 20 秒' }] });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started');
    const turnId = (started.params?.turn as { id?: string }).id!;

    // The wait record is created before the tool blocks, so the snapshot that
    // carries it also proves the tool was really entered with our arguments.
    const blocked = await waitFor(
      host,
      (m) =>
        m.method === 'mica/waitTasks/updated' &&
        Array.isArray(m.params?.tasks) &&
        (m.params.tasks as unknown[]).length > 0,
      'wait task snapshot',
    );
    const wait = (blocked.params!.tasks as Array<{ id: string; kind: string; status: string; label: string }>)[0]!;
    expect(wait.kind).toBe('duration');
    expect(wait.status).toBe('waiting');
    expect(wait.label).toContain('20');
    expect(wait.id).toMatch(/^[0-9a-f]{8}$/);

    // Interrupting has to end the turn promptly: the tool has to observe the
    // abort signal instead of blocking until its own timeout.
    await send(host, 2, 'turn/interrupt', { threadId: '', turnId });
    const completed = await waitFor(host, turnCompleted(turnId), 'interrupted turn completed', 30_000);
    expect((completed.params?.turn as { status?: string }).status).toBe('interrupted');

    // A wait nobody is blocked on is not published any more.
    await waitFor(
      host,
      (m) => m.method === 'mica/waitTasks/updated' && (m.params?.tasks as unknown[]).length === 0,
      'empty wait snapshot after interrupt',
    );
  });

  itE2E('mica/subagentTasks/{detail,kill} answer for unknown ids without breaking the host', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;

    const host = spawnHost('subagent-detail');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    await send(host, 1, 'mica/subagentTasks/detail', { taskId: 'agent-task-missing' });
    const detail = await waitFor(host, (m) => m.id === 1 && m.result !== undefined, 'detail response');
    expect(detail.result).toMatchObject({ ok: false });

    await send(host, 2, 'mica/subagentTasks/kill', { taskId: 'agent-task-missing' });
    const killed = await waitFor(host, (m) => m.id === 2 && m.result !== undefined, 'kill response');
    expect(killed.result).toMatchObject({ ok: false });

    // Missing params are a protocol error (-32602), not a silently empty result.
    await send(host, 3, 'mica/subagentTasks/detail', {});
    const invalid = await waitFor(host, (m) => m.id === 3 && m.error !== undefined, 'invalid params error');
    expect((invalid.error as { code: number }).code).toBe(-32602);

    // The resident host is still usable after all of the above.
    await send(host, 4, 'turn/start', { threadId: '', input: [{ type: 'text', text: '还在吗' }] });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started');
    const turnId = (started.params?.turn as { id: string }).id;
    await waitFor(host, turnCompleted(turnId), 'turn/completed');
  });

  itE2E('a client variant the model does not declare degrades the turn instead of killing the host', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;

    // 端点不接受任何推理档位：provider 没有 effortLevels，模型名 models.dev 也不认识。
    // 桌面端会把上次选的档位一起带上来（`--variant high`），host 必须照常起服务：
    // 之前的实现直接 exit(1)，用户看到一条永远发不出去、也编辑不了的消息。
    const home = makeHomeWithoutEffortLevels('no-effort-levels');
    const host = spawnHost('no-effort-levels', ['--variant', 'high'], home);
    hosts.push(host);
    const ready = await waitFor(host, hostReady, 'host ready or error', 30_000);
    expect(ready.method).not.toBe('error');

    await send(host, 1, 'turn/start', {
      threadId: '',
      input: [{ type: 'text', text: '你好' }],
    });
    const started = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started');
    const turnId = (started.params?.turn as { id?: string }).id!;
    const completed = await waitFor(host, turnCompleted(turnId), 'turn/completed');
    expect((completed.params?.turn as { status?: string }).status).toBe('completed');

    // 档位没有声明 → 请求里不带任何推理参数，也不发一个端点未必接受的猜测值。
    expect(mock!.state.requests.length).toBeGreaterThan(0);
    expect(mock!.state.requests[0].reasoning).toBeUndefined();

    // 降级要可见：warning 通知而不是 error（host 还在服务）。
    const warning = host.lines.find((m) => m.method === 'warning');
    expect((warning?.params?.warning as { message?: string })?.message).toContain('high');
  });

  itE2E('switching model + effort across turns of one resident host sends each level to its own model', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.delayBeforeTextMs = 0;

    const host = spawnHost('switch-model-effort');
    hosts.push(host);
    await waitFor(host, hostReady, 'host ready or error', 30_000);

    const runTurn = async (id: number, text: string, overrides: Record<string, unknown>) => {
      await send(host, id, 'turn/start', { threadId: '', input: [{ type: 'text', text }], ...overrides });
      // 用「自己这条请求的应答」定位本轮的 turn id：常驻 host 里 turn/started 会重复
      // 出现，按方法名找会拿到上一轮的。
      const response = await waitFor(
        host,
        (m) => m.id === id && (m.result !== undefined || m.error !== undefined),
        `turn/start #${id} response`,
      );
      expect(response.error).toBeUndefined();
      const turnId = (response.result as { turn?: { id?: string } }).turn?.id!;
      expect(turnId).toBeTruthy();
      const completed = await waitFor(host, turnCompleted(turnId), 'turn/completed');
      expect((completed.params?.turn as { status?: string }).status).toBe('completed');
    };

    await runTurn(1, '第一轮：low', { model: 'mock/mock-chat', effort: 'low' });
    await runTurn(2, '第二轮：换模型 high', { model: 'mock/mock-chat-alt', effort: 'high' });
    // 第三轮：模型不认识的档位（`xhigh` 不在 mock provider 声明的三档里）按目标模型收敛。
    await runTurn(3, '第三轮：无效档位', { model: 'mock/mock-chat-alt', effort: 'xhigh' });
    await runTurn(4, '第四轮：换回第一个模型', { model: 'mock/mock-chat', effort: 'low' });

    const [first, second, third, fourth] = mock!.state.requests;
    expect(first.model).toBe('mock-chat');
    expect(first.reasoning?.effort).toBe('low');
    expect(second.model).toBe('mock-chat-alt');
    expect(second.reasoning?.effort).toBe('high');
    expect(third.model).toBe('mock-chat-alt');
    expect(third.reasoning?.effort).toBe('medium');
    expect(fourth.model).toBe('mock-chat');
    expect(fourth.reasoning?.effort).toBe('low');

    // 收敛要告诉用户，否则界面说 xhigh、请求里发的是 medium。
    const adjustment = host.lines.find(
      (m) =>
        m.method === 'warning' && String((m.params?.warning as { message?: string })?.message || '').includes('xhigh'),
    );
    expect(adjustment).toBeTruthy();

    // 会话快照记录的是最后一轮生效的模型，resume 或桌面刷新都读它。
    const sessionFile = readdirSync(join(host.home, 'sessions')).find((file) => file.endsWith('.json'));
    expect(sessionFile).toBeTruthy();
    const saved = JSON.parse(readFileSync(join(host.home, 'sessions', sessionFile!), 'utf8'));
    expect(saved.snapshot.model).toBe('mock-chat');
  });
});
