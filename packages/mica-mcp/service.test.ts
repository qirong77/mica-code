import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MicaTool } from '@packages/mica-tools/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import * as mcpClient from './client.js';
import * as mcpTools from './tools.js';
import {
  createMcpInitScope,
  initMcp,
  initializeMcpEntries,
  reconnectMcpServer,
  shutdownMcp,
  type McpInitDependencies,
} from './service.js';

describe('initMcp', () => {
  afterEach(() => vi.useRealTimers());

  it('rejects an already-aborted headless initialization', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(initMcp({ signal: controller.signal })).rejects.toThrow('cancelled');
  });

  it('bounds a server connect and tools/list with one timeout signal', async () => {
    vi.useFakeTimers();
    const scope = createMcpInitScope(undefined, 50, 'slow');
    const aborted = new Promise<void>((resolve) =>
      scope.signal?.addEventListener('abort', () => resolve(), { once: true }),
    );

    await vi.advanceTimersByTimeAsync(50);
    await aborted;

    expect(scope.timedOut()).toBe(true);
    expect(scope.signal?.reason).toMatchObject({ name: 'TimeoutError' });
    scope.dispose();
  });

  it('preserves an external abort reason without reporting a timeout', () => {
    const controller = new AbortController();
    const scope = createMcpInitScope(controller.signal, 1000, 'server');
    const reason = new Error('user cancelled');

    controller.abort(reason);

    expect(scope.timedOut()).toBe(false);
    expect(scope.signal?.reason).toBe(reason);
    scope.dispose();
  });

  it('initializes servers concurrently, skips a timed-out server, and keeps healthy tools', async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    const markConnected = vi.fn();
    const markFailed = vi.fn();
    const registerTools = vi.fn();
    const tool = {
      name: 'mcp__fast__working_tool',
      description: 'works',
      input_schema: {},
    } as MicaTool;
    const dependencies = {
      connect: vi.fn((name: string, config: unknown, signal?: AbortSignal) => {
        started.push(name);
        if (name === 'fast') return Promise.resolve({ name, config });
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }),
      fetchTools: vi.fn().mockResolvedValue([tool]),
      markConnected,
      markFailed,
      registerTools,
      cleanup: vi.fn(),
    } as unknown as McpInitDependencies;

    const pending = initializeMcpEntries(
      [
        ['slow', { url: 'https://slow.example.test' }],
        ['fast', { url: 'https://fast.example.test' }],
      ],
      { initTimeoutMs: 50, parallel: true },
      dependencies,
    );

    expect(started).toEqual(['slow', 'fast']);
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    expect(markFailed).toHaveBeenCalledWith('slow', 'https://slow.example.test', 'Initialization timed out after 50ms');
    expect(markConnected).toHaveBeenCalledWith('fast', 'https://fast.example.test', 1, [
      { name: 'working_tool', description: 'works', inputSchema: {} },
    ]);
    expect(registerTools).toHaveBeenCalledWith([tool]);
  });

  it('enforces the wall-clock deadline when a transport ignores abort', async () => {
    vi.useFakeTimers();
    const markFailed = vi.fn();
    const registerTools = vi.fn();
    const dependencies = {
      connect: vi.fn(() => new Promise(() => undefined)),
      fetchTools: vi.fn(),
      markConnected: vi.fn(),
      markFailed,
      registerTools,
      cleanup: vi.fn(),
    } as unknown as McpInitDependencies;

    const pending = initializeMcpEntries(
      [['stuck', { url: 'https://stuck.example.test' }]],
      { initTimeoutMs: 50, parallel: true },
      dependencies,
    );
    await vi.advanceTimersByTimeAsync(50);
    await pending;

    expect(markFailed).toHaveBeenCalledWith(
      'stuck',
      'https://stuck.example.test',
      'Initialization timed out after 50ms',
    );
    expect(registerTools).toHaveBeenCalledWith([]);
  });

  it('cleans the exact connected server when an external abort interrupts tools/list', async () => {
    const controller = new AbortController();
    const server = { name: 'connected', cleanup: vi.fn() };
    const cleanup = vi.fn();
    const dependencies = {
      connect: vi.fn().mockResolvedValue(server),
      fetchTools: vi.fn(() => new Promise(() => undefined)),
      markConnected: vi.fn(),
      markFailed: vi.fn(),
      registerTools: vi.fn(),
      cleanup,
    } as unknown as McpInitDependencies;

    const pending = initializeMcpEntries(
      [['connected', { url: 'https://connected.example.test' }]],
      { signal: controller.signal, parallel: true },
      dependencies,
    );
    await Promise.resolve();
    await Promise.resolve();
    const reason = new Error('stop now');
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(cleanup).toHaveBeenCalledWith(server);
  });

  it('cleans a connection that resolves after its initialization deadline', async () => {
    vi.useFakeTimers();
    let resolveConnect: ((server: unknown) => void) | undefined;
    const cleanup = vi.fn();
    const server = { name: 'late', cleanup: vi.fn() };
    const dependencies = {
      connect: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveConnect = resolve;
          }),
      ),
      fetchTools: vi.fn(),
      markConnected: vi.fn(),
      markFailed: vi.fn(),
      registerTools: vi.fn(),
      cleanup,
    } as unknown as McpInitDependencies;

    const pending = initializeMcpEntries(
      [['late', { url: 'https://late.example.test' }]],
      { initTimeoutMs: 50, parallel: true },
      dependencies,
    );
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    resolveConnect?.(server);
    await Promise.resolve();

    expect(cleanup).toHaveBeenCalledWith(server);
  });
});

