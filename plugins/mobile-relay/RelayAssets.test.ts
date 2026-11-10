import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('中转机没起来');
}

let root = '';
let stateDir = '';
let child: ChildProcess | null = null;
let base = '';

async function waitUntil(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('等待资源准备超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function pageArchive(html: string, asset: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'mica-relay-page-'));
  try {
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), html);
    writeFileSync(join(dir, 'assets', 'app.js'), asset);
    return execFileSync('tar', ['-czf', '-', '-C', dir, '.'], { maxBuffer: 16 * 1024 * 1024 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function publish(body: Buffer): Promise<Response> {
  return fetch(`${base}/api/publish`, {
    method: 'POST',
    headers: { 'x-relay-token': TOKEN },
    body,
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'mica-relay-assets-'));
  stateDir = mkdtempSync(join(tmpdir(), 'mica-relay-assets-state-'));
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><html><body>shell<script src="./assets/app.js"></script></body></html>',
  );
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log("asset-ok")');
  writeFileSync(join(root, 'assets', 'app-AbCd1234.js'), 'fingerprinted');
  for (let i = 0; i < 3; i += 1) {
    writeFileSync(join(root, 'assets', `slow-${i}.js`), randomBytes(1_500_000).toString('hex'));
  }
  writeFileSync(join(root, 'assets', 'stale.js'), 'fresh source');
  const future = new Date(Date.now() + 60 * 60 * 1000);
  utimesSync(join(root, 'assets', 'stale.js'), future, future);
  writeFileSync(join(root, 'assets', 'stale.js.br'), 'outdated');
  utimesSync(join(root, 'assets', 'stale.js.br'), 1, 1);
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
  it('responds during startup compression without serving a stale sidecar', async () => {
    const lastPacked = join(root, 'assets', 'slow-2.js.gz');
    expect(existsSync(lastPacked)).toBe(false);
    const response = await fetch(`${base}/assets/stale.js`, { headers: { 'accept-encoding': 'br' } });
    expect(existsSync(lastPacked)).toBe(false);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.text()).toBe('fresh source');
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it('generates complete compressed startup assets and replaces stale sidecars', async () => {
    const asset = join(root, 'assets', 'stale.js');
    await waitUntil(() => existsSync(`${asset}.gz`));
    expect(brotliDecompressSync(readFileSync(`${asset}.br`)).toString()).toBe('fresh source');
    expect(gunzipSync(readFileSync(`${asset}.gz`)).toString()).toBe('fresh source');
    const response = await fetch(`${base}/assets/stale.js`, { headers: { 'accept-encoding': 'br' } });
    expect(response.headers.get('content-encoding')).toBe('br');
    expect(await response.text()).toBe('fresh source');
  });

  it('serves a hashed asset without any token', async () => {
    const response = await fetch(`${base}/assets/app-AbCd1234.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('javascript');
    expect(response.headers.get('cache-control')).toContain('immutable');
    expect(await response.text()).toBe('fingerprinted');
    expect((await fetch(`${base}/assets/app.js`)).headers.get('cache-control')).toBe('no-cache');
  });

  it('negotiates encoding quality and preserves cache metadata on revalidation', async () => {
    await waitUntil(() => existsSync(join(root, 'assets', 'stale.js.gz')));
    const request = (encoding: string, etag?: string) => fetch(`${base}/assets/stale.js`, {
      headers: { 'accept-encoding': encoding, ...(etag ? { 'if-none-match': etag } : {}) },
    });
    const gzip = await request('br;q=0, gzip;q=1');
    expect(gzip.headers.get('content-encoding')).toBe('gzip');
    expect(await gzip.text()).toBe('fresh source');
    const etag = gzip.headers.get('etag')!;
    const revalidated = await request('br', `"unrelated", ${etag.replace('W/', '')}`);
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('vary')).toBe('accept-encoding');
    expect(revalidated.headers.get('cache-control')).toBe('no-cache');
    expect((await request('br;q=0.1, gzip;q=0.8, identity;q=0')).headers.get('content-encoding')).toBe('gzip');
    expect((await request('br;q=0, gzip;q=0')).headers.get('content-encoding')).toBeNull();
    expect((await request('*;q=0')).status).toBe(406);
    expect((await request('notgzip, identity;q=0')).status).toBe(406);
  });

  it('revalidates injected HTML only after authentication and negotiates its encoding', async () => {
    const headers = { 'x-relay-token': TOKEN, 'accept-encoding': 'br' };
    const response = await fetch(`${base}/view`, { headers });
    expect(response.headers.get('content-encoding')).toBe('br');
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    expect(await response.text()).toContain('<script src="/relay-awake.js" defer></script>');
    const etag = response.headers.get('etag')!;
    const conditional = await fetch(`${base}/view`, { headers: { ...headers, 'if-none-match': etag } });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('vary')).toBe('accept-encoding, cookie');
    const anonymous = await fetch(`${base}/view`, { headers: { 'if-none-match': etag } });
    expect(anonymous.status).toBe(200);
    expect(await anonymous.text()).toContain('输入访问口令');
    const noCompression = await fetch(`${base}/view`, { headers: { ...headers, 'accept-encoding': 'br;q=0, gzip;q=0' } });
    expect(noCompression.headers.get('content-encoding')).toBeNull();
    expect(await noCompression.text()).toContain('shell');
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

  it('keeps the current page when a publication cannot be unpacked', async () => {
    const response = await publish(Buffer.from('not a tar archive'));
    expect(response.status).toBe(400);
    expect(await (await fetch(`${base}/assets/app.js`)).text()).toBe('console.log("asset-ok")');
    expect(existsSync(`${root}.next`)).toBe(false);
  });

  it('serves the old page while compressing and serializes concurrent publications', async () => {
    const oldEtag = (await fetch(`${base}/assets/app.js`)).headers.get('etag')!;
    const oldPageEtag = (await fetch(`${base}/view`, { headers: { 'x-relay-token': TOKEN } })).headers.get('etag')!;
    // A large, hard-to-compress file leaves time to exercise requests during compression.
    const largeAsset = randomBytes(1_500_000).toString('hex');
    const first = pageArchive('<html><body>first version</body></html>', largeAsset);
    const second = pageArchive('<html><body>second version</body></html>', 'second asset');
    let firstFinished = false;
    const firstRequest = publish(first).finally(() => { firstFinished = true; });
    await waitUntil(() => existsSync(`${root}.next/assets/app.js`));
    const secondRequest = publish(second);

    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    expect(firstFinished).toBe(false);
    const oldAsset = await fetch(`${base}/assets/app.js`);
    expect(await oldAsset.text()).toBe('console.log("asset-ok")');

    const firstResponse = await firstRequest;
    const secondResponse = await secondRequest;
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    const firstVersion = (await firstResponse.json()).pageVersion;
    const secondVersion = (await secondResponse.json()).pageVersion;
    expect(firstVersion).toBe(createHash('sha256').update('<html><body>first version</body></html>').digest('hex').slice(0, 12));
    expect(secondVersion).toBe(createHash('sha256').update('<html><body>second version</body></html>').digest('hex').slice(0, 12));
    const finalHealth = await fetch(`${base}/api/health`, { headers: { 'x-relay-token': TOKEN } });
    expect((await finalHealth.json()).pageVersion).toBe(secondVersion);
    expect(readFileSync(join(root, 'index.html'), 'utf8')).toContain('second version');
    expect(brotliDecompressSync(readFileSync(join(root, 'assets', 'app.js.br'))).toString()).toBe('second asset');
    expect(gunzipSync(readFileSync(join(root, 'assets', 'app.js.gz'))).toString()).toBe('second asset');
    const newAsset = await fetch(`${base}/assets/app.js`, { headers: { 'if-none-match': oldEtag } });
    expect(newAsset.status).toBe(200);
    expect(await newAsset.text()).toBe('second asset');
    const newPage = await fetch(`${base}/view`, { headers: { 'x-relay-token': TOKEN, 'if-none-match': oldPageEtag } });
    expect(newPage.status).toBe(200);
    expect(await newPage.text()).toContain('second version');
  }, 30_000);
});
