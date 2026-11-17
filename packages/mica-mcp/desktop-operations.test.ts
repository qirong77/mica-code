import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { flushLogs, setLogLevel, snapshot, slowReport } from '@packages/mica-diagnostics/index.js';
import {
  createPluginLauncherRuntime,
  withPluginLauncherRequest,
} from '../../apps/desktop/src/host/plugin-launcher-runtime.js';
import { createPluginMcpHandler, createPluginMcpServer } from '../../apps/desktop/src/host/plugin-mcp.js';
import type { PluginMcpHandler } from '@packages/mica-plugin/PluginMcp.js';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
let home: string;
let previousLogDir: string | undefined;
let priorOperations: Set<unknown>;
const privateText = 'PRIVATE_BODY /private/project/file https://private.invalid/?secret=COOKIE_SECRET';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mica-plugin-operations-'));
  previousLogDir = process.env.MICA_LOG_DIR;
  process.env.MICA_LOG_DIR = join(home, 'logs');
  setLogLevel('info');
  priorOperations = new Set(snapshot(1000).map((entry) => entry.operationId));
});

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  flushLogs();
  if (previousLogDir === undefined) delete process.env.MICA_LOG_DIR;
  else process.env.MICA_LOG_DIR = previousLogDir;
  rmSync(home, { recursive: true, force: true });
});

function events(operation?: string) {
  return snapshot(1000).filter(
    (entry) =>
      entry.scope === 'plugin-operation' &&
      !priorOperations.has(entry.operationId) &&
      (!operation || entry.operation === operation),
  );
}

function assertEnvelope(operation: string, outcome: string, code: string) {
  const entries = events(operation);
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({ event: 'operation.start', plugin: 'sample', operation });
  expect(entries[1]).toMatchObject({
    event: 'operation.finish',
    plugin: 'sample',
    operation,
    outcome,
    code,
    ms: expect.any(Number),
  });
  expect(entries[1]!.operationId).toBe(entries[0]!.operationId);
  expect(JSON.stringify(entries)).not.toMatch(
    /PRIVATE_BODY|PRIVATE_ACTION|private\/project|private\.invalid|COOKIE_SECRET/,
  );
  expect(entries.every((entry) => !('runId' in entry) && !('input' in entry) && !('stack' in entry))).toBe(true);
  return entries[1]!;
}

function launcher(request: (...args: any[]) => unknown, factory?: () => unknown) {
  const runtime = createPluginLauncherRuntime({
    home,
    readDisabled: () => new Set(),
    manifests: [{ id: 'sample', settings: [], desktopLauncher: { title: 'Sample' } }],
    loaders: new Map([['sample', async () => ({ default: factory ?? (() => ({ request })) })]]),
  });
  cleanups.push(() => runtime.close());
  return runtime;
}

function pluginHandler(execute: (...args: any[]) => unknown): PluginMcpHandler {
  return {
    tools: [
      {
        name: 'lookup',
        description: 'test',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
        execute,
      },
    ],
  };
}

async function memoryMcp(handler: PluginMcpHandler, signal?: AbortSignal) {
  const server = createPluginMcpServer({ pluginId: 'sample', handler, signal });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'operation-test', version: '1.0.0' });
  await client.connect(clientTransport);
  cleanups.push(
    () => server.close(),
    () => client.close(),
  );
  return client;
}

