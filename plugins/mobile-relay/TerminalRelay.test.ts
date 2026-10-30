import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 桥的白名单与中转机的挂起轮询：页面上的终端必须能直达本机运行时的 PTY。
 *
 * 这里不 mock 网络，用的是真的中转机进程 + 真的桥；本地运行时换成一个只会记账的
 * HTTP 服务，因此能看清「哪些通道被放过、哪些被挡下」，也不必真的开 PTY。
 */

const relayScript = join(import.meta.dirname, 'relay', 'relay.mjs');
const bridgeScript = join(import.meta.dirname, 'agent', 'bridge.mjs');
const TOKEN = 'b'.repeat(48);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('中转机没起来');
}

type Harness = {
  localCalls: string[];
  invoke: (channel: string, payload?: unknown) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  stop: () => Promise<void>;
};

async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'mica-relay-terminal-'));
  const localCalls: string[] = [];

  const local = createHttpServer((req, res) => {
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname === '/api/env') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ platform: 'darwin', homeDir: '/tmp' }));
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      return;
    }
    if (url.pathname === '/api/invoke' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
          channel?: string;
          payload?: unknown;
        };
        const channel = String(body.channel || '');
        localCalls.push(channel);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { channel, payload: body.payload } }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  const localPort = await freePort();
  await new Promise<void>((resolve) => local.listen(localPort, '127.0.0.1', resolve));

  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(
    join(dir, 'state', 'agents.json'),
    `${JSON.stringify(
      {
        version: 1,
        agents: [{ id: 'one', label: '测试机', token: TOKEN, createdAt: Date.now() }]
      },
      null,
      2
    )}\n`
  );
  const relayPort = await freePort();
  const relay = spawn(process.execPath, [relayScript], {
    env: {
      ...process.env,
      RELAY_PORT: String(relayPort),
      RELAY_BIND: '127.0.0.1',
      RELAY_STATE_DIR: join(dir, 'state'),
      RELAY_ROOT: join(dir, 'state')
    },
    stdio: 'ignore'
  });
  await waitForPort(relayPort);

  mkdirSync(join(dir, 'home', 'plugin-settings'), { recursive: true });
  writeFileSync(
    join(dir, 'home', 'plugin-settings', 'mobile-relay.json'),
    `${JSON.stringify(
      {
        enabled: 'true',
        relayUrl: `http://127.0.0.1:${relayPort}`,
        localUrl: `http://127.0.0.1:${localPort}`,
        token: TOKEN
      },
      null,
      2
    )}\n`
  );
  const bridge: ChildProcess = spawn(process.execPath, [bridgeScript], {
    env: {
      ...process.env,
      MICA_HOME: join(dir, 'home'),
      RELAY_URL: `http://127.0.0.1:${relayPort}`,
      LOCAL_URL: `http://127.0.0.1:${localPort}`
    },
    stdio: 'ignore'
  });
  // 桥起来后要先完成一轮轮询，中转机才会认为这台机器在线
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const health = (await (
      await fetch(`http://127.0.0.1:${relayPort}/api/health?t=${TOKEN}`)
    ).json()) as { agentOnline?: boolean };
    if (health.agentOnline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const invoke = async (channel: string, payload: unknown = {}) => {
    const response = await fetch(`http://127.0.0.1:${relayPort}/api/invoke?t=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, payload })
    });
    return (await response.json()) as { ok: boolean; result?: unknown; error?: string };
  };

  return {
    localCalls,
    invoke,
    stop: async () => {
      bridge.kill('SIGKILL');
      relay.kill('SIGTERM');
      await new Promise<void>((resolve) => local.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe('relay terminal access', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  }, 30_000);

  afterAll(async () => {
    await harness?.stop();
  });

  it('放行手机端的终端读写', async () => {
    const created = await harness.invoke('terminal:create', { id: 'tab-1:terminal', cols: 80, rows: 24 });
    expect(created.ok).toBe(true);
    expect(harness.localCalls).toContain('terminal:create');

    const written = await harness.invoke('terminal:write', { id: 'tab-1:terminal', data: 'ls\r' });
    expect(written.ok).toBe(true);
    expect(harness.localCalls).toContain('terminal:write');

    for (const channel of ['terminal:resize', 'terminal:get-cwd', 'terminal:dispose']) {
      expect((await harness.invoke(channel, { id: 'tab-1:terminal' })).ok).toBe(true);
    }
  });

  it('仍然挡下会改机器状态的通道', async () => {
    const rejected = await harness.invoke('config-web:invoke', { action: 'write-config' });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain('config-web:invoke');
    expect(harness.localCalls).not.toContain('config-web:invoke');
  });

  it('命令不等下一轮轮询：发起后立刻到达本机', async () => {
    const started = Date.now();
    const result = await harness.invoke('terminal:get-cwd', { id: 'tab-1:terminal' });
    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
