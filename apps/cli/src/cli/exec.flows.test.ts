import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * End-to-end `mica exec` flow suite. Drives a real `mica exec --json` child
 * process (one-shot headless execution, no resident host) with a local mock
 * OpenAI-compatible Responses provider so no real API key is needed.
 *
 * Covers:
 *   - --model override reaches the provider
 *   - --model override survives --session resume
 *   - --variant (effort) override reaches the provider
 *   - --no-save does not create a session file
 *   - --json output contains expected Codex exec event types
 *   - --thinking flag includes reasoning events in the output
 *
 * Runs on every `bun run test` (CI includes bun). MICA_BIN overrides the bun
 * invocation, e.g. point it at a built `dist/mica` binary.
 */
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TEST_DIR, '..', '..', '..', '..');
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const bunAvailable = process.env.MICA_BIN || spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
const suite = bunAvailable ? describe : describe.skip;

/** Open a `node:http` server pretending to be an OpenAI-compatible responses
 * provider. Programmable per test: normal SSE stream, 400/stream error, tool
 * calls, or optionally include reasoning events before the text events. */
function createMockProvider() {
  const state = {
    mode: 'ok' as 'ok' | 'error' | 'stream-error' | 'tool' | 'session-tool',
    errorMessage: '',
    requests: [] as Array<{
      model: string;
      input: unknown[];
      instructions?: string;
      reasoning?: { effort?: string };
      tools?: unknown[];
    }>,
    responsesFinished: 0,
    /** When true, emit reasoning SSE events before the text events. */
    includeReasoning: false,
    /** `tool` mode emits write_file once, then a normal response. */
    toolFilePath: '',
    toolFileContent: 'hello from exec tool mock',
    delayBeforeTextMs: 0,
  };
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/v1/responses')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk.toString()));
      req.on('end', () => {
        let parsed: {
          model?: string;
          input?: unknown[];
          instructions?: string;
          reasoning?: { effort?: string };
          tools?: unknown[];
        } = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          // keep defaults
        }
        const { model = '', input = [], instructions, reasoning, tools } = parsed;
        state.requests.push({ model, input, instructions, reasoning, tools });
        if (state.mode === 'error') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: state.errorMessage || 'mock provider error' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const text = '你好，我是 mock 模型的回复';
        const emit = (event: Record<string, unknown>) => res.write(`data: ${JSON.stringify(event)}\n\n`);
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
        const finishText = () => {
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
          res.end();
          state.responsesFinished += 1;
        };
        if (state.mode === 'stream-error') {
          emit({ type: 'response.created', response: { id: 'resp_failed', object: 'response' } });
          emit({
            type: 'response.output_text.delta',
            item_id: 'msg_failed',
            output_index: 0,
            content_index: 0,
            delta: 'partial output',
          });
          emit({
            type: 'response.failed',
            response: {
              id: 'resp_failed',
              object: 'response',
              status: 'failed',
              error: { code: 'mock_stream_error', message: state.errorMessage || 'mock stream failed' },
            },
          });
          res.end();
          return;
        }
        if (state.mode === 'tool' && state.requests.length === 1) {
          const callId = 'call_exec_1';
          const argumentsText = JSON.stringify({ file_path: state.toolFilePath, content: state.toolFileContent });
          emit({ type: 'response.created', response: { id: 'resp_tool', object: 'response' } });
          emit({ type: 'response.in_progress', response: { id: 'resp_tool', object: 'response' } });
          emit({
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'fc_exec_1',
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
            item_id: 'fc_exec_1',
            delta: argumentsText,
          });
          emit({
            type: 'response.function_call_arguments.done',
            output_index: 0,
            item_id: 'fc_exec_1',
            arguments: argumentsText,
          });
          emit({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'fc_exec_1',
              type: 'function_call',
              status: 'completed',
              call_id: callId,
              name: 'write_file',
              arguments: argumentsText,
            },
          });
          emitCompleted();
          res.end();
          state.responsesFinished += 1;
          return;
        }
        if (state.mode === 'session-tool' && state.requests.length === 1) {
          // Ask the model to call session_info: proves the headless plugin host
          // registered the session-autonomy tools for exec/app-server runs.
          const callId = 'call_session_1';
          const argumentsText = '{}';
          emit({ type: 'response.created', response: { id: 'resp_session', object: 'response' } });
          emit({ type: 'response.in_progress', response: { id: 'resp_session', object: 'response' } });
          emit({
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              id: 'fc_session_1',
              type: 'function_call',
              status: 'in_progress',
              call_id: callId,
              name: 'session_info',
              arguments: '',
            },
          });
          emit({
            type: 'response.function_call_arguments.done',
            output_index: 0,
            item_id: 'fc_session_1',
            arguments: argumentsText,
          });
          emit({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'fc_session_1',
              type: 'function_call',
              status: 'completed',
              call_id: callId,
              name: 'session_info',
              arguments: argumentsText,
            },
          });
          emitCompleted();
          res.end();
          state.responsesFinished += 1;
          return;
        }
        if (state.delayBeforeTextMs > 0) {
          setTimeout(finishText, state.delayBeforeTextMs);
        } else {
          finishText();
        }
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

