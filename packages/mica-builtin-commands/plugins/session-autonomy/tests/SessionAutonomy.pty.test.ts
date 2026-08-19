import { describe, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtyDriver } from '@packages/mica-pty/index.js';

/**
 * PTY end-to-end test for the session-autonomy plugin. Drives the real
 * interactive `dist/mica` TUI against a local mock OpenAI responses provider,
 * so no real API key is needed.
 *
 *   bun run build   # first, produces dist/mica
 *   npx vitest run plugins/builtin/session-autonomy/tests/SessionAutonomy.pty.test.ts
 *
 * Override the binary with MICA_PTY_BIN if dist/mica is not what you want.
 */
const BIN = process.env.MICA_PTY_BIN ?? join(process.cwd(), 'dist', 'mica');
const enabled = existsSync(BIN);
const suite = enabled ? describe : describe.skip;

type ScriptStep = { kind: 'tool'; name: string; args: Record<string, unknown> } | { kind: 'text'; text: string };

// 长回复：配合 turn2 的大 grep_search 工具输出（UI 只渲染工具行，不渲染
// tool result），让 lightweight prune 有可裁剪的大块内容。
const LONG_REPLY = Array.from({ length: 40 }, (_, i) => {
  const items = [
    '这是第 ' + (i + 1) + ' 条长回复内容，用于累积历史文本。',
    '项目背景：一个终端 code agent，基于 Bun、TypeScript、React 和 Ink。',
    '关键约束：append-only 会话历史、稳定 prompt 前缀、上下文压力明显时才 compact。',
    '架构边界：mica-agent 只做 provider 适配与 prompt 构建，mica-ui 不直接调用 provider。',
    '工具注册：运行期产品工具由内置插件通过 ctx.tools.register() 注册，可声明 primaryAgentOnly。',
    '会话自治：模型可以观察会话状态、在上下文压力明显时压缩历史。',
    '验证习惯：日常只跑局部测试，全量测试约 7-8 分钟，发布前才跑。',
  ];
  return `# 段落 ${i + 1}\n` + items.join('\n');
}).join('\n\n');

