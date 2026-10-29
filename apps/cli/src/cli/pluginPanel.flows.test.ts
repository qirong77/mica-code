import { describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 对话右侧插件面板的端到端链路：用户插件加载 → `ctx.desktop.panel` → 协议方法
 * `mica/pluginPanel/view|action` → 插件把一段话投进会话（`mica/turn/input` + 会话文件里
 * 真的多出一条用户消息）。
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
  const requests: Array<{ input: unknown[]; instructions?: string }> = [];
  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk.toString()));
    req.on('end', () => {
      let parsed: { input?: unknown[]; instructions?: string } = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        // 保持默认
      }
      requests.push({ input: parsed.input ?? [], instructions: parsed.instructions });
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
        delta: '收到，开始处理',
      });
      emit({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: '收到，开始处理' }],
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
  return { server, requests };
}

const PANEL_PLUGIN_MODULE = `
export default function setup(ctx) {
  const state = () => ctx.sessionState.get() ?? {};
  ctx.desktop.panel({
    view: () => ({
      title: '巡检',
      subtitle: 'user.',
      status: state().running ? { label: '轮询中', tone: 'ok' } : { label: '待命', tone: 'muted' },
      sections: [
        {
          title: '频道',
          items: [{ key: 'a', label: '群 A', actions: [{ id: 'remove', label: '删除' }] }],
          fields: [{ key: 'target', label: '群名', value: state().target ?? '' }],
          actions: [{ id: 'submit', label: '开始巡检', tone: 'primary' }],
        },
      ],
    }),
    action: async (input) => {
      ctx.sessionState.set({ ...state(), target: input.values?.target ?? '', lastAction: input.action });
      if (input.action === 'submit') {
        await ctx.runtime.submit('【巡检】请检查频道更新', {
          source: 'plugin',
          displayText: '（插件）巡检：群 A',
        });
        return { message: '巡检已投递' };
      }
    },
  });
}
`;

function makeHome(tag: string, baseUrl: string, pluginSource = PANEL_PLUGIN_MODULE): string {
  const home = join(tmpdir(), `mica-plugin-panel-${process.pid}-${tag}`);
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
            effortLevels: ['low', 'medium', 'high'],
          },
        ],
      },
      null,
      2,
    ),
  );
  mkdirSync(join(home, 'sessions'), { recursive: true });
  mkdirSync(join(home, 'role'), { recursive: true });
  writeFileSync(join(home, 'role', '需求开发.md'), '你是需求开发。', 'utf8');
  const pluginDir = join(home, 'plugins', 'panel-fixture');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify(
      {
        id: 'panel-fixture',
        name: '巡检',
        version: '0.1.0',
        main: 'index.js',
        requires: ['desktop', 'runtime', 'sessionState', 'ui'],
        desktop: { panel: { label: '巡检', roles: ['需求开发'] } },
      },
      null,
      2,
    ),
  );
  writeFileSync(join(pluginDir, 'index.js'), pluginSource, 'utf8');
  return home;
}

