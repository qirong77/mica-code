import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageVersionOf, resolveRendererDir, syncPage } from './PageSync';

const relayScript = join(import.meta.dirname, 'relay', 'relay.mjs');
const TOKEN = 'b'.repeat(48);

function writePage(dir: string, marker: string): string {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', `app-${marker}.js`), `console.log(${JSON.stringify(marker)})`);
  const html = `<!doctype html><script type="module" src="./assets/app-${marker}.js"></script>`;
  writeFileSync(join(dir, 'index.html'), html);
  return createHash('sha256').update(html).digest('hex').slice(0, 12);
}

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

async function waitForPort(port: number): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ok = await fetch(`http://127.0.0.1:${port}/api/health`)
      .then(() => true)
      .catch(() => false);
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('relay 没起来');
}

type Relay = { child: ChildProcess; url: string; root: string; state: string; stop: () => void };

async function startRelay(pageMarker: string): Promise<Relay> {
  const base = mkdtempSync(join(tmpdir(), 'mica-page-sync-'));
  const root = join(base, 'public');
  writePage(root, pageMarker);
  const state = join(base, 'state');
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, 'agents.json'),
    `${JSON.stringify({
      version: 1,
      agents: [{ id: 'unit', label: '单测', token: TOKEN, createdAt: Date.now() }],
    })}\n`,
  );
  const port = await freePort();
  const child = spawn(process.execPath, [relayScript], {
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      RELAY_BIND: '127.0.0.1',
      RELAY_STATE_DIR: state,
      RELAY_ROOT: root,
    },
    stdio: 'ignore',
  });
  await waitForPort(port);
  return {
    child,
    url: `http://127.0.0.1:${port}`,
    root,
    state,
    stop: () => {
      child.kill('SIGTERM');
      rmSync(base, { recursive: true, force: true });
    },
  };
}

describe('page fingerprint', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mica-page-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('index.html 一变版本号就变', () => {
    const dir = join(root, 'renderer');
    const first = writePage(dir, 'aaa111');
    expect(pageVersionOf(dir)).toBe(first);
    const second = writePage(dir, 'bbb222');
    expect(second).not.toBe(first);
    expect(pageVersionOf(dir)).toBe(second);
  });

  it('找不到产物时返回 null，不抛错', () => {
    expect(pageVersionOf(join(root, 'nope'))).toBeNull();
    expect(pageVersionOf(null)).toBeNull();
  });

  it('显式设置的目录优先于环境变量', () => {
    const explicit = join(root, 'explicit');
    const env = join(root, 'env');
    writePage(explicit, 'aaa111');
    writePage(env, 'bbb222');
    expect(resolveRendererDir({ explicit, env })).toBe(explicit);
    expect(resolveRendererDir({ explicit: join(root, 'missing'), env })).toBe(env);
  });
});

describe('publishing the page to a relay', () => {
  let relay: Relay;
  let local = '';

  beforeEach(async () => {
    relay = await startRelay('old000');
    local = mkdtempSync(join(tmpdir(), 'mica-page-local-'));
  });

  afterEach(() => {
    relay.stop();
    rmSync(local, { recursive: true, force: true });
  });

  it('版本不同就上传，中转机随即换成新页面', async () => {
    const version = writePage(local, 'new111');
    const outcome = await syncPage({
      relayUrl: relay.url,
      token: TOKEN,
      rendererDir: local,
    });
    expect(outcome).toMatchObject({ status: 'published', version });
    expect(readFileSync(join(relay.root, 'index.html'), 'utf8')).toContain('app-new111.js');
    const health = (await (await fetch(`${relay.url}/api/health`, { headers: { 'x-relay-token': TOKEN } })).json()) as {
      pageVersion: string;
    };
    expect(health.pageVersion).toBe(version);
  }, 60_000);

  it('版本一致就不重复上传', async () => {
    const version = writePage(local, 'new111');
    await syncPage({ relayUrl: relay.url, token: TOKEN, rendererDir: local });
    const again = await syncPage({ relayUrl: relay.url, token: TOKEN, rendererDir: local });
    expect(again).toEqual({ status: 'current', version });
  }, 60_000);

  it('找不到页面产物时如实说明，不去猜', async () => {
    const outcome = await syncPage({
      relayUrl: relay.url,
      token: TOKEN,
      rendererDir: join(local, 'missing'),
    });
    expect(outcome.status).toBe('unsupported');
  });
});