function createMockProvider(script: ScriptStep[]) {
  const state = {
    script,
    scriptIndex: 0,
    requests: [] as Array<{ model: string; input: unknown[]; tools: unknown[]; instructions?: string }>,
    logPath: '',
    // 工具调用后保持流打开一小段，让 TUI 有时间渲染工具行（否则 Ink 帧
    // 合并会跳过中间帧，工具行断言不稳定）。
    delayToolEndMs: 150,
  };
  const server: Server = createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/v1/responses')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk.toString()));
      req.on('end', () => {
        let parsed: { model?: string; input?: unknown[]; tools?: unknown[]; instructions?: string } = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          // keep defaults
        }
        const step = state.script[state.scriptIndex];
        state.scriptIndex++;
        state.requests.push({
          model: parsed.model ?? '',
          input: parsed.input ?? [],
          tools: parsed.tools ?? [],
          instructions: parsed.instructions,
        });
        if (state.logPath) {
          appendFileSync(
            state.logPath,
            `req#${state.requests.length} step=${state.scriptIndex - 1} ${step ? step.kind + ':' + (step.kind === 'tool' ? step.name : step.text) : 'NONE'}\n`,
          );
        }

        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const emit = (event: Record<string, unknown>) => res.write(`data: ${JSON.stringify(event)}\n\n`);
        const emitCompleted = () => {
          emit({
            type: 'response.completed',
            response: { id: 'resp_done', object: 'response', status: 'completed', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
          });
          emit({
            type: 'response.done',
            response: { id: 'resp_done', object: 'response', status: 'completed', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
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
        // function_call step
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
        if (state.delayToolEndMs > 0) {
          setTimeout(() => {
            emitCompleted();
            res.end();
          }, state.delayToolEndMs);
        } else {
          emitCompleted();
          res.end();
        }
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  return { server, state };
}

function latestSessionFile(home: string): string {
  const dir = join(home, 'sessions');
  if (!existsSync(dir)) throw new Error(`no sessions dir under ${home}`);
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(dir, name))
    .sort((a, b) => b.localeCompare(a));
  if (files.length === 0) throw new Error('no session files yet');
  return files[0]!;
}

function readLatestSession(home: string): { messages: unknown[]; turnState?: string } {
  const raw = JSON.parse(readFileSync(latestSessionFile(home), 'utf-8')) as {
    turnState?: string;
    snapshot?: { messages?: unknown[] };
  };
  return { messages: raw.snapshot?.messages ?? [], turnState: raw.turnState };
}

function allRequestText(state: ReturnType<typeof createMockProvider>['state']): string {
  return JSON.stringify(state.requests);
}

async function waitForFile(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (predicate()) return true;
    } catch {
      // file not ready yet
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function sendTurn(driver: PtyDriver, text: string): Promise<number> {
  // 等待 TUI 完全空闲（status 行不再显示运行中状态）再输入，避免字符
  // 在上一轮收尾（turn:after / UI 重绘）期间到达输入框而被吞掉。
  const deadline = Date.now() + 10_000;
  for (;;) {
    const tail = driver.latestScreen(8_000);
    if (!/waiting_model|thinking|streaming|calling_tool/.test(tail)) break;
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // 等 PTY 输出完全静止再输入：turn 收尾（状态行 completed 帧、notice、
  // session_* 工具应用后的 UI 替换）是异步渲染的，直接输入会在输入框重建
  // 期间丢字符，且迟到的 completed 帧会让 waitTurnCompleted 误判上一轮完成。
  await driver.waitIdle(250, 10_000);
  const pos = driver.text().length;
  await driver.typeText(text, 15);
  driver.enter();
  // 确认提交成功（active 状态出现）。turn 收尾会重置输入框，字符先到、
  // enter 后到时会撞上空输入框被静默丢弃；此时补发一次 enter。
  const submitDeadline = Date.now() + 2_000;
  for (;;) {
    const tail = driver.latestScreen(8_000);
    if (/waiting_model|thinking|streaming|calling_tool/.test(tail)) break;
    if (Date.now() > submitDeadline) {
      if (driver.latestScreen(8_000).includes(text)) driver.enter();
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return pos;
}

suite('session-autonomy PTY end-to-end (mock provider)', () => {
  it('observes and compacts via the session tools', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mica-sa-pty-home-'));
    const wd = mkdtempSync(join(tmpdir(), 'mica-sa-pty-wd-'));
    const BIG_FILE = join(wd, 'big.txt');
    writeFileSync(
      BIG_FILE,
      Array.from({ length: 300 }, (_, i) => `line ${i + 1} ` + '内容填充'.repeat(25)).join('\n'),
    );
    const mock = createMockProvider([
      // turn 1: long assistant reply seeds the history
      { kind: 'text', text: LONG_REPLY },
      // turn 2: grep_search returns a big tool output (prunable)
      { kind: 'tool', name: 'grep_search', args: { pattern: 'line', path: BIG_FILE, head_limit: 200 } },
      { kind: 'text', text: '已搜索。' },
      // turn 3: compact registration
      { kind: 'tool', name: 'session_compact', args: { preview: false } },
      { kind: 'text', text: '已登记压缩。' },
      // turn 4: plain turn; compact was applied at turn 3's end (turn:after)
      { kind: 'text', text: '继续。' },
      // turn 5: verify the guidance and tool definitions persist
      { kind: 'text', text: '继续。' },
    ]);
    await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
    const { port } = mock.server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/v1`;

    mock.state.logPath = join(home, 'requests.log');
    mkdirSync(join(home, 'sessions'), { recursive: true });
    // macOS /var is a symlink to /private/var; the compiled binary may resolve
    // cwd to the real path, so seed both spellings of the directory key.
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
    const assertScreen = (cond: boolean, message: string) => {
      if (!cond) fail(message);
    };

    try {
      const booted = await driver.waitFor(/Type something|start a conversation/, { timeoutMs: 90_000 });
      assertScreen(booted, 'TUI 未启动');

      // ---- turn 1: long reply seeds history ----
      const sendPos1 = await sendTurn(driver, '开始');
      const t1 = await driver.waitTurnCompleted(sendPos1, { timeoutMs: 90_000 });
      assertScreen(t1 === 'completed', `turn1 未完成: ${String(t1)}`);

      const screen1 = driver.latestScreen(60_000);
      // UI 消息渲染只保留长回复尾部，断言检查末尾段落
      assertScreen(screen1.includes('这是第40条长回复内容'), 'turn1 应显示长回复');

      const toolRequests = allRequestText(mock.state);
      for (const name of ['session_info', 'session_compact']) {
        assertScreen(toolRequests.includes(name), `provider 请求应包含 ${name} 工具定义`);
      }
      assertScreen(
        (mock.state.requests[0]?.instructions ?? '').includes('会话自治'),
        'provider 请求应包含会话自治引导',
      );
      assertScreen(!toolRequests.includes('session_history'), '不应再注册 session_history 工具');
      assertScreen(!toolRequests.includes('session_rewrite'), '不应再注册 session_rewrite 工具');
      assertScreen(!toolRequests.includes('session_set_prompt'), '不应再注册 session_set_prompt 工具');

      // ---- turn 2: grep_search (big prunable tool output) ----
      const sendPos2 = await sendTurn(driver, '搜索文件内容');
      const t2 = await driver.waitTurnCompleted(sendPos2, { timeoutMs: 90_000 });
      assertScreen(t2 === 'completed', `turn2 未完成: ${String(t2)}`);
      // 工具行渲染依赖 Ink 帧时序（太快会合并掉中间帧），不断言 UI 行；
      // 改为验证 grep_search 工具结果确实进入了下一请求的 provider 历史。
      assertScreen(
        JSON.stringify(mock.state.requests[2]?.input ?? []).includes('内容填充'),
        'turn2 的 grep 工具结果应进入 provider 历史',
      );

      // ---- turn 3: compact registration ----
      const sendPos3 = await sendTurn(driver, '帮我压缩上下文');
      const t3 = await driver.waitTurnCompleted(sendPos3, { timeoutMs: 90_000 });
      assertScreen(t3 === 'completed', `turn3 未完成: ${String(t3)}`);
      assertScreen(
        JSON.stringify(mock.state.requests[4]?.input ?? []).includes('session_compact'),
        'turn3 的 compact 登记结果应进入 provider 历史',
      );

      // ---- turn 4: compact applied at turn 3's end; history now compacted ----
      const sendPos4 = await sendTurn(driver, '继续');
      const t4 = await driver.waitTurnCompleted(sendPos4, { timeoutMs: 90_000 });
      assertScreen(t4 === 'completed', `turn4 未完成: ${String(t4)}`);
      assertScreen(
        await waitForFile(
          () => JSON.stringify(readLatestSession(home).messages).includes('[Mica compact boundary]'),
          15_000,
        ),
        'compact 应用后历史应包含 boundary',
      );

      const screen4 = driver.latestScreen(60_000);
      assertScreen(screen4.includes('session_compact: 完成'), 'turn4 UI 应显示 compact 完成通知');

      // ---- turn 5: verify guidance stays in the prompt ----
      const sendPos5 = await sendTurn(driver, '继续');
      assertScreen(
        await waitForFile(() => mock.state.requests.length >= 7, 30_000),
        'turn5 应发出请求（先等新 turn 真正启动，避免 completed 帧误判）',
      );
      const t5 = await driver.waitTurnCompleted(sendPos5, { timeoutMs: 90_000 });
      assertScreen(t5 === 'completed', `turn5 未完成: ${String(t5)}`);

      const lastRequests = allRequestText(mock.state);
      assertScreen(
        (mock.state.requests.at(-1)?.instructions ?? '').includes('会话自治'),
        '后续请求应仍含会话自治引导',
      );
      assertScreen(lastRequests.includes('session_info'), '后续请求应仍含 session 工具定义');
      // 7 main-agent steps, nothing extra
      assertScreen(mock.state.requests.length === 7, `请求总数应为 7，实际 ${mock.state.requests.length}`);
    } finally {
      await driver.close('SIGKILL', 1_000).catch(() => undefined);
      await new Promise<void>((resolve) => mock.server.close(() => resolve()));
    }
  }, 900_000);
});