function makeHome(tag: string): string {
  const home = join(tmpdir(), `mica-exec-flow-${process.pid}-${tag}`);
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

/** Run a one-shot `mica exec <args>` CLI and collect stdout/stderr. */
function runCli(
  args: string[],
  env: Record<string, string>,
  timeoutMs = 60_000,
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

/** Parse stdout as JSONL (one JSON object per line), skipping blank/invalid lines. */
function parseJsonl(stdout: string): Record<string, unknown>[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((line): line is Record<string, unknown> => line !== null);
}

/** E2E tests spawn a real child process; the 5s vitest default is too short. */
function itE2E(name: string, fn: () => Promise<void>): void {
  it(name, fn, 60_000);
}

suite('mica exec real-user flows (mock provider)', () => {
  afterEach(() => {
    // Reset mock state between tests.
    mock!.state.mode = 'ok';
    mock!.state.errorMessage = '';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    mock!.state.includeReasoning = false;
    mock!.state.toolFilePath = '';
    mock!.state.toolFileContent = 'hello from exec tool mock';
    mock!.state.delayBeforeTextMs = 0;
  });

  itE2E('--model override changes the model sent to provider', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    const home = makeHome('exec-model-override');

    const result = await runCli(['exec', '--json', '--model', 'mock/mock-chat-override', '你好'], {
      MICA_HOME: home,
      MICA_NO_DAEMON: '1',
    });

    expect(result.code).toBe(0);
    expect(mock!.state.requests.length).toBeGreaterThan(0);
    expect(mock!.state.requests[0].model).toBe('mock-chat-override');

    const events = parseJsonl(result.stdout);
    expect(events.some((e) => e.type === 'turn.completed')).toBe(true);
  });

  itE2E('provider errors are surfaced as JSON errors and persist an error turn', async () => {
    mock!.state.mode = 'error';
    mock!.state.errorMessage = 'mock provider rejected the request';
    mock!.state.requests = [];
    const home = makeHome('exec-provider-error');

    const result = await runCli(['exec', '--json', '你好'], { MICA_HOME: home, MICA_NO_DAEMON: '1' });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('mock provider rejected the request');
    const events = parseJsonl(result.stdout);
    expect(events.some((event) => event.type === 'error' && String(event.message).includes('mock provider'))).toBe(
      true,
    );
    expect(events.some((event) => event.type === 'turn.completed')).toBe(false);
    const sessionFiles = readdirSync(join(home, 'sessions')).filter((file) => file.endsWith('.json'));
    expect(sessionFiles).toHaveLength(1);
    const session = JSON.parse(readFileSync(join(home, 'sessions', sessionFiles[0]!), 'utf8')) as {
      turnState?: string;
    };
    expect(session.turnState).toBe('error');
  });

  itE2E('provider stream failures preserve partial output and return a JSON error', async () => {
    mock!.state.mode = 'stream-error';
    mock!.state.errorMessage = 'mock provider stream failed after partial output';
    mock!.state.requests = [];
    const home = makeHome('exec-stream-error');

    const result = await runCli(['exec', '--json', '流式请求失败'], { MICA_HOME: home, MICA_NO_DAEMON: '1' });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('mock_stream_error: mock provider stream failed after partial output');
    const events = parseJsonl(result.stdout);
    expect(
      events.some((event) => event.type === 'item.updated' && JSON.stringify(event).includes('partial output')),
    ).toBe(true);
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.some((event) => event.type === 'turn.completed')).toBe(false);
  });

  itE2E('provider errors preserve a repeated prompt as a new failed turn on resume', async () => {
    const home = makeHome('exec-repeated-error');
    const prompt = '重复提示需要保留两次';
    mock!.state.mode = 'ok';
    const first = await runCli(['exec', '--json', prompt], { MICA_HOME: home, MICA_NO_DAEMON: '1' });
    expect(first.code).toBe(0);
    const sessionFiles = readdirSync(join(home, 'sessions')).filter((file) => file.endsWith('.json'));
    expect(sessionFiles).toHaveLength(1);
    const sessionId = sessionFiles[0]!.replace(/\.json$/, '');

    mock!.state.mode = 'error';
    mock!.state.errorMessage = 'repeated prompt provider failure';
    const second = await runCli(['exec', '--json', '--session', sessionId, prompt], {
      MICA_HOME: home,
      MICA_NO_DAEMON: '1',
    });
    expect(second.code).toBe(1);
    const persisted = JSON.parse(readFileSync(join(home, 'sessions', sessionFiles[0]!), 'utf8')) as unknown;
    const occurrences = JSON.stringify(persisted).split(prompt).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  itE2E('SIGINT aborts an in-flight exec turn, exits 130, and persists an aborted session', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.delayBeforeTextMs = 10_000;
    const home = makeHome('exec-sigint');

    const child = spawn(
      process.env.MICA_BIN ?? 'bun',
      [...(process.env.MICA_BIN ? [] : ['apps/cli/src/index.ts']), 'exec', '--json', '等待期间中断'],
      {
        cwd: ROOT,
        env: { ...process.env, MICA_HOME: home, MICA_NO_DAEMON: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk) => (stderr += chunk.toString()));

    const requestDeadline = Date.now() + 15_000;
    while (mock!.state.requests.length === 0 && Date.now() < requestDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(mock!.state.requests).toHaveLength(1);
    child.kill('SIGINT');

    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(-1);
      }, 15_000);
      child.once('close', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });

    expect(code).toBe(130);
    expect(stderr).not.toContain('SIGKILL');
    const events = parseJsonl(stdout);
    expect(events.some((event) => event.type === 'error' && event.message === 'Turn interrupted by user')).toBe(true);
    const sessionFiles = readdirSync(join(home, 'sessions')).filter((file) => file.endsWith('.json'));
    expect(sessionFiles).toHaveLength(1);
    const session = JSON.parse(readFileSync(join(home, 'sessions', sessionFiles[0]!), 'utf8')) as {
      turnState?: string;
    };
    expect(session.turnState).toBe('aborted');
  });

  itE2E('missing exec sessions fail before contacting the provider', async () => {
    mock!.state.requests = [];
    const home = makeHome('exec-missing-session');

    const result = await runCli(['exec', '--json', '--session', 'missing-session-id', '继续之前的对话'], {
      MICA_HOME: home,
      MICA_NO_DAEMON: '1',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('missing-session-id');
    expect(parseJsonl(result.stdout)).toContainEqual({
      type: 'error',
      message: 'Session not found: missing-session-id',
    });
    expect(mock!.state.requests).toHaveLength(0);
    expect(readdirSync(join(home, 'sessions')).filter((file) => file.endsWith('.json'))).toHaveLength(0);
  });

  itE2E('--no-save suppresses error-session persistence as well as successful persistence', async () => {
    mock!.state.mode = 'error';
    mock!.state.errorMessage = 'mock provider failure in no-save mode';
    mock!.state.requests = [];
    const home = makeHome('exec-no-save-error');

    const result = await runCli(['exec', '--json', '--no-save', '触发 provider 错误'], {
      MICA_HOME: home,
      MICA_NO_DAEMON: '1',
    });

    expect(result.code).toBe(1);
    expect(parseJsonl(result.stdout).some((event) => String(event.message).includes('no-save mode'))).toBe(true);
    expect(readdirSync(join(home, 'sessions')).filter((file) => file.endsWith('.json'))).toHaveLength(0);
  });

  itE2E('--model override survives --session resume', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    const home = makeHome('exec-model-resume');

    // Phase 1: create a session with the default model (mock/mock-chat).
    const phase1 = await runCli(['exec', '--json', '初始化会话'], { MICA_HOME: home, MICA_NO_DAEMON: '1' });
    expect(phase1.code).toBe(0);

    // Extract sessionId from the turn.completed event's JSONL output.
    const phase1Events = parseJsonl(phase1.stdout);
    const completedEvent = phase1Events.find((e) => e.type === 'turn.completed');
    expect(completedEvent).toBeTruthy();

    // The session file is the newest .json in sessions/.
    const sessionFiles = readdirSync(join(home, 'sessions')).filter((f) => f.endsWith('.json'));
    expect(sessionFiles.length).toBeGreaterThan(0);
    const sessionId = sessionFiles[0].replace(/\.json$/, '');

    // Phase 2: resume the session with --model override.
    mock!.state.requests = [];
    const phase2 = await runCli(
      ['exec', '--json', '--session', sessionId, '--model', 'mock/mock-chat-override', '续聊'],
      { MICA_HOME: home, MICA_NO_DAEMON: '1' },
    );

    expect(phase2.code).toBe(0);
    expect(mock!.state.requests.length).toBeGreaterThan(0);
    expect(mock!.state.requests[0].model).toBe('mock-chat-override');
  });

  itE2E('--variant (effort) override reaches provider', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    const home = makeHome('exec-variant');

    const result = await runCli(['exec', '--json', '--variant', 'high', '你好'], {
      MICA_HOME: home,
      MICA_NO_DAEMON: '1',
    });

    expect(result.code).toBe(0);
    expect(mock!.state.requests.length).toBeGreaterThan(0);
    expect(mock!.state.requests[0].reasoning?.effort).toBe('high');
  });

  itE2E('exec runs a tool round trip in the requested --dir', async () => {
    mock!.state.mode = 'tool';
    mock!.state.requests = [];
    const home = makeHome('exec-tool-dir');
    const cwd = join(home, 'work');
    mkdirSync(cwd, { recursive: true });
    mock!.state.toolFilePath = 'exec-tool-output.txt';

    const result = await runCli(['exec', '--json', '--dir', cwd, '请调用 write_file 工具'], {
      MICA_HOME: home,
      MICA_NO_DAEMON: '1',
    });

    expect(result.code).toBe(0);
    expect(mock!.state.requests).toHaveLength(2);
    expect(JSON.stringify(mock!.state.requests[1]?.input ?? [])).toContain('function_call_output');
    expect(existsSync(join(cwd, mock!.state.toolFilePath))).toBe(true);
    expect(readFileSync(join(cwd, mock!.state.toolFilePath), 'utf8')).toBe(mock!.state.toolFileContent);
    const events = parseJsonl(result.stdout);
    expect(events.some((event) => event.type === 'item.started')).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === 'item.completed' &&
          (event.item as { type?: string } | undefined)?.type === 'command_execution',
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === 'turn.completed')).toBe(true);
  });

  itE2E('--max-turns stops exec after the first tool request', async () => {
    mock!.state.mode = 'tool';
    mock!.state.requests = [];
    const home = makeHome('exec-max-turns');
    const cwd = join(home, 'work');
    mkdirSync(cwd, { recursive: true });
    mock!.state.toolFilePath = 'exec-max-turns-output.txt';

    const result = await runCli(['exec', '--json', '--dir', cwd, '--max-turns', '1', '执行一次工具'], {
      MICA_HOME: home,
      MICA_NO_DAEMON: '1',
    });

    expect(result.code).toBe(1);
    expect(mock!.state.requests).toHaveLength(1);
    // The first tool call is executed; the limit prevents the follow-up model request.
    expect(existsSync(join(cwd, mock!.state.toolFilePath))).toBe(true);
    expect(parseJsonl(result.stdout).some((event) => String(event.message).includes('maximum of 1 turns'))).toBe(true);
  });

  itE2E('headless exec exposes the session-autonomy tools (session_info round trip)', async () => {
    mock!.state.mode = 'session-tool';
    mock!.state.requests = [];
    mock!.state.responsesFinished = 0;
    const home = makeHome('exec-session-tool');

    const result = await runCli(['exec', '--json', '查看会话信息'], { MICA_HOME: home, MICA_NO_DAEMON: '1' });

    expect(result.code).toBe(0);
    // The first request carries the session_info tool definition (the headless
    // plugin host registered session-autonomy for exec, not just the TUI).
    expect(JSON.stringify(mock!.state.requests[0]?.tools ?? [])).toContain('session_info');
    // The model called session_info and the host executed it: the second
    // request carries the tool result with real session metadata.
    expect(mock!.state.requests).toHaveLength(2);
    const secondRequest = JSON.stringify(mock!.state.requests[1]?.input ?? []);
    expect(secondRequest).toContain('function_call_output');
    expect(secondRequest).toContain('会话 id');
    expect(parseJsonl(result.stdout).some((event) => event.type === 'turn.completed')).toBe(true);
  });

  itE2E('--role loads a custom role into the headless exec system prompt', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    const home = makeHome('exec-role');
    mkdirSync(join(home, 'role'), { recursive: true });
    writeFileSync(join(home, 'role', 'reviewer.md'), 'EXEC_ROLE_MARKER: review every answer.');

    const result = await runCli(['exec', '--json', '--role', 'reviewer', '请审查这个任务'], {
      MICA_HOME: home,
      MICA_NO_DAEMON: '1',
    });

    expect(result.code).toBe(0);
    expect(mock!.state.requests[0]?.instructions).toContain('EXEC_ROLE_MARKER: review every answer.');
    const sessionFiles = readdirSync(join(home, 'sessions')).filter((file) => file.endsWith('.json'));
    expect(sessionFiles).toHaveLength(1);
    const session = JSON.parse(readFileSync(join(home, 'sessions', sessionFiles[0]!), 'utf8')) as {
      snapshot?: { role?: string };
    };
    expect(session.snapshot?.role).toBe('reviewer');
  });

  itE2E('exec converts a local [Image](...) reference into an input_image request', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    const home = makeHome('exec-image');
    const cwd = join(home, 'work');
    mkdirSync(cwd, { recursive: true });
    const imagePath = join(cwd, 'input.png');
    writeFileSync(imagePath, Buffer.from(ONE_PIXEL_PNG, 'base64'));

    const result = await runCli(['exec', '--json', `请描述这张图 [Image](${imagePath})`], {
      MICA_HOME: home,
      MICA_NO_DAEMON: '1',
    });

    expect(result.code).toBe(0);
    const requestInput = JSON.stringify(mock!.state.requests[0]?.input ?? []);
    expect(requestInput).toContain('input_image');
    expect(requestInput).toContain('data:image/png;base64,');
    expect(requestInput).toContain(imagePath);
  });

  itE2E('--no-save does not create a session file', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    const home = makeHome('exec-no-save');

    const result = await runCli(['exec', '--json', '--no-save', '你好'], { MICA_HOME: home, MICA_NO_DAEMON: '1' });

    expect(result.code).toBe(0);

    const sessionFiles = readdirSync(join(home, 'sessions')).filter((f) => f.endsWith('.json'));
    expect(sessionFiles.length).toBe(0);
  });

  itE2E('--json output format contains expected event types', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    const home = makeHome('exec-json-format');

    const result = await runCli(['exec', '--json', '你好'], { MICA_HOME: home, MICA_NO_DAEMON: '1' });

    expect(result.code).toBe(0);

    const events = parseJsonl(result.stdout);
    expect(events.some((e) => e.type === 'turn.completed')).toBe(true);
    expect(
      events.some(
        (e) => e.type === 'item.completed' && (e.item as { type?: string } | undefined)?.type === 'agent_message',
      ),
    ).toBe(true);
  });

  itE2E('--thinking flag includes reasoning events', async () => {
    mock!.state.mode = 'ok';
    mock!.state.requests = [];
    mock!.state.includeReasoning = true;
    const home = makeHome('exec-thinking');

    const result = await runCli(['exec', '--json', '--thinking', '你好'], { MICA_HOME: home, MICA_NO_DAEMON: '1' });

    expect(result.code).toBe(0);

    const events = parseJsonl(result.stdout);
    // The CodexExecProjector emits reasoning as `item.updated` with item.type 'reasoning'.
    expect(
      events.some((e) => e.type === 'item.updated' && (e.item as { type?: string } | undefined)?.type === 'reasoning'),
    ).toBe(true);
  });
});
