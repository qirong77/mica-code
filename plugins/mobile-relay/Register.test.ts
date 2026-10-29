import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { machineIdentity, registerWithRelay } from './Registrar.js';
import { createPanelHandler } from './Panel.js';
import { registerMachine } from './registerMachine.js';
import { PluginActionRegistry } from '@packages/mica-plugin/index.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';

/**
 * 注册流程的端到端测试：真的起一个中转机进程，走真的 ECDH。
 *
 * 这里不 mock 网络，因为要验证的正是「两台机器各自注册、同一台重复注册拿到同一个口令」，
 * 以及封装的申请能不能被中转机解开。
 */

const relayScript = join(import.meta.dirname, 'relay', 'relay.mjs');

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

type Relay = { child: ChildProcess; url: string; stateDir: string; stop: () => Promise<void> };

async function startRelay(
  options: { enrollKey?: string; seedLabel?: string; seedToken?: string } = {}
): Promise<Relay> {
  const stateDir = mkdtempSync(join(tmpdir(), 'mica-relay-register-'));
  mkdirSync(join(stateDir), { recursive: true });
  writeFileSync(
    join(stateDir, 'agents.json'),
    `${JSON.stringify(
      {
        version: 1,
        ...(options.enrollKey ? { enrollKey: options.enrollKey } : {}),
        agents: [
          {
            id: 'seed',
            label: options.seedLabel || '已有机器',
            token: options.seedToken || 'a'.repeat(48),
            createdAt: Date.now()
          }
        ]
      },
      null,
      2
    )}\n`
  );
  const port = await freePort();
  const child = spawn(process.execPath, [relayScript], {
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      RELAY_BIND: '127.0.0.1',
      RELAY_STATE_DIR: stateDir,
      RELAY_ROOT: stateDir
    },
    stdio: 'ignore'
  });
  await waitForPort(port);
  return {
    child,
    url: `http://127.0.0.1:${port}`,
    stateDir,
    stop: async () => {
      child.kill('SIGTERM');
      rmSync(stateDir, { recursive: true, force: true });
    }
  };
}

function agentCount(relay: Relay): number {
  const parsed = JSON.parse(readFileSync(join(relay.stateDir, 'agents.json'), 'utf8')) as {
    agents: unknown[];
  };
  return parsed.agents.length;
}

function agentLabels(relay: Relay): string[] {
  const parsed = JSON.parse(readFileSync(join(relay.stateDir, 'agents.json'), 'utf8')) as {
    agents: { label: string }[];
  };
  return parsed.agents.map((entry) => entry.label);
}

describe('relay registration', () => {
  let relay: Relay;

  beforeAll(async () => {
    relay = await startRelay();
  });

  afterAll(async () => {
    await relay.stop();
  });

  it('same machine gets the same token every time', async () => {
    const first = await registerWithRelay({ relayUrl: relay.url, label: '书房的 MacBook' });
    expect(first.token).toHaveLength(48);
    expect(first.created).toBe(true);

    const again = await registerWithRelay({ relayUrl: relay.url, label: '书房的 MacBook' });
    expect(again.token).toBe(first.token);
    expect(again.created).toBe(false);
    // 种子机器 + 这一台
    expect(agentCount(relay)).toBe(2);
  });

  it('a different machine gets a different token', async () => {
    const other = await registerWithRelay({
      relayUrl: relay.url,
      identity: { identity: 'b'.repeat(64), label: '另一台机器', platform: 'linux-x64' }
    });
    expect(other.created).toBe(true);

    const mine = await registerWithRelay({ relayUrl: relay.url, label: '书房的 MacBook' });
    expect(other.token).not.toBe(mine.token);
    expect(agentLabels(relay)).toContain('另一台机器');
  });

  it('keeps the machine label from the relay, not from the caller', async () => {
    const result = await registerWithRelay({ relayUrl: relay.url, label: '书房的 MacBook' });
    expect(result.label).toBe('书房的 MacBook');
  });

  it('fails with a readable message when the relay is unreachable', async () => {
    await expect(registerWithRelay({ relayUrl: 'http://127.0.0.1:1', timeoutMs: 2_000 })).rejects.toThrow();
  });
});

describe('relay registration with an enroll key', () => {
  let relay: Relay;

  beforeAll(async () => {
    relay = await startRelay({ enrollKey: 'enroll-secret-123' });
  });

  afterAll(async () => {
    await relay.stop();
  });

  it('refuses a registration without the key', async () => {
    await expect(
      registerWithRelay({ relayUrl: relay.url, identity: { identity: 'c'.repeat(64), label: '没口令', platform: 'x' } })
    ).rejects.toThrow(/接入口令/);
    expect(agentCount(relay)).toBe(1);
  });

  it('accepts the registration with the key', async () => {
    const result = await registerWithRelay({
      relayUrl: relay.url,
      enrollKey: 'enroll-secret-123',
      identity: { identity: 'd'.repeat(64), label: '带口令的机器', platform: 'x' }
    });
    expect(result.token).toHaveLength(48);
    expect(agentCount(relay)).toBe(2);
  });
});