describe('MCP reconnect tool snapshots', () => {
  afterEach(async () => {
    await shutdownMcp();
    mcpClient.connections.clear();
    vi.restoreAllMocks();
  });

  async function twoServers() {
    const tool = (name: string, action = 'lookup') =>
      new (class extends micaTools.MicaTool {
        constructor() {
          super(`mcp__${name}__${action}`, name, {}, { source: 'mcp', mcpServer: name });
        }
        async execute() {
          return name;
        }
        onToolUseDisplayText() {
          return name;
        }
      })();
    const tools = { first: tool('first'), second: tool('second'), replacement: tool('first', 'new_lookup') };
    const server = (name: string) => {
      const connection = {
        name,
        config: { command: name },
        client: {},
        cleanup: vi.fn(async () => {
          mcpClient.connections.delete(name);
        }),
      } as unknown as mcpClient.ConnectedMcpServer;
      mcpClient.connections.set(name, connection);
      return connection;
    };
    const first = server('first');
    const second = server('second');
    const dependencies = {
      connect: vi.fn(async (name: string) => mcpClient.connections.get(name)),
      fetchTools: vi.fn(async (connected: mcpClient.ConnectedMcpServer) => [
        tools[connected.name as 'first' | 'second'],
      ]),
      markConnected: mcpClient.markServerConnected,
      markFailed: mcpClient.markServerFailed,
      registerTools: micaTools.registerMcp,
      cleanup: vi.fn(),
    } as unknown as McpInitDependencies;
    await initializeMcpEntries(
      [
        ['first', first.config],
        ['second', second.config],
      ],
      {},
      dependencies,
    );
    const replacement = {
      ...first,
      cleanup: vi.fn(async () => {
        mcpClient.connections.delete('first');
      }),
    };
    const connect = vi.spyOn(mcpClient, 'connectToServer').mockImplementation(async () => {
      mcpClient.connections.set('first', replacement);
      return replacement;
    });
    const fetchTools = vi.spyOn(mcpTools, 'fetchToolsForServer').mockImplementation(async (connected) => {
      if (connected.name === 'second') throw new Error('second tools/list unavailable');
      return [tools.replacement];
    });
    const names = () =>
      micaTools
        .getDefinitions()
        .filter((entry) => entry.name.startsWith('mcp__'))
        .map((entry) => entry.name);
    return { first, second, replacement, tools, connect, fetchTools, names };
  }

  it('replaces only the reconnected server, retaining another server whose tools/list would fail', async () => {
    const fixture = await twoServers();

    expect(await reconnectMcpServer('first', fixture.first.config)).toContain('已重连 first');

    expect(fixture.names()).toEqual([fixture.tools.replacement.name, fixture.tools.second.name].sort());
    expect(fixture.fetchTools).toHaveBeenCalledTimes(1);
    expect(fixture.fetchTools).toHaveBeenCalledWith(fixture.replacement);
    expect(mcpClient.connections.get('second')).toBe(fixture.second);
    expect(fixture.second.cleanup).not.toHaveBeenCalled();
    expect(await micaTools.execute(fixture.tools.second.name, {})).toBe('second');
  });

  it('cleans a failed replacement without dropping an unrelated server snapshot', async () => {
    const fixture = await twoServers();
    fixture.fetchTools.mockRejectedValueOnce(new Error('replacement tools/list unavailable'));

    expect(await reconnectMcpServer('first', fixture.first.config)).toContain('重连失败');

    expect(fixture.names()).toEqual([fixture.tools.second.name]);
    expect(fixture.replacement.cleanup).toHaveBeenCalledOnce();
    expect(mcpClient.connections.has('first')).toBe(false);
    expect(fixture.second.cleanup).not.toHaveBeenCalled();
    expect(fixture.fetchTools).toHaveBeenCalledTimes(1);
  });

  it('removes an old snapshot once its server really disconnects', async () => {
    const fixture = await twoServers();
    await fixture.second.cleanup();

    await reconnectMcpServer('first', fixture.first.config);

    expect(fixture.names()).toEqual([fixture.tools.replacement.name]);
    expect(fixture.fetchTools).toHaveBeenCalledTimes(1);
  });
});
