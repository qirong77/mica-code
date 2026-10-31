import { describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 会话右键菜单动作的端到端链路：清单 `desktop.sessionMenu` → 插件 `ctx.desktop.sessionMenu`
 * → 协议方法 `mica/sessionMenu/run` → 插件拿到的会话信息与回传的正文。
 *
 * 用临时 MICA_HOME + 本地 mock provider，不碰真实配置与真实会话。
 */

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TEST_DIR, '..', '..', '..', '..');
const bunAvailable = process.env.MICA_BIN || spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
const suite = bunAvailable ? describe : describe.skip;

type HostMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};

type Host = {
  child: ChildProcess;
  home: string;
  lines: HostMessage[];
  waiters: Array<{ predicate: (m: HostMessage) => boolean; resolve: (m: HostMessage) => void }>;
  stderr: string;
  closePromise: Promise<unknown>;
};

function createMockProvider() {
  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    req.on('data', () => undefined);
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const emit = (event: Record<string, unknown>) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      emit({ type: 'response.created', response: { id: 'resp_1', object: 'response' } });
      emit({
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] },
      });
      emit({
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: '收到',
      });
      emit({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '收到' }],
        },
      });
      emit({
        type: 'response.completed',
        response: {
          id: 'resp_1',
          object: 'response',
          status: 'completed',
          output: [],
          usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
        },
      });
      res.end();
    });
  });
  return { server };
}

const MENU_PLUGIN_MODULE = `
export default function setup(ctx) {
  ctx.desktop.sessionMenu({
    run: async () => {
      const session = ctx.session.describe();
      const messages = ctx.session.messages();
      return {
        copyText: [session.cwd, session.model, session.provider, String(messages.length)].join('|'),
        message: '已复制',
      };
    },
  });
}
`;

function makeHome(tag: string, baseUrl: string, manifest: Record<string, unknown>, source = MENU_PLUGIN_MODULE) {
  const home = join(tmpdir(), `mica-session-menu-${process.pid}-${tag}`);
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
  const pluginDir = join(home, 'plugins', 'menu-fixture');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(pluginDir, 'index.js'), source, 'utf8');
  return home;
}

const MENU_MANIFEST = {
  id: 'menu-fixture',
  name: 'Copy Fixture',
  version: '0.1.0',
  main: 'index.js',
  requires: ['desktop', 'session'],
  desktop: { sessionMenu: [{ action: 'copy', label: '复制会话' }] },
};

function spawnHost(home: string): Host {
  const cwd = join(home, 'work');
  mkdirSync(cwd, { recursive: true });
  const child = spawn(
    process.env.MICA_BIN ?? 'bun',
    [...(process.env.MICA_BIN ? [] : ['apps/cli/src/index.ts']), 'app-server', '--dir', cwd],
    {
      cwd: ROOT,
      env: { ...process.env, MICA_HOME: home, MICA_PLUGIN_DESKTOP_HOST: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const host: Host = { child, home, lines: [], waiters: [], stderr: '', closePromise: Promise.resolve() };
  host.closePromise = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
  let buffer = '';
  child.stdout?.on('data', (chunk) => {
    buffer += chunk.toString();
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: HostMessage;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      host.lines.push(message);
      for (const waiter of [...host.waiters]) {
        if (waiter.predicate(message)) {
          host.waiters.splice(host.waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    }
  });
  child.stderr?.on('data', (chunk) => (host.stderr += chunk.toString()));
  return host;
}

function waitFor(host: Host, predicate: (m: HostMessage) => boolean, label: string, timeoutMs = 30_000) {
  const existing = host.lines.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise<HostMessage>((resolve, reject) => {
    const waiter = {
      predicate,
      resolve: (message: HostMessage) => {
        clearTimeout(timer);
        resolve(message);
      },
    };
    const timer = setTimeout(() => {
      const index = host.waiters.indexOf(waiter);
      if (index >= 0) host.waiters.splice(index, 1);
      reject(
        new Error(
          `timeout waiting for ${label}; received:\n  ${host.lines
            .map((m) => m.method ?? `resp:${m.id}`)
            .join('\n  ')}\nstderr:\n${host.stderr.slice(-1200)}`,
        ),
      );
    }, timeoutMs);
    host.waiters.push(waiter);
  });
}

async function send(host: Host, id: number, method: string, params: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    host.child.stdin!.write(`${JSON.stringify({ id, method, params })}\n`, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

const hostReady = (m: HostMessage) => m.method === 'mica/backgroundTasks/updated' || m.method === 'error';

suite('会话右键菜单动作（用户插件 + mock provider）', () => {
  it('插件拿得到当前会话信息，回传的正文直接交给客户端写剪贴板', async () => {
    const provider = createMockProvider();
    await new Promise<void>((resolve) => provider.server.listen(0, '127.0.0.1', resolve));
    const { port } = provider.server.address() as AddressInfo;
    const home = makeHome('copy', `http://127.0.0.1:${port}/v1`, MENU_MANIFEST);
    const host = spawnHost(home);
    try {
      await waitFor(host, hostReady, 'host ready');

      await send(host, 1, 'turn/start', { threadId: '', input: [{ type: 'text', text: '你好' }] });
      const turn = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started');
      const turnId = (turn.params?.turn as { id?: string }).id;
      await waitFor(
        host,
        (m) => m.method === 'turn/completed' && (m.params?.turn as { id?: string })?.id === turnId,
        'turn completed',
      );

      await send(host, 2, 'mica/sessionMenu/run', { pluginId: 'user.menu-fixture', action: 'copy' });
      const response = await waitFor(host, (m) => m.id === 2, 'session menu run');
      const result = response.result as {
        ok: boolean;
        pluginId?: string;
        copyText?: string;
        message?: string;
        error?: string;
      };
      expect(result.ok, result.error).toBe(true);
      expect(result.pluginId).toBe('user.menu-fixture');
      expect(result.message).toBe('已复制');
      const [path, model, providerId, messageCount] = String(result.copyText).split('|');
      expect(realpathSync(String(path))).toBe(realpathSync(join(home, 'work')));
      expect(model).toBe('mock-chat');
      expect(providerId).toBe('mock');
      // 一轮「你好」+ 一条回答
      expect(messageCount).toBe('2');
    } finally {
      host.child.kill('SIGKILL');
      await host.closePromise;
      rmSync(home, { recursive: true, force: true });
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    }
  }, 90_000);

  it('清单没声明的动作一律拒绝', async () => {
    const provider = createMockProvider();
    await new Promise<void>((resolve) => provider.server.listen(0, '127.0.0.1', resolve));
    const { port } = provider.server.address() as AddressInfo;
    const home = makeHome(
      'undeclared',
      `http://127.0.0.1:${port}/v1`,
      // 清单里没有 sessionMenu，插件却去注册。
      {
        id: 'menu-fixture',
        name: 'Copy Fixture',
        version: '0.1.0',
        main: 'index.js',
        requires: ['desktop', 'session'],
      },
    );
    const host = spawnHost(home);
    try {
      await waitFor(host, hostReady, 'host ready');
      await send(host, 1, 'mica/sessionMenu/run', { pluginId: 'user.menu-fixture', action: 'copy' });
      const response = await waitFor(host, (m) => m.id === 1, 'session menu run');
      const result = response.result as { ok: boolean; error?: string };
      expect(result.ok).toBe(false);
      expect(result.error).toContain('不可用');
    } finally {
      host.child.kill('SIGKILL');
      await host.closePromise;
      rmSync(home, { recursive: true, force: true });
      await new Promise<void>((resolve) => provider.server.close(() => resolve()));
    }
  }, 90_000);
});
