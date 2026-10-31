import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 静态资源必须不需要口令。
 *
 * 手机打开 /?t=… 拿到的是 HTML，紧接着每个 /assets/*.js 都是独立请求；
 * 浏览器只要没带上 cookie，这些请求就会拿到登录页 HTML，React 起不来、整页空白。
 * 构建产物按内容 hash 命名，不含用户数据，公开可读才是稳的。
 */

const relayScript = join(import.meta.dirname, 'relay', 'relay.mjs');
const TOKEN = 'f'.repeat(48);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
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

let root = '';
let stateDir = '';
let child: ChildProcess | null = null;
let base = '';

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mica-relay-assets-'));
  stateDir = mkdtempSync(join(tmpdir(), 'mica-relay-assets-state-'));
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><body>shell<script src="./assets/app.js"></script></body></html>',
  );
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log("asset-ok")');
  writeFileSync(join(root, 'manifest.webmanifest'), '{"name":"mica"}');
  writeFileSync(
    join(stateDir, 'agents.json'),
    `${JSON.stringify({ version: 1, agents: [{ id: 'seed', label: '本机', token: TOKEN, createdAt: Date.now() }] })}\n`,
  );

  const port = await freePort();
  child = spawn(process.execPath, [relayScript], {
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      RELAY_BIND: '127.0.0.1',
      RELAY_STATE_DIR: stateDir,
      RELAY_ROOT: root,
    },
    stdio: 'ignore',
  });
  await waitForPort(port);
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  child?.kill('SIGTERM');
  rmSync(root, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

describe('relay static assets', () => {
  it('serves a hashed asset without any token', async () => {
    const response = await fetch(`${base}/assets/app.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(await response.text()).toBe('console.log("asset-ok")');
  });

  it('serves the web manifest without a token', async () => {
    const response = await fetch(`${base}/manifest.webmanifest`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('mica');
  });

  it('still asks for the token on the page shell', async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('输入访问口令');
  });

  it('keeps user data behind the token', async () => {
    const response = await fetch(`${base}/api/env`);
    expect(response.status).toBe(401);
  });

  it('rejects an invalid explicit token instead of switching to another remembered machine', async () => {
    const headers = { cookie: `mica_relays=${TOKEN}` };
    const response = await fetch(`${base}/api/env?t=invalid-token`, { headers });
    expect(response.status).toBe(401);
    const health = await fetch(`${base}/api/health?t=invalid-token`, { headers });
    expect(health.status).toBe(401);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it('explains an offline machine instead of failing silently', async () => {
    const response = await fetch(`${base}/?t=${TOKEN}`);
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain('暂时不可用');
    expect(html).toContain('最近一次连上');
  });
});
