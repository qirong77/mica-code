import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
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
  /** 让「本机运行时」吐一条 SSE 事件，模拟 PTY 把终端输出推出来。 */
  emitLocalEvent: (event: unknown) => void;
  relayPort: number;
  stop: () => Promise<void>;
};

async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'mica-relay-terminal-'));
  const localCalls: string[] = [];
  const localEventClients: ServerResponse[] = [];

  const local = createHttpServer((req, res) => {
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname === '/api/env') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ platform: 'darwin', homeDir: '/tmp' }));
      return;
    }
    if (url.pathname === '/api/paste-image' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk as Buffer));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { dataUrl?: string };
        localCalls.push('__paste-image');
        if (!String(body.dataUrl || '').startsWith('data:image/')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad data url' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ref: '/tmp/images/pasted-1.png' }));
      });
      return;
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
      localEventClients.push(res);
      res.on('close', () => {
        const index = localEventClients.indexOf(res);
        if (index >= 0) localEventClients.splice(index, 1);
      });
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
        if (channel.startsWith('no-such:')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `No handler registered for '${channel}'` }));
          return;
        }
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
    emitLocalEvent: (event: unknown) => {
      for (const client of localEventClients) client.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    relayPort,
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

  it('配置页与插件入口直接放行', async () => {
    for (const channel of ['config-web:invoke', 'chat:plugin-panel-view', 'chat:session-menu-run']) {
      expect((await harness.invoke(channel, { action: 'read-config' })).ok).toBe(true);
      expect(harness.localCalls).toContain(channel);
    }
  });

  // 页面能打开就等于坐在这台机器前：不再有「只读」的那一半。
  // 这条曾经是 bug——`chat:commit` 因为不在白名单里而在手机上直接失败，
  // 报错看起来还像权限问题。
  it('写工作区的通道直通，不需要任何开关', async () => {
    for (const channel of ['files:write', 'git:discard', 'chat:commit', 'share:add']) {
      expect((await harness.invoke(channel, {})).ok).toBe(true);
      expect(harness.localCalls).toContain(channel);
    }
  });

  it('运行时没有的通道直说「运行时不提供」，不说成权限问题', async () => {
    const result = await harness.invoke('no-such:channel', {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no-such:channel');
    expect(result.error).toContain('运行时不提供');
    expect(result.error).not.toContain('允许手机端修改');
  });

  it('手机上贴的截图经中转机送进本机图片目录', async () => {
    const response = await fetch(`http://127.0.0.1:${harness.relayPort}/api/paste-image?t=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=' })
    });
    const body = (await response.json()) as { ok: boolean; ref?: string; error?: string };
    expect(body.ok).toBe(true);
    expect(body.ref).toBe('/tmp/images/pasted-1.png');
    expect(harness.localCalls).toContain('__paste-image');
  });

  it('命令不等下一轮轮询：发起后立刻到达本机', async () => {
    const started = Date.now();
    const result = await harness.invoke('terminal:get-cwd', { id: 'tab-1:terminal' });
    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  // 终端回显走的是本机 → 中转机 → 手机这条方向。以前它只能捎带在下一轮轮询的请求体里，
  // 延迟等于「挂起的那次轮询还剩多久」（1–15 秒）：手机上每敲一个字都要等这么久才看见。
  // 现在事件单独推，不该再受轮询周期影响。
  it('终端回显不等挂起的轮询：事件立刻推到手机', async () => {
    const phone = await openPhoneStream(harness.relayPort);
    try {
      // 桥只有在「有手机在看」时才转发事件，这个状态来自上一轮轮询的响应，
      // 所以要等它转一轮（中转机对有人在看时最多挂 3 秒）。
      const ready = await waitForEvent(phone, 12_000, (probe) =>
        harness.emitLocalEvent({ channel: 'terminal:data', payload: { data: probe } }),
      );
      expect(ready).toBeTruthy();

      const started = Date.now();
      const probe = `after-ready-${Date.now()}`;
      harness.emitLocalEvent({ channel: 'terminal:data', payload: { data: probe } });
      const received = await phone.next(5_000);
      expect(received).toMatchObject({ channel: 'terminal:data', payload: { data: probe } });
      // 捎带在轮询上的话至少是一轮挂起（≥1 秒）；这里按毫秒级算。
      expect(Date.now() - started).toBeLessThan(1000);
    } finally {
      phone.close();
    }
  }, 30_000);
});

type PhoneStream = {
  next: (timeoutMs: number) => Promise<Record<string, unknown> | null>;
  close: () => void;
};

/** 冒充手机打开页面的那条 SSE：只关心收到的数据帧。 */
async function openPhoneStream(relayPort: number): Promise<PhoneStream> {
  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${relayPort}/api/events?t=${TOKEN}`, {
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  const queue: Array<Record<string, unknown>> = [];
  let waiting: ((value: Record<string, unknown> | null) => void) | null = null;

  const pump = async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const blocks = pending.split('\n\n');
      pending = blocks.pop() || '';
      for (const block of blocks) {
        const line = block.split('\n').find((entry) => entry.startsWith('data: '));
        if (!line) continue;
        const frame = JSON.parse(line.slice(6)) as Record<string, unknown>;
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          resolve(frame);
        } else {
          queue.push(frame);
        }
      }
    }
  };
  void pump();

  return {
    next: (timeoutMs: number) => {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting = null;
          resolve(null);
        }, timeoutMs);
        waiting = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
      });
    },
    close: () => controller.abort(),
  };
}

/** 反复投一帧，直到手机收到——用来越过「桥还不知道有手机在看」那段。 */
async function waitForEvent(
  phone: PhoneStream,
  timeoutMs: number,
  emit: (probe: string) => void,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    emit(`probe-${Date.now()}`);
    if (await phone.next(400)) return true;
  }
  return false;
}
