#!/usr/bin/env bun
/** Local, deterministic soak checks. No external service or user configuration is used. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import { CompactionService, isCompactionNotNeededError } from '../packages/mica-context/CompactionService.ts';
import { createPluginBackgroundScheduler } from '../packages/mica-plugin/PluginBackground.ts';
import { acquireProcessLock } from '../packages/mica-common/processLock.ts';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const durationSeconds = Number(args.get('--seconds') ?? 7200);
const intervalMs = Number(args.get('--interval-ms') ?? 1000);
const root = resolve(args.get('--output') ?? `/tmp/mica-plugin-soak-${process.pid}`);
assert(Number.isFinite(durationSeconds) && durationSeconds > 0, '--seconds must be positive');
assert(Number.isFinite(intervalMs) && intervalMs >= 20, '--interval-ms must be at least 20');
assert(process.env.MICA_HOME && resolve(process.env.MICA_HOME).startsWith(root + '/'), 'Set an isolated MICA_HOME under --output');
mkdirSync(root, { recursive: true, mode: 0o700 });
mkdirSync(process.env.MICA_HOME, { recursive: true, mode: 0o700 });
const startedAt = new Date().toISOString();
const started = performance.now();
const delay = monitorEventLoopDelay({ resolution: 20 });
delay.enable();
let stopped = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; });
let seed = Number(args.get('--seed') ?? 0x5eed1234) >>> 0;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000; };
const failures = [];
const samples = [];
const counters = { rounds: 0, assertions: 0, backgroundTicks: 0, injectedErrors: 0, lockAcquisitions: 0, summaries: 0, lastHeartbeatTick: 0 };
const scheduler = createPluginBackgroundScheduler({
  pluginId: 'local-soak',
  onError: (_taskId, error) => {
    counters.injectedErrors++;
    if (error.message !== 'Expected fault injection') failures.push({ at: new Date().toISOString(), error: String(error) });
  },
});
scheduler.register({
  id: 'heartbeat', every: 1000, immediate: true,
  run({ signal, tick }) {
    assert(!signal.aborted);
    assert.equal(tick, counters.lastHeartbeatTick + 1, 'Scheduler repeated a failed attempt number');
    counters.lastHeartbeatTick = tick;
    counters.backgroundTicks++;
    if (tick % 17 === 0) throw new Error('Expected fault injection');
  },
});
const service = new CompactionService();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const check = (condition, message) => { counters.assertions++; assert(condition, message); };
function historyFor(round, protocol, count) {
  const history = [];
  for (let i = 0; i < count; i++) {
    const id = `call-${round}-${i}`;
    const question = `Keep constraint ${i}: preserve source paths and verification. 中文约束。`;
    const payload = `result-${i}\n` + 'abcdefgh中文'.repeat(40 + Math.floor(random() * 1800));
    const args = JSON.stringify({ file_path: `/tmp/soak-${i}.txt`, content: 'data'.repeat(100 + i % 200) });
    if (protocol === 'chat') {
      history.push({ role: 'user', content: question });
      history.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'write_file', arguments: args } }] });
      history.push({ role: 'tool', tool_call_id: id, content: payload });
      history.push({ role: 'assistant', content: `Verified ${i}.` });
    } else {
      history.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: question }] });
      history.push({ type: 'function_call', call_id: id, name: 'write_file', arguments: args });
      history.push({ type: 'function_call_output', call_id: id, output: payload });
      history.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Verified ${i}.` }] });
    }
  }
  history.push(protocol === 'chat'
    ? { role: 'user', content: `LATEST_REQUEST_${round}: continue the remaining work without losing my constraints.` }
    : { type: 'message', role: 'user', content: [{ type: 'input_text', text: `LATEST_REQUEST_${round}: continue the remaining work without losing my constraints.` }] });
  return history;
}
function persistSummary(status) {
  const ordered = samples.map(sample => sample.compactMs).sort((a, b) => a - b);
  const percentile = p => ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * p))] ?? 0;
  writeFileSync(join(root, 'summary.json'), JSON.stringify({
    status, startedAt, finishedAt: new Date().toISOString(), elapsedSeconds: (performance.now() - started) / 1000,
    requestedSeconds: durationSeconds, seed, ...counters, failureCount: failures.length,
    failures: failures.slice(-50), samples: samples.length,
    compactionLatencyMs: { p50: percentile(.5), p95: percentile(.95), max: ordered.at(-1) ?? 0 },
    firstMemory: samples[0]?.memory, lastMemory: samples.at(-1)?.memory,
    eventLoopDelayMs: { mean: Number(delay.mean) / 1e6 || 0, max: Number(delay.max) / 1e6 || 0 },
  }, null, 2) + '\n');
}
console.log(JSON.stringify({ event: 'started', startedAt, durationSeconds, root, pid: process.pid, seed }));
writeFileSync(join(root, 'started.json'), JSON.stringify({ startedAt, durationSeconds, root, pid: process.pid, seed }, null, 2) + '\n');
while (!stopped && performance.now() - started < durationSeconds * 1000) {
  const roundStart = performance.now();
  const roundSeed = seed;
  const round = ++counters.rounds;
  let compactMs = 0;
  try {
    const protocol = round % 2 ? 'chat' : 'responses';
    const history = historyFor(round, protocol, [6, 24, 96][round % 3]);
    const before = hash(history);
    const compactStart = performance.now();
    const quick = await service.compact({ messages: history, options: { toolResultsOnly: true, preserveRecentMessages: 8, preserveLatestUserMessage: true } });
    compactMs = performance.now() - compactStart;
    check(hash(history) === before, 'Compaction mutated the input history');
    check(quick.messages.length === history.length, 'Quick compaction changed turn count');
    check(hash(quick.messages.slice(-8)) === hash(history.slice(-8)), 'Unread recent tool messages changed');
    check(quick.savedTokenEstimate > 0, 'Representative history did not shrink');
    check(hash(quick.messages.at(-1)) === hash(history.at(-1)), 'Latest user request changed');
    for (let i = 0; i < quick.messages.length - 1; i += 4) {
      const tool = quick.messages[i + 1];
      const output = quick.messages[i + 2];
      const argumentsText = protocol === 'chat' ? tool.tool_calls[0].function.arguments : tool.arguments;
      const parsed = JSON.parse(argumentsText);
      check(parsed.file_path === `/tmp/soak-${i / 4}.txt`, 'Tool argument path was lost');
      check((protocol === 'chat' ? tool.tool_calls[0].id === output.tool_call_id : tool.call_id === output.call_id), 'Tool pair identity changed');
    }
    try {
      const again = await service.compact({ messages: quick.messages, options: { toolResultsOnly: true, preserveRecentMessages: 8, preserveLatestUserMessage: true } });
      check(hash(again.messages) === hash(quick.messages), 'Quick compaction is not idempotent');
    } catch (error) {
      check(isCompactionNotNeededError(error), 'Idempotent compaction failed unexpectedly');
    }
    if (round % 30 === 0) {
      const result = await service.compact({
        messages: history,
        summarize: async () => '<summary>## Current Work\nKeep source paths and constraints.\n## Pending Tasks\nContinue current request.</summary>',
        options: { force: true, preserveRecentMessages: 8, preserveLatestUserMessage: true, contextWindowSize: 128000 },
      });
      counters.summaries++;
      check(JSON.stringify(result.messages).includes(`LATEST_REQUEST_${round}`), 'Model summary dropped latest user request');
      check(result.afterTokenEstimate < result.beforeTokenEstimate, 'Model summary expanded representative history');
    }
    if (round % 20 === 0) {
      const singleTurn = [history.at(-1), ...history.filter((_message, index) => index < history.length - 1 && index % 4 !== 0)];
      const originalUser = hash(singleTurn[0]);
      const result = await service.compact({
        messages: singleTurn,
        summarize: async () => '<summary>Preserve the exact active requirement; earlier tool work is complete.</summary>',
        options: { force: true, preserveRecentMessages: 8, preserveLatestUserMessage: true, contextWindowSize: 16000 },
      });
      counters.summaries++;
      check(result.messages.filter(message => hash(message) === originalUser).length === 1, 'Latest request was lost or duplicated in a long turn');
      check(hash(result.messages.slice(-8)) === hash(singleTurn.slice(-8)), 'Latest tool batch changed during summary');
      check(result.afterTokenEstimate < result.beforeTokenEstimate, 'Single-turn summary did not reduce context');
    }
    const lockFile = join(root, 'contention.lock');
    const release = acquireProcessLock(lockFile);
    check(typeof release === 'function', 'Cannot acquire an uncontended lock');
    try { check(acquireProcessLock(lockFile) === null, 'Two lock holders admitted'); } finally { release?.(); }
    counters.lockAcquisitions++;
    const transient = createPluginBackgroundScheduler({ pluginId: `cycle-${round}`, onError: () => { throw new Error('Unexpected transient scheduler error'); } });
    const registration = transient.register({ id: 'noop', every: 1000, run() {} });
    check(transient.list().length === 1, 'Registration missing');
    registration.dispose();
    registration.dispose();
    check(transient.list().length === 0, 'Disposed registration leaked');
    transient.disposeAll();
  } catch (error) {
    const failure = { round, seed: roundSeed, at: new Date().toISOString(), error: error?.stack ?? String(error) };
    failures.push(failure);
    appendFileSync(join(root, 'failures.jsonl'), JSON.stringify(failure) + '\n');
    console.error(JSON.stringify({ event: 'failure', ...failure }));
  }
  if (round % 60 === 0) globalThis.Bun?.gc(true);
  const sample = { round, at: new Date().toISOString(), elapsedSeconds: (performance.now() - started) / 1000, compactMs, memory: process.memoryUsage(), scheduler: scheduler.list(), failureCount: failures.length };
  samples.push(sample);
  appendFileSync(join(root, 'samples.jsonl'), JSON.stringify(sample) + '\n');
  if (round === 1 || round % 60 === 0) {
    persistSummary('running');
    console.log(JSON.stringify({ event: 'checkpoint', round, elapsedSeconds: sample.elapsedSeconds, failureCount: failures.length, rssMiB: Math.round(sample.memory.rss / 1048576), compactMs }));
  }
  await pause(Math.max(0, intervalMs - (performance.now() - roundStart)));
}
scheduler.disposeAll();
delay.disable();
persistSummary(stopped ? 'stopped' : failures.length ? 'failed' : 'completed');
console.log(JSON.stringify({ event: 'finished', elapsedSeconds: (performance.now() - started) / 1000, ...counters, failureCount: failures.length }));
process.exitCode = failures.length || stopped ? 1 : 0;
