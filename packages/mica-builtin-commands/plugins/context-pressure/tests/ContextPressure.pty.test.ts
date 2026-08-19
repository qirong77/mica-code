import { describe, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtyDriver } from '@packages/mica-pty/index.js';

/**
 * PTY end-to-end test for the context-pressure plugin. Drives the real
 * interactive `dist/mica` TUI against a local mock OpenAI responses provider
 * that reports a red-zone usage (850k tokens on a 1M window) after the first
 * turn. The plugin must then auto-inject a reminder user message, which shows
 * up in the provider history of the next request.
 *
 *   bun run build   # first, produces dist/mica
 *   npx vitest run plugins/builtin/context-pressure/tests/ContextPressure.pty.test.ts
 */
const BIN = process.env.MICA_PTY_BIN ?? join(process.cwd(), 'dist', 'mica');
const enabled = existsSync(BIN);
const suite = enabled ? describe : describe.skip;

type ScriptStep = { kind: 'tool'; name: string; args: Record<string, unknown> } | { kind: 'text'; text: string };

function createMockProvider(script: ScriptStep[], usageTokens: number) {
  const state = { script, scriptIndex: 0, requests: [] as Array<{ model: string; input: unknown[]; tools: unknown[] }> };
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/v1/responses')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk.toString()));
      req.on('end', () => {
        let parsed: { model?: string; input?: unknown[]; tools?: unknown[] } = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          // keep defaults
        }
        const step = state.script[state.scriptIndex];
        state.scriptIndex++;
        state.requests.push({ model: parsed.model ?? '', input: parsed.input ?? [], tools: parsed.tools ?? [] });

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const emit = (event: Record<string, unknown>) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        const emitCompleted = () => {
          emit({
            type: 'response.completed',
            response: {
              id: 'resp_done',
              object: 'response',
              status: 'completed',
              usage: { input_tokens: usageTokens, output_tokens: 5, total_tokens: usageTokens + 5 },
            },
          });
          emit({
            type: 'response.done',
            response: {
              id: 'resp_done',
              object: 'response',
              status: 'completed',
              usage: { input_tokens: usageTokens, output_tokens: 5, total_tokens: usageTokens + 5 },
            },
          });
        };
        if (!step || step.kind === 'text') {
          const text = step && step.kind === 'text' ? step.text : '（无更多脚本步骤）';
          emit({ type: 'response.created', response: { id: 'resp_1', object: 'response' } });
          emit({ type: 'response.in_progress', response: { id: 'resp_1', object: 'response' } });
          emit({ type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
          emit({ type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text });
          emit({ type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text });
          emit({ type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text }] } });
          emitCompleted();
          res.end();
          return;
        }
        const callId = `call_${state.scriptIndex}`;
        const argumentsText = JSON.stringify(step.args);
        emit({ type: 'response.created', response: { id: 'resp_2', object: 'response' } });
        emit({ type: 'response.in_progress', response: { id: 'resp_2', object: 'response' } });
        emit({
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: 'fc_1', type: 'function_call', status: 'in_progress', call_id: callId, name: step.name, arguments: '' },
        });
        emit({
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          item_id: 'fc_1',
          delta: argumentsText.slice(0, Math.floor(argumentsText.length / 2)),
        });
        emit({
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          item_id: 'fc_1',
          delta: argumentsText.slice(Math.floor(argumentsText.length / 2)),
        });
        emit({ type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_1', arguments: argumentsText });
        emit({
          type: 'response.output_item.done',
          output_index: 0,
          item: { id: 'fc_1', type: 'function_call', status: 'completed', call_id: callId, name: step.name, arguments: argumentsText },
        });
        emitCompleted();
        res.end();
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  return { server, state };
}

function allRequestText(state: ReturnType<typeof createMockProvider>['state']): string {
  return JSON.stringify(state.requests);
}

suite('context-pressure PTY end-to-end (mock provider)', () => {
  it('auto-injects a compression reminder when context turns red', async () => {
    const mock = createMockProvider(
      [
        { kind: 'text', text: '第一轮回复。' },
        { kind: 'text', text: '已收到提醒。' },
      ],
      850_000,
    );
    await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
    const { port } = mock.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/v1`;

    const home = mkdtempSync(join(tmpdir(), 'mica-cp-pty-home-'));
    const wd = mkdtempSync(join(tmpdir(), 'mica-cp-pty-wd-'));
    mkdirSync(join(home, 'sessions'), { recursive: true });
    const wdReal = realpathSync(wd);
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        providers: [{ id: 'mock', name: 'Mock', api_base: baseUrl, protocol: 'openai_responses', api_key: 'test' }],
        serperApiKey: '',
        mcpServers: {},
      }),
    );
    writeFileSync(
      join(home, 'storage.json'),
      JSON.stringify({
        version: 1,
        lastUsedByDirectory: {
          [wd]: { provider: 'mock', model: 'mock-chat', effort: 'none' },
          [wdReal]: { provider: 'mock', model: 'mock-chat', effort: 'none' },
        },
      }),
    );

    const driver = PtyDriver.spawn([BIN], {
      cols: 140,
      rows: 40,
      cwd: wd,
      env: { MICA_HOME: home, MICA_NO_DAEMON: '1' },
      logPath: join(home, 'pty.raw'),
    });

    const fail = (stage: string, extra = '') => {
      driver.close('SIGKILL', 1_000).catch(() => undefined);
      throw new Error(`${stage}\n--- TUI 输出尾部 ---\n${driver.latestScreen(30_000)}${extra ? `\n--- ${extra} ---` : ''}`);
    };

    try {
      const booted = await driver.waitFor(/Type something|start a conversation/, { timeoutMs: 90_000 });
      if (!booted) fail('TUI 未启动');

      // turn 1: plain reply with red-zone usage (850k / 1M = 85%)
      const pos1 = driver.text().length;
      await driver.typeText('开始', 15);
      driver.enter();
      const t1 = await driver.waitTurnCompleted(pos1, { timeoutMs: 90_000 });
      if (t1 !== 'completed') fail(`turn1 未完成: ${String(t1)}`, `requests=${allRequestText(mock.state).slice(0, 2_000)}`);

      // The plugin injects the reminder right when turn 1 finishes, so the
      // reminder turn may already be active by the time we check; wait for its
      // reply (mock step 2) in the full buffer instead of tracking positions.
      const gotReply = await driver.waitFor(/已收到提醒/, { timeoutMs: 90_000 });
      if (!gotReply) fail('提醒回复轮未完成', `requests=${allRequestText(mock.state).slice(0, 2_000)}`);

      const requestsText = allRequestText(mock.state);
      if (!requestsText.includes('系统自动提醒')) fail('提醒消息应注入到 provider 历史', requestsText.slice(0, 4_000));
      if (!requestsText.includes('session_compact')) fail('提醒文本应提到 session_compact');
      if (mock.state.requests.length !== 2) {
        fail(`应有 2 个请求（对话轮 + 提醒回复轮），实际 ${mock.state.requests.length}`, requestsText.slice(0, 4_000));
      }

      // The pending-input row shows the displayText; the full reminder text
      // goes only to the provider. (full buffer; the live screen window can
      // catch mid-redraw frames)
      if (!driver.text().includes('系统提醒') || !driver.text().includes('建议压缩')) {
        fail('TUI 应显示提醒消息');
      }

      // turn 3: user continues; usage stays red, but no duplicate reminder
      const pos3 = driver.text().length;
      await driver.typeText('继续', 15);
      driver.enter();
      const t3 = await driver.waitTurnCompleted(pos3, { timeoutMs: 90_000 });
      if (t3 !== 'completed') fail(`turn3 未完成: ${String(t3)}`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      if (mock.state.requests.length !== 3) {
        fail(`红色区间不应重复提醒（应共 3 个请求），实际 ${mock.state.requests.length}`);
      }
    } finally {
      await driver.close('SIGKILL', 1_000).catch(() => undefined);
      await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    }
  }, 600_000);
});
