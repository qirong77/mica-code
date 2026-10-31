#!/usr/bin/env node
/** Local Responses SSE fixture for reproducible screenshots; never calls a model. */
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BASE_QUEUE, BASE_TESTS, ABORT_QUEUE, ABORT_TESTS } from './prepare-doc-demo.mjs';

const updateFile = (path, before, after) => `*** Update File: ${path}\n@@\n${before.trimEnd().split('\n').map((line) => `-${line}`).join('\n')}\n${after.trimEnd().split('\n').map((line) => `+${line}`).join('\n')}\n`;
export const DEMO_PATCH = `*** Begin Patch\n${updateFile('src/task-queue.mjs', BASE_QUEUE, ABORT_QUEUE)}${updateFile('test/task-queue.test.mjs', BASE_TESTS, ABORT_TESTS)}*** End Patch`;

const milestones = ['确认串行执行与失败恢复行为', '为任务队列补充 AbortSignal 支持', '验证取消行为与原有测试'];
const todos = (statuses) => ({ name: 'todo_write', args: { todos: milestones.map((content, index) => ({ content, status: statuses[index] })) } });
const guard = `node -e 'const fs = require("node:fs"); const path = require("node:path"); const root = fs.realpathSync("../.."); const marker = JSON.parse(fs.readFileSync(path.join(root, ".mica-docs-demo.json"), "utf8")); const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")); if (marker.kind !== "mica-docs-demo" || marker.version !== 1 || marker.root !== root || fs.realpathSync(process.cwd()) !== path.join(root, "workspace", "task-queue") || pkg.name !== "task-queue-demo" || pkg.private !== true) throw new Error("Use the prepared isolated demo workspace"); console.log("Isolated documentation fixture confirmed");'`;
const QUEUE_STEPS = [
  { reason: '先确认当前目录是独立演示仓库，再查看队列和测试。', calls: [{ name: 'run_shell', args: { command: guard, timeout_ms: 10000 } }] },
  { reason: '把工作分为行为确认、取消支持和验证三步。读取现有实现，保留 FIFO 与失败恢复语义。', calls: [
    todos(['in_progress', 'pending', 'pending']),
    { name: 'grep_search', args: { pattern: 'TaskQueue|queue.add|test\\(', path: '.', include: '*.mjs', head_limit: 40 } },
    { name: 'read_file', args: { file_path: 'src/task-queue.mjs', limit: 120 } },
    { name: 'read_file', args: { file_path: 'test/task-queue.test.mjs', limit: 160 } },
  ] },
  { reason: '增加可选 signal：排队期间取消会跳过任务；运行中的任务通过收到的 signal 协作退出，队列等待清理完成。', calls: [
    todos(['completed', 'in_progress', 'pending']),
    { name: 'apply_patch', args: { patch: DEMO_PATCH } },
  ] },
  { reason: '实现和三条取消测试已写入。现在运行 Node 原生测试，并检查补丁空白错误。', calls: [
    todos(['completed', 'completed', 'in_progress']),
    { name: 'run_shell', args: { command: 'node --test --test-reporter=tap && git diff --check && git diff --stat', timeout_ms: 30000 } },
  ] },
  { reason: '根据工具返回核对测试数量与退出码，然后更新计划。', calls: [todos(['completed', 'completed', 'completed'])] },
  { text: `已为任务队列补充 **AbortSignal** 支持，改动保留在示例仓库中，尚未提交。

- \`add(task, { signal })\`：已取消的信号直接拒绝；排队中的任务取消后不会执行。
- 运行中的任务收到同一个 \`signal\`，可协作处理取消。队列等待它结束和清理，再启动下一项。
- 取消监听器在任务结束时移除，原有 FIFO 与失败后继续执行的行为保留。

\`node --test\` 的实际工具输出确认 **5 项测试通过、0 项失败**：原有 2 项，加上提前取消、排队取消和运行中取消 3 项。\`git diff --check\` 也已通过。

\`src/task-queue.mjs\` 和 \`test/task-queue.test.mjs\` 可在文件与变更面板继续查看。

> 此会话由本地演示脚本驱动；界面中的模型用量为演示占位值。` },
];
const READONLY_ROUNDS = [
  { key: 'fifo', match: /只读.*(?:FIFO|串行|设计)/i, steps: [
    { reason: '只读查看示例队列，说明串行调度的方式。', calls: [{ name: 'read_file', args: { file_path: 'src/task-queue.mjs', limit: 120 } }] },
    { text: '这个示例用一条 Promise 链串起任务。每个任务接到队尾，前一个任务结束后才运行下一个；单个任务失败不会阻断后续任务。\n\n取消正在运行的任务需要任务自身配合：signal 通知取消，清理完成后队列继续。可结合主会话中的实际实现与测试查看。\n\n> 本地脚本演示；模型用量为演示占位值。' },
  ] },
  { key: 'tests', match: /只读.*(?:测试|边界|取消)/i, steps: [
    { reason: '只读查看测试文件，整理取消行为应覆盖的边界。', calls: [{ name: 'read_file', args: { file_path: 'test/task-queue.test.mjs', limit: 180 } }] },
    { text: '取消行为需要覆盖三个时间点：提交前已经取消、等待执行时取消、开始执行后取消。运行中取消还应确认后续任务会等待清理结束。\n\n同时保留 FIFO 与失败恢复测试，防止引入取消支持时破坏原有行为。测试是否通过，以主会话执行 node --test 的真实输出为准。\n\n> 本地脚本演示；模型用量为演示占位值。' },
  ] },
];

