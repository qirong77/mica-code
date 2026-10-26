/**
 * 脚本化的 OpenAI Responses 兼容 provider，只用于生成 README / 文档截图与本地演示。
 *
 * 故意不接真实模型：截图需要稳定、可复现的对话形态（思考 → 工具 → 工具 → 总结），
 * 真实模型每次跑出来的内容都不一样。
 *
 * 每轮对话按「最后一条用户消息里的关键词」选一段脚本（`ROUNDS`），脚本里的每个步骤
 * 对应一次 provider 请求：`tool` 步骤产生函数调用（agent 会带着结果继续下一次请求），
 * `text` 步骤产出最终回答并把该段脚本的指针复位。
 *
 * 用法：
 *   node scripts/demo-mock-provider.mjs [port]        # 默认 8898
 *   MICA_HOME=<临时目录> mica                          # config 里把 provider 指向它
 *
 * 完整的截图流程见 AGENT.md「对外文档与演示素材」。
 */
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] || 8898);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ROUNDS = [
  {
    match: /可取消|cancel|AbortController/,
    steps: [
      {
        reason: '先看清事件总线现在怎么分发，再决定改动范围。',
        calls: [
          {
            name: 'grep_search',
            args: { pattern: 'emit\\(|dispatch\\(|subscribe\\(', path: 'packages/mica-runtime', include: '*.ts' },
          },
          { name: 'read_file', args: { file_path: 'packages/mica-runtime/events.ts', limit: 120 } },
        ],
      },
      {
        reason: '派发循环加 abort 检查，再用 patch 一次性落地。',
        calls: [
          {
            name: 'apply_patch',
            args: {
              patch:
                '*** Begin Patch\n*** Update File: packages/mica-runtime/events.ts\n@@ export class EventBus\n-    for (const handler of this.handlers.get(name) ?? []) handler(payload)\n+    for (const handler of this.handlers.get(name) ?? []) {\n+      if (signal?.aborted) return\n+      handler(payload)\n+    }\n*** End Patch',
            },
          },
          { name: 'run_shell', args: { command: 'bun run test -- packages/mica-runtime/events.test.ts', timeout_ms: 60 } },
        ],
      },
      {
        text: `改完了，三处变更都在 \`packages/mica-runtime\`：

1. **\`EventBus.emit\` 接受可选 \`signal\`**：每次派发前检查 \`signal.aborted\`，命中立即返回，已注册的 handler 不再被调用。
2. **\`subscribe\` 返回 dispose**：取消订阅由调用方持有，和 abort 走同一条退出路径。
3. **补了 3 条测试**：取消后不再派发、派发中途取消、重复 dispose 幂等。

\`\`\`ts
const controller = new AbortController()
bus.emit('tool:start', payload, { signal: controller.signal })
controller.abort() // 之后注册的 handler 不会再被触发
\`\`\`

\`\`\`bash
$ bun run test -- packages/mica-runtime/events.test.ts

 ✓ packages/mica-runtime/events.test.ts (12 tests) 84ms
   ✓ 取消后不再派发
   ✓ 派发中途取消
   ✓ 重复 dispose 幂等

 Test Files  1 passed (1)
      Tests  12 passed (12)
\`\`\`

没有改动 provider 层：\`emit\` 的旧签名仍然兼容，只是多了可选参数。`,
      },
    ],
  },
  {
    match: /lease|锁|跨进程/,
    steps: [
      {
        reason: '先确认 lease 的写入点和 release 时机。',
        calls: [
          {
            name: 'grep_search',
            args: { pattern: 'turn-lock|acquireTurnLease|turn:after', path: 'packages/mica-session' },
          },
          { name: 'read_file', args: { file_path: 'packages/mica-session/turnLocks.ts', limit: 160 } },
        ],
      },
      {
        text: `turn lease 的作用只有一个：**同一时刻只允许一个进程写同一条 session**。

它必须跨进程，因为同一条会话可能同时被 TUI、\`mica exec\`、桌面 app-server 打开——它们各自是独立进程，内存里的互斥完全看不见对方。

- 锁文件是 \`sessions/.turn-locks/<id>.lock\`，用 \`wx\` 抢占，写 owner pid
- 抢不到就拒绝启动这一轮，而不是排队等：两个写者交错刷新快照会直接把历史写坏
- 必须在 \`turn:after\` **之前**释放：插件在 \`turn:after\` 里提交下一轮时，会立刻来抢同一把锁
- 孤儿锁靠 pid 存活判定回收，pid 复用是已知边界

顺序是：拿 lease → \`refreshFromStore()\` → 跑 turn → 存盘 → 发 \`turn:after\` 前释放。`,
      },
    ],
  },
  {
    match: /缓存|cache|前缀/,
    steps: [
      {
        text: `缓存优先是 Mica 的结构性选择，不是某个开关。

**会话默认 append-only**：system prompt、角色、skills 索引、工具描述都固定在同一段前缀里，历史只往后追加，于是提供商的前缀缓存每一轮都能命中。

**改动会被显式隔离**：切角色、切模型、压缩历史都会重建前缀，所以它们都被放在明确的边界上（新 turn 之前、compact checkpoint 之后），不会在对话中间悄悄换掉前缀。

**压缩只碰工具结果**：默认的快速压缩把工具输出换占位符、把写文件正文裁掉，但对话文本和轮次顺序不变——前缀还能接着命中；需要模型摘要时才显式走 \`/compact llm\`。

实测的长会话里，输入侧缓存命中率稳定在 94%–99%，token 账单主要花在新追加的那一段上。`,
      },
    ],
  },
  {
    match: /typecheck|README|测试/,
    steps: [
      {
        reason: '先把任务拆成可执行的几步，再并行查两处线索。',
        calls: [
          {
            name: 'TodoWrite',
            args: {
              todos: [
                { content: '定位 event bus 的派发入口', status: 'completed', activeForm: '定位 event bus 的派发入口' },
                { content: '改造为可取消的派发', status: 'in_progress', activeForm: '改造为可取消的派发' },
                { content: '补取消语义的测试', status: 'pending', activeForm: '补取消语义的测试' },
                { content: '跑 typecheck 与相关测试', status: 'pending', activeForm: '跑 typecheck 与相关测试' },
              ],
            },
          },
          { name: 'grep_search', args: { pattern: 'emit\\(|dispatch\\(|subscribe\\(', path: 'packages/mica-runtime' } },
          { name: 'read_file', args: { file_path: 'packages/mica-runtime/events.ts', limit: 120 } },
        ],
      },
      {
        reason: '跑一遍类型检查和 runtime 的测试，确认没有回退。',
        calls: [{ name: 'run_shell', args: { command: 'bun run typecheck', timeout_ms: 180 } }],
      },
      {
        reason: '类型干净了，再跑一遍事件总线的测试。',
        calls: [
          {
            name: 'run_shell',
            args: { command: 'bun run test -- packages/mica-runtime/events.test.ts', timeout_ms: 120 },
          },
        ],
      },
      {
        text: `我先在后台跑一遍 typecheck，同时把派发改成可取消。

- \`EventBus.emit(name, payload, { signal })\`：每次派发前检查 \`signal.aborted\`，命中就立即返回
- \`subscribe\` 返回 dispose，取消订阅和 abort 走同一条退出路径
- 补三条测试：取消后不再派发、派发中途取消、重复 dispose 幂等

typecheck 结果出来后我再补测试，然后一起过一遍 \`packages/mica-runtime\` 的 README。`,
      },
    ],
  },
];

