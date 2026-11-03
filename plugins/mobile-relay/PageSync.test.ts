import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageVersionOf, resolveRendererDir, syncPage } from './PageSync';
import { guidePageSync, repoRootFor } from './PageSyncAction';

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

describe('the button hands the update to a session', () => {
  it('准备一段自洽的提示词，并且不替用户按发送', () => {
    const { newSession } = guidePageSync();
    expect(newSession.send).toBe(false);
    // 接手的是新会话：看不出用户刚才点了什么，提示词必须自己说清要跑哪个操作。
    expect(newSession.prompt).toContain('mobile_relay');
    expect(newSession.prompt).toContain('sync_page');
    // 产物缺失这一支是这一步最常见的失败，别让它变成「报错了，然后呢」。
    expect(newSession.prompt).toContain('electron-vite build');
    // 页面更新走 HTTP 上传，不需要 SSH，提示词不能把人引去重新部署。
    expect(newSession.prompt).toContain('不要为此重新部署中转机');
  });

  it('带上 skill 的真实路径与新会话的工作目录', () => {
    const rendererDir = '/Users/someone/mica-code/apps/desktop/out/renderer';
    const skillPath = '/Users/someone/.mica/plugin-data/mobile-relay/skill/SKILL.md';
    const { newSession } = guidePageSync({ skillPath, rendererDir });

    // 新会话可能停在任何目录：skill 要给绝对路径，构建命令也要给全。
    expect(newSession.prompt).toContain(`[skill:mobile-relay](${skillPath})`);
    expect(newSession.prompt).toContain(rendererDir);
    expect(newSession.prompt).toContain('cd /Users/someone/mica-code/apps/desktop');
    // 工作目录跟着页面产物走，agent 去构建时就落在那个仓库里。
    expect(newSession.cwd).toBe('/Users/someone/mica-code');
  });

  it('产物不在仓库里时不猜工作目录', () => {
    const { newSession } = guidePageSync({ rendererDir: '/opt/mica/renderer' });
    expect(repoRootFor('/opt/mica/renderer')).toBeNull();
    expect(newSession.cwd).toBeUndefined();
    expect(newSession.prompt).toContain('cd apps/desktop');
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
    // 构建产物按内容哈希命名，浏览器会独立请求它们：换页之后它也得是新的
    const asset = await fetch(`${relay.url}/assets/app-new111.js`);
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain('new111');
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

  // 口令不对时中转机回 401。这条路径最容易做成「静默当作已同步」——用户点了按钮，
  // 页面没变、也没有任何提示。
  it('口令不对时明确报错', async () => {
    writePage(local, 'new111');
    await expect(
      syncPage({ relayUrl: relay.url, token: 'f'.repeat(48), rendererDir: local }),
    ).rejects.toThrow(/中转机拒绝了这份页面（401）/);
  }, 60_000);
});