function spawnHost(home: string): Host {
  const cwd = join(home, 'work');
  mkdirSync(cwd, { recursive: true });
  const child = spawn(
    process.env.MICA_BIN ?? 'bun',
    [...(process.env.MICA_BIN ? [] : ['apps/cli/src/index.ts']), 'app-server', '--dir', cwd],
    {
      cwd: ROOT,
      // `MICA_PLUGIN_DESKTOP_HOST=1` 是桌面端 spawn app-server 时注入的那个标记：没有它
      // 插件拿不到 `ctx.desktop`，整个插件会被 `requires: ['desktop']` 跳过。
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

function readOnlySession(home: string): {
  turnState?: string;
  snapshot?: { conversationMessages?: Array<{ role: string; content: unknown }> };
} {
  const files = readdirSync(join(home, 'sessions')).filter((file) => file.endsWith('.json'));
  expect(files).toHaveLength(1);
  return JSON.parse(readFileSync(join(home, 'sessions', files[0]!), 'utf8'));
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
    .join('');
}

suite('对话右侧插件面板（用户插件 + mock provider）', () => {
  it(
    '插件投递的轮次会以用户消息出现在会话记录里',
    async () => {
      const provider = createMockProvider();
      await new Promise<void>((resolve) => provider.server.listen(0, '127.0.0.1', resolve));
      const { port } = provider.server.address() as AddressInfo;
      const home = makeHome('panel', `http://127.0.0.1:${port}/v1`);
      const host = spawnHost(home);
      try {
        await waitFor(host, hostReady, 'host ready');

        // 先按「需求开发」角色跑一轮，让会话带上这个角色（面板的显示条件就是它）。
        await send(host, 1, 'turn/start', {
          threadId: '',
          input: [{ type: 'text', text: '你好' }],
          role: '需求开发',
        });
        const firstTurn = await waitFor(host, (m) => m.method === 'turn/started', 'turn/started');
        const firstTurnId = (firstTurn.params?.turn as { id?: string }).id;
        await waitFor(
          host,
          (m) => m.method === 'turn/completed' && (m.params?.turn as { id?: string })?.id === firstTurnId,
          'first turn completed',
        );

        // 视图：插件给数据，宿主只做归一化。
        await send(host, 2, 'mica/pluginPanel/view', { pluginId: 'user.panel-fixture' });
        const viewResponse = await waitFor(host, (m) => m.id === 2, 'panel view');
        const view = viewResponse.result as {
          ok: boolean;
          pluginId?: string;
          view?: { title: string; status?: { label: string }; sections?: Array<{ items?: unknown[] }> };
          error?: string;
        };
        expect(view.ok).toBe(true);
        expect(view.pluginId).toBe('user.panel-fixture');
        expect(view.view?.title).toBe('巡检');
        expect(view.view?.status?.label).toBe('待命');
        expect(view.view?.sections?.[0].items).toHaveLength(1);

        // 动作：插件把一段话投进会话。宿主先发 `mica/turn/input`（客户端没有乐观气泡），
        // 再发 turn/started——顺序反了页面会先把上一轮的文本当成本轮用户消息。
        await send(host, 3, 'mica/pluginPanel/action', {
          pluginId: 'user.panel-fixture',
          action: 'submit',
          values: { target: '群 A' },
        });
        const actionResponse = await waitFor(host, (m) => m.id === 3, 'panel action');
        expect((actionResponse.result as { ok: boolean }).ok).toBe(true);
        // 动作回一句话时页面显示在按钮旁边；没说就什么都不带。
        expect((actionResponse.result as { message?: string }).message).toBe('巡检已投递');

        const inputNotice = await waitFor(host, (m) => m.method === 'mica/turn/input', 'turn input notice');
        expect(inputNotice.params?.text).toBe('（插件）巡检：群 A');

        const secondTurn = await waitFor(
          host,
          (m) => m.method === 'turn/started' && (m.params?.turn as { id?: string })?.id !== firstTurnId,
          'plugin turn started',
        );
        const secondTurnId = (secondTurn.params?.turn as { id?: string }).id;
        await waitFor(
          host,
          (m) => m.method === 'turn/completed' && (m.params?.turn as { id?: string })?.id === secondTurnId,
          'plugin turn completed',
        );

        // 模型真的收到了这段话。
        const lastRequest = provider.requests[provider.requests.length - 1];
        expect(JSON.stringify(lastRequest?.input ?? [])).toContain('请检查频道更新');

        // 会话文件里多出一条用户消息，内容是插件给的 displayText。
        const session = readOnlySession(home);
        const userMessages = (session.snapshot?.conversationMessages ?? []).filter((m) => m.role === 'user');
        expect(userMessages.map((m) => textOf(m.content))).toEqual(['你好', '（插件）巡检：群 A']);
        expect(session.turnState).toBe('completed');
      } finally {
        host.child.kill('SIGKILL');
        await host.closePromise;
        rmSync(home, { recursive: true, force: true });
        await new Promise<void>((resolve) => provider.server.close(() => resolve()));
      }
    },
    90_000,
  );

  it(
    '没声明 desktop.panel 的插件拿不到面板入口',
    async () => {
      const provider = createMockProvider();
      await new Promise<void>((resolve) => provider.server.listen(0, '127.0.0.1', resolve));
      const { port } = provider.server.address() as AddressInfo;
      const home = makeHome(
        'no-panel',
        `http://127.0.0.1:${port}/v1`,
        // 插件仍然调用 `ctx.desktop.panel()`：宿主不该给这扇门。
        `export default function setup(ctx) {
           if (ctx.desktop?.panel) ctx.desktop.panel({ view: () => ({ title: '不该出现' }), action: () => {} });
           ctx.logger.info('panel', { hasPanel: Boolean(ctx.desktop?.panel) });
         }`,
      );
      // 清单里去掉 desktop.panel。
      writeFileSync(
        join(home, 'plugins', 'panel-fixture', 'plugin.json'),
        JSON.stringify(
          { id: 'panel-fixture', name: '巡检', version: '0.1.0', main: 'index.js', requires: ['desktop', 'ui'] },
          null,
          2,
        ),
      );
      const host = spawnHost(home);
      try {
        await waitFor(host, (m) => m.method === 'mica/backgroundTasks/updated', 'host ready');
        await send(host, 1, 'mica/pluginPanel/view', { pluginId: 'user.panel-fixture' });
        const response = await waitFor(host, (m) => m.id === 1, 'panel view');
        const result = response.result as { ok: boolean; error?: string };
        expect(result.ok).toBe(false);
        expect(result.error).toContain('面板不可用');
      } finally {
        host.child.kill('SIGKILL');
        await host.closePromise;
        rmSync(home, { recursive: true, force: true });
        await new Promise<void>((resolve) => provider.server.close(() => resolve()));
      }
    },
    90_000,
  );
});