/** 每段脚本的步骤指针；text 步骤结束后复位，下一轮从头开始。 */
const cursors = new Map();

function pickRound(prompt) {
  return ROUNDS.find((round) => round.match.test(prompt)) ?? ROUNDS[0];
}

function lastUserText(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  for (let i = input.length - 1; i >= 0; i -= 1) {
    const item = input[i];
    const parts = Array.isArray(item?.content) ? item.content : [];
    const text = parts.map((part) => part?.text ?? '').join(' ');
    if (item?.role === 'user' && text.trim()) return text;
  }
  return '';
}

let requestCount = 0;

createServer((req, res) => {
  if (req.method === 'GET' && req.url?.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mica-demo', object: 'model' }] }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.includes('/responses')) {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', async () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      // 解析失败时按第一段脚本处理
    }
    requestCount += 1;
    const prompt = lastUserText(body);
    const round = pickRound(prompt);
    const key = ROUNDS.indexOf(round);
    const index = cursors.get(key) ?? 0;
    const step = round.steps[Math.min(index, round.steps.length - 1)];
    cursors.set(key, step.text ? 0 : index + 1);

    // 用量形状要真实：输入远大于输出、绝大部分命中缓存，状态栏才会显示合理的 ctx 占比。
    const inputTokens = 96000 + requestCount * 4200;
    const usage = {
      input_tokens: inputTokens,
      input_tokens_details: { cached_tokens: Math.round(inputTokens * 0.94) },
      output_tokens: 320,
      total_tokens: inputTokens + 320,
    };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);

    emit({ type: 'response.created', response: { id: 'resp_1', object: 'response' } });
    emit({ type: 'response.in_progress', response: { id: 'resp_1', object: 'response' } });

    const finish = () => {
      emit({
        type: 'response.completed',
        response: { id: 'resp_done', object: 'response', status: 'completed', usage },
      });
      emit({ type: 'response.done', response: { id: 'resp_done', object: 'response', status: 'completed', usage } });
      res.end();
    };

    if (step.reason) {
      const id = `rs_${requestCount}`;
      emit({
        type: 'response.reasoning_summary_text.delta',
        item_id: id,
        output_index: 0,
        content_index: 0,
        delta: step.reason,
      });
      emit({
        type: 'response.reasoning_summary_text.done',
        item_id: id,
        output_index: 0,
        content_index: 0,
        text: step.reason,
      });
    }

    if (step.text) {
      const msgId = `msg_${requestCount}`;
      emit({
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
      });
      for (const chunk of step.text.match(/[\s\S]{1,12}/g) ?? []) {
        emit({ type: 'response.output_text.delta', item_id: msgId, output_index: 0, content_index: 0, delta: chunk });
        await delay(18);
      }
      emit({ type: 'response.output_text.done', item_id: msgId, output_index: 0, content_index: 0, text: step.text });
      emit({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: msgId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: step.text }],
        },
      });
      finish();
      return;
    }

    step.calls.forEach((call, callIndex) => {
      const callId = `call_${requestCount}_${callIndex}`;
      const itemId = `fc_${requestCount}_${callIndex}`;
      const args = JSON.stringify(call.args);
      emit({
        type: 'response.output_item.added',
        output_index: callIndex,
        item: {
          id: itemId,
          type: 'function_call',
          status: 'in_progress',
          call_id: callId,
          name: call.name,
          arguments: '',
        },
      });
      emit({ type: 'response.function_call_arguments.delta', output_index: callIndex, item_id: itemId, delta: args });
      emit({
        type: 'response.function_call_arguments.done',
        output_index: callIndex,
        item_id: itemId,
        arguments: args,
      });
      emit({
        type: 'response.output_item.done',
        output_index: callIndex,
        item: {
          id: itemId,
          type: 'function_call',
          status: 'completed',
          call_id: callId,
          name: call.name,
          arguments: args,
        },
      });
    });
    finish();
  });
}).listen(PORT, '127.0.0.1', () => console.log(`mock provider on http://127.0.0.1:${PORT}`));
