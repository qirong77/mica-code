import { describe, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtyDriver } from '@packages/mica-pty/index.js';

/**
 * PTY end-to-end test for the `/btw` command. Drives the real `dist/mica` TUI
 * against a local mock OpenAI responses provider. After a normal turn, it fires
 * `/btw 这个方案可行吗` and asserts the旁路 notice appears (with the question and
 * the answer, and a `/btw -continue` affordance) without breaking the main flow.
 *
 *   bun run build
 *   npx vitest run packages/mica-builtin-commands/tests/btw.pty.test.ts
 */
const BIN = process.env.MICA_PTY_BIN ?? join(process.cwd(), 'dist', 'mica');
const enabled = existsSync(BIN);
const suite = enabled ? describe : describe.skip;

type ScriptStep = { kind: 'tool'; name: string; args: Record<string, unknown> } | { kind: 'text'; text: string };

function createMockProvider(script: ScriptStep[]) {
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
              usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
            },
          });
          emit({
            type: 'response.done',
            response: {
              id: 'resp_done',
              object: 'response',
              status: 'completed',
              usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
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

suite('/btw PTY end-to-end (mock provider)', () => {
  it('shows a旁路 notice with the answer and a -continue affordance after /btw <q>', async () => {
    const mock = createMockProvider([
      { kind: 'text', text: '收到。' },
      { kind: 'text', text: '可行，但需注意边界。' },
      { kind: 'text', text: '继续回答：这里要注意缓存失效。' },
    ]);
    await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
    const { port } = mock.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/v1`;

    const home = mkdtempSync(join(tmpdir(), 'mica-btw-pty-home-'));
    const wd = mkdtempSync(join(tmpdir(), 'mica-btw-pty-wd-'));
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

      // turn 1: 一个正常回合
      await driver.typeText('开始', 15);
      driver.enter();
      const t1 = await driver.waitTurnCompleted(0, { timeoutMs: 90_000 });
      if (t1 !== 'completed') fail(`turn1 未完成: ${String(t1)}`);

      // /btw：一条旁路问题，主流程不等待
      await driver.typeText('/btw 这个方案可行吗', 15);
      driver.enter();

      // 等待旁路 notice 出现
      const gotBtw = await driver.waitFor(/这个方案可行吗/, { timeoutMs: 90_000 });
      if (!gotBtw) fail('未看到 btw 问题');
      const gotAnswer = await driver.waitFor(/可行，但需注意边界/, { timeoutMs: 90_000 });
      if (!gotAnswer) fail('未看到 btw 回答');
      const gotContinue = await driver.waitFor(/\/btw -continue/, { timeoutMs: 30_000 });
      if (!gotContinue) fail('未看到 /btw -continue 提示');

      // /btw -continue：复用同一个子代理，主流程不受影响
      await driver.typeText('/btw -continue 那缓存怎么办', 15);
      driver.enter();
      const gotFollowUp = await driver.waitFor(/这里要注意缓存失效/, { timeoutMs: 90_000 });
      if (!gotFollowUp) fail('未看到 btw 跟进回答');

      // 主流程仍在，且 btw 子代理发出了一个请求
      if (mock.state.requests.length < 3) {
        fail(`应有 ≥3 个请求（主回合 + btw + btw 跟进），实际 ${mock.state.requests.length}`);
      }
    } finally {
      await driver.close('SIGKILL', 1_000).catch(() => undefined);
      await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    }
  }, 600_000);
});