describe('machine identity', () => {
  it('is stable and does not leak the raw hostname', () => {
    const first = machineIdentity();
    const second = machineIdentity();
    expect(first.identity).toMatch(/^[0-9a-f]{64}$/);
    expect(second.identity).toBe(first.identity);
    expect(first.identity).not.toContain(first.label);
  });
});

describe('legacy machine list', () => {
  let relay: Relay;

  beforeAll(async () => {
    // setup.mjs 写的老记录没有 identityHash，只有名字
    relay = await startRelay({ seedLabel: machineIdentity().label, seedToken: 'e'.repeat(48) });
  });

  afterAll(async () => {
    await relay.stop();
  });

  it('adopts the existing record by name instead of adding a duplicate', async () => {
    const result = await registerWithRelay({ relayUrl: relay.url });
    expect(result.token).toBe('e'.repeat(48));
    expect(result.created).toBe(false);
    expect(agentCount(relay)).toBe(1);
  });
});

function panelContext(store: Record<string, string>): PluginContext {
  return {
    pluginId: 'mobile-relay',
    settings: {
      path: '/tmp/mobile-relay-settings.json',
      get: () => ({ ...store }),
      validate: () => [],
      set: (patch: Record<string, unknown>) => {
        Object.assign(store, patch);
        return { ...store };
      }
    },
    health: { report: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  } as unknown as PluginContext;
}

describe('panel register action', () => {
  let relay: Relay;
  let dataDir: string;

  beforeAll(async () => {
    relay = await startRelay();
    dataDir = mkdtempSync(join(tmpdir(), 'mica-relay-panel-register-'));
  });

  afterAll(async () => {
    await relay.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes the token into settings and reuses it on a second click', async () => {
    const store: Record<string, string> = { enabled: 'true', relayUrl: '', token: '' };
    const handler = createPanelHandler(panelContext(store), dataDir);

    const first = await handler.action({ action: 'register', values: { relayUrl: relay.url } });
    expect(first).toMatchObject({ message: expect.stringMatching(/注册/) });
    expect(store.relayUrl).toBe(relay.url);
    const token = store.token;
    expect(token).toHaveLength(48);
    // 运行状态由 data.json 驱动，注册完不必等桥起来
    const data = JSON.parse(readFileSync(join(dataDir, 'data.json'), 'utf8')) as { phoneUrl?: string };
    expect(data.phoneUrl).toBe(`${relay.url}/?t=${token}`);

    const second = await handler.action({ action: 'register', values: { relayUrl: relay.url } });
    expect(second).toMatchObject({ message: expect.stringMatching(/早就注册过|沿用/) });
    expect(store.token).toBe(token);
    expect(agentCount(relay)).toBe(2);
  });
});

describe('config page action', () => {
  let relay: Relay;
  let dataDir: string;

  beforeAll(async () => {
    relay = await startRelay();
    dataDir = mkdtempSync(join(tmpdir(), 'mica-relay-config-action-'));
  });

  afterAll(async () => {
    await relay.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // 配置页的按钮走 `ctx.actions`：一次性的插件进程里没有会话，也不能有。
  it('注册后返回手机链接，并把口令写进设置', async () => {
    const store: Record<string, string> = { enabled: 'true', relayUrl: '', token: '' };
    const actions = new PluginActionRegistry(() => ['register']);
    actions.add('mobile-relay', 'register', async ({ values }) =>
      registerMachine(panelContext(store), values, dataDir),
    );

    const result = await actions.run('mobile-relay', 'register', { values: { relayUrl: relay.url } });

    expect(result).toMatchObject({ message: expect.stringMatching(/注册/) });
    expect(store.relayUrl).toBe(relay.url);
    expect(result?.link).toBe(`${relay.url}/?t=${store.token}`);
  });
});

describe('bridge lifecycle', () => {
  it('父进程消失后桥自己退出，不留孤儿进程', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mica-relay-orphan-'));
    mkdirSync(join(home, 'plugin-settings'), { recursive: true });
    writeFileSync(
      join(home, 'plugin-settings', 'mobile-relay.json'),
      JSON.stringify({ enabled: 'true', relayUrl: 'http://127.0.0.1:9', token: 'a'.repeat(32) })
    );
    const child = spawn(process.execPath, [join(import.meta.dirname, 'agent', 'bridge.mjs')], {
      env: {
        ...process.env,
        MICA_HOME: home,
        LOCAL_URL: 'http://127.0.0.1:9',
        MICA_RELAY_PARENT_PID: '999999'
      },
      stdio: 'ignore'
    });
    const code = await new Promise((resolve) => {
      child.on('exit', resolve);
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve('timeout');
      }, 8000);
    });
    rmSync(home, { recursive: true, force: true });
    expect(code).toBe(0);
  });
});