function plainText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => part?.text ?? '').join('\n');
  return JSON.stringify(value ?? '');
}

/** Derive the next step from this turn's real outputs, without shared cursors. */
export function selectStep(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  let start = -1;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (input[index]?.role === 'user') { start = index; break; }
  }
  const prompt = start < 0 ? '' : plainText(input[start].content);
  const round = READONLY_ROUNDS.find((item) => item.match.test(prompt)) ?? { key: 'queue', steps: QUEUE_STEPS };
  const outputs = input.slice(start + 1).filter((item) => item?.type === 'function_call_output' && String(item.call_id).startsWith(`call_demo_${round.key}_`));
  let next = 0;
  for (const output of outputs) {
    const match = String(output.call_id).match(/^call_demo_[a-z]+_s(\d+)_/);
    if (match) next = Math.max(next, Number(match[1]) + 1);
    const text = plainText(output.output);
    if (/工具执行失败|工具.*(?:不存在|未找到)|Tool execution failed|exit_code:\s*(?:[1-9]\d*|null)\b/i.test(text)) {
      return { key: round.key, index: next, text: `演示在真实工具执行处停止，尚不能报告任务完成或测试通过。请检查工具返回，确认工作目录来自 prepare-doc-demo.mjs；若已运行过补丁，使用全新示例目录再试。\n\n工具返回：\n\n\`\`\`text\n${text.slice(0, 1800)}\n\`\`\`` };
    }
  }
  if (round.key === 'queue' && next >= 4) {
    const result = outputs.find((item) => String(item.call_id).includes('_s3_') && /# tests\s+5\b/.test(plainText(item.output)));
    const text = plainText(result?.output);
    if (!/# pass\s+5\b/.test(text) || !/# fail\s+0\b/.test(text) || !/exit_code:\s*0\b/.test(text)) {
      return { key: round.key, index: next, text: '补丁工具已返回，但没有收到可核实的 5 项测试通过、0 项失败与成功退出码。请查看 node --test 的真实输出；本次不报告测试通过。' };
    }
  }
  return { key: round.key, index: next, ...round.steps[Math.min(next, round.steps.length - 1)] };
}

export function startDemoProvider({ port = Number(process.env.MICA_DEMO_PROVIDER_PORT || 8898), delayScale = Number(process.env.MICA_DEMO_DELAY_SCALE ?? 1) } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid provider port');
  if (!Number.isFinite(delayScale) || delayScale < 0) throw new Error('Invalid MICA_DEMO_DELAY_SCALE');
  const delay = (ms) => new Promise((done) => setTimeout(done, ms * delayScale));
  let requestCount = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: 'scripted-demo', usage: 'placeholder' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mica-demo', object: 'model' }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/responses') { res.writeHead(404).end(); return; }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(raw); }
      catch { res.writeHead(400).end('Invalid JSON'); return; }
      const step = selectStep(body);
      const serial = ++requestCount;
      const responseId = `resp_demo_${serial}`;
      console.log(`[demo] request=${serial} round=${step.key} step=${step.index}`);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const emit = (event) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
      const output = [];
      emit({ type: 'response.created', response: { id: responseId, object: 'response', status: 'in_progress', output: [] } });
      emit({ type: 'response.in_progress', response: { id: responseId, object: 'response', status: 'in_progress' } });
      if (step.reason) {
        const id = `rs_demo_${serial}`;
        emit({ type: 'response.reasoning_summary_text.delta', item_id: id, output_index: 0, summary_index: 0, delta: step.reason });
        emit({ type: 'response.reasoning_summary_text.done', item_id: id, output_index: 0, summary_index: 0, text: step.reason });
      }
      await delay(450);
      if (step.text) {
        const item = { id: `msg_demo_${serial}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: step.text, annotations: [] }] };
        emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
        for (const chunk of step.text.match(/[\s\S]{1,16}/g) ?? []) {
          if (res.destroyed) return;
          emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: chunk });
          await delay(18);
        }
        emit({ type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: step.text });
        emit({ type: 'response.output_item.done', output_index: 0, item });
        output.push(item);
      } else {
        for (const [index, call] of step.calls.entries()) {
          const item = { id: `fc_demo_${serial}_${index}`, type: 'function_call', status: 'completed', call_id: `call_demo_${step.key}_s${step.index}_${serial}_${index}`, name: call.name, arguments: JSON.stringify(call.args) };
          emit({ type: 'response.output_item.added', output_index: index, item: { ...item, status: 'in_progress', arguments: '' } });
          emit({ type: 'response.function_call_arguments.delta', output_index: index, item_id: item.id, delta: item.arguments });
          emit({ type: 'response.function_call_arguments.done', output_index: index, item_id: item.id, arguments: item.arguments });
          emit({ type: 'response.output_item.done', output_index: index, item });
          output.push(item);
          await delay(220);
        }
      }
      // Explicit zero placeholders, not measured token counts or cache metrics.
      const response = { id: responseId, object: 'response', status: 'completed', output, usage: { input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, total_tokens: 0 } };
      emit({ type: 'response.completed', response });
      emit({ type: 'response.done', response });
      res.end();
    });
  });
  server.listen(port, '127.0.0.1', () => console.log(`Scripted demo provider: http://127.0.0.1:${server.address().port}/v1 (usage: demo placeholders)`));
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  startDemoProvider({ port: Number(process.argv[2] || process.env.MICA_DEMO_PROVIDER_PORT || 8898) });
}