async function httpMcp(handler: PluginMcpHandler, load = async () => handler) {
  const handle = createPluginMcpHandler({ runtime: { load, manifestOf: () => ({ version: '1.0.0' }) } });
  const server = createServer((req, res) => {
    void handle('sample', req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/plugin/sample/mcp`;
}

describe('standalone launcher operation diagnostics and cancellation', () => {
  it('counts returned failure once, logging only stable metadata', async () => {
    const result = { ok: false, error: privateText };
    const runtime = launcher(() => result);
    const before = slowReport(100).find((entry) => entry.key === 'plugin-operation:operation.finish');

    expect(await runtime.request('sample', 'PRIVATE_ACTION', { text: privateText })).toBe(result);

    assertEnvelope('launcher.request', 'error', 'returned_error');
    const after = slowReport(100).find((entry) => entry.key === 'plugin-operation:operation.finish')!;
    expect(after.count - (before?.count ?? 0)).toBe(1);
    expect(after.fails - (before?.fails ?? 0)).toBe(1);
  });

  it('preserves thrown exceptions without copying messages or stacks into diagnostics', async () => {
    const error = new Error(privateText);
    const runtime = launcher(() => {
      throw error;
    });

    await expect(runtime.request('sample', 'lookup', { text: privateText })).rejects.toBe(error);

    assertEnvelope('launcher.request', 'error', 'exception');
  });

  it('does not impose a 30s timeout on a long launcher task', async () => {
    vi.useFakeTimers();
    const runtime = launcher(() => new Promise((resolve) => setTimeout(() => resolve('done'), 150_000)));
    const pending = runtime.request('sample', 'lookup');
    await vi.advanceTimersByTimeAsync(31_000);
    expect(events('launcher.request').filter((entry) => entry.event === 'operation.finish')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(119_000);

    expect(await pending).toBe('done');
    expect(assertEnvelope('launcher.request', 'success', 'ok').ms).toBe(150_000);
  });

  it('inherits the HTTP caller signal without putting it in input and settles an uncooperative task', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const input = { text: privateText };
    const runtime = launcher((_action, value, context) => {
      expect(value).toBe(input);
      seenSignal = context.signal;
      started();
      return new Promise(() => undefined);
    });
    const pending = withPluginLauncherRequest({ signal: controller.signal }, () =>
      runtime.request('sample', 'lookup', input),
    );
    const rejected = expect(pending).rejects.toThrow();
    await ready;
    const reason = new DOMException(privateText, 'TimeoutError');
    controller.abort(reason);

    await rejected;
    await expect(pending).rejects.toBe(reason);
    expect(seenSignal).toBe(controller.signal);
    assertEnvelope('launcher.request', 'timeout', 'timeout');
  });

  it('does not execute a request that is already aborted', async () => {
    const controller = new AbortController();
    const request = vi.fn();
    const runtime = launcher(request);
    controller.abort(new DOMException(privateText, 'AbortError'));

    await expect(runtime.request('sample', 'lookup', {}, { signal: controller.signal })).rejects.toBe(
      controller.signal.reason,
    );

    expect(request).not.toHaveBeenCalled();
    assertEnvelope('launcher.request', 'cancelled', 'aborted');
  });

  it('keeps a shared lazy backend when one of its callers aborts', async () => {
    const controller = new AbortController();
    let finishLoading!: (handler: { request: () => string }) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const factory = vi.fn(() => {
      started();
      return new Promise((resolve) => {
        finishLoading = resolve;
      });
    });
    const runtime = launcher(() => 'unused', factory);
    const cancelled = runtime.request('sample', 'lookup', {}, { signal: controller.signal });
    const rejected = expect(cancelled).rejects.toThrow();
    await ready;
    controller.abort();
    await rejected;
    const active = runtime.request('sample', 'lookup');

    finishLoading({ request: () => 'done' });

    expect(await active).toBe('done');
    expect(await runtime.request('sample', 'lookup')).toBe('done');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('evicts a backend that fails to load after its original caller has aborted', async () => {
    const controller = new AbortController();
    let failLoading!: (error: Error) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const factory = vi
      .fn()
      .mockImplementationOnce(() => {
        started();
        return new Promise((_resolve, reject) => {
          failLoading = reject;
        });
      })
      .mockReturnValue({ request: () => 'retry succeeded' });
    const runtime = launcher(() => 'unused', factory);
    const pending = runtime.request('sample', 'lookup', {}, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await ready;
    controller.abort();
    await rejected;
    failLoading(new Error(privateText));
    await Promise.resolve();
    await Promise.resolve();

    expect(await runtime.request('sample', 'lookup')).toBe('retry succeeded');
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe('standalone plugin MCP operation diagnostics and cancellation', () => {
  it.each([
    { ok: false, error: privateText },
    { isError: true, content: [{ type: 'text', text: privateText }] },
  ])('propagates a structured error as MCP isError instead of reporting success', async (value) => {
    const client = await memoryMcp(pluginHandler(() => value));

    const result = await client.callTool({ name: 'lookup', arguments: { text: privateText } });

    expect(result.isError).toBe(true);
    if ('isError' in value) expect(result.content).toEqual(value.content);
    assertEnvelope('mcp.tools.call', 'error', 'mcp_error');
  });

  it('records list and successful calls without logging input or output', async () => {
    const client = await memoryMcp(pluginHandler(() => privateText));

    expect((await client.listTools()).tools[0]!.name).toBe('lookup');
    const result = await client.callTool({ name: 'lookup', arguments: { text: privateText } });

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'text', text: privateText }]);
    assertEnvelope('mcp.tools.list', 'success', 'ok');
    assertEnvelope('mcp.tools.call', 'success', 'ok');
  });

  it('records schema rejection as a terminal failure without invoking the plugin', async () => {
    const execute = vi.fn();
    const client = await memoryMcp(pluginHandler(execute));

    const result = await client.callTool({ name: 'lookup', arguments: { text: 123, extra: privateText } });

    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    assertEnvelope('mcp.tools.call', 'error', 'mcp_error');
  });

  it('records execution exceptions without logging the exception text', async () => {
    const client = await memoryMcp(
      pluginHandler(() => {
        throw new Error(privateText);
      }),
    );

    expect((await client.callTool({ name: 'lookup' })).isError).toBe(true);

    assertEnvelope('mcp.tools.call', 'error', 'exception');
  });

  it('honors the SDK request abort signal even if the tool ignores it', async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client = await memoryMcp(
      pluginHandler((_input, context) => {
        seenSignal = context.signal;
        started();
        return new Promise(() => undefined);
      }),
    );
    const pending = client.callTool({ name: 'lookup' }, undefined, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await ready;
    controller.abort();

    await rejected;
    await vi.waitFor(() => expect(events('mcp.tools.call')).toHaveLength(2));
    expect(seenSignal?.aborted).toBe(true);
    assertEnvelope('mcp.tools.call', 'cancelled', 'aborted');
  });

  it('allows a caller budget above 30s instead of installing a shorter server timer', async () => {
    vi.useFakeTimers();
    const client = await memoryMcp(
      pluginHandler(() => new Promise((resolve) => setTimeout(() => resolve('done'), 40_000))),
    );
    const pending = client.callTool({ name: 'lookup' }, undefined, { timeout: 120_000 });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(events('mcp.tools.call').filter((entry) => entry.event === 'operation.finish')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(9_000);

    expect((await pending).isError).toBeUndefined();
    expect(assertEnvelope('mcp.tools.call', 'success', 'ok').ms).toBe(40_000);
  });

  it('records module initialization failure with a stable code and no exception payload', async () => {
    const url = await httpMcp(
      pluginHandler(() => 'unused'),
      async () => {
        throw new Error(privateText);
      },
    );
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });

    expect(response.status).toBe(500);
    assertEnvelope('mcp.load', 'error', 'exception');
  });

  it('settles module loading when the HTTP caller disconnects before initialization finishes', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const url = await httpMcp(
      pluginHandler(() => 'unused'),
      () => {
        started();
        return new Promise(() => undefined);
      },
    );
    const controller = new AbortController();
    const pending = fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    const rejected = expect(pending).rejects.toThrow();
    await ready;

    controller.abort();
    await rejected;

    await vi.waitFor(() => expect(events('mcp.load')).toHaveLength(2));
    assertEnvelope('mcp.load', 'cancelled', 'aborted');
  });

  it('cancels a running tool when its stateless HTTP caller disconnects', async () => {
    let started!: () => void;
    let seenSignal: AbortSignal | undefined;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const url = await httpMcp(
      pluginHandler((_input, context) => {
        seenSignal = context.signal;
        started();
        return new Promise(() => undefined);
      }),
    );
    const client = new Client({ name: 'disconnect-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    cleanups.push(() => client.close());
    const pending = client.callTool({ name: 'lookup' });
    const rejected = expect(pending).rejects.toThrow();
    await ready;

    await client.close();
    await rejected;

    await vi.waitFor(() => expect(events('mcp.tools.call')).toHaveLength(2));
    expect(seenSignal?.aborted).toBe(true);
    assertEnvelope('mcp.tools.call', 'cancelled', 'aborted');
  });
});
