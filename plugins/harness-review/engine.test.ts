import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { appendFile, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'vitest';
import type { AgentObservationEvent } from '@packages/mica-plugin/index.js';
import {
  HarnessRecorder,
  expectedExit,
  similarity,
  splitPromptSections,
  summarizeDelegation,
  terminalProgram,
  type CaptureOptions,
  type RunSummary,
} from './engine.js';

const options: CaptureOptions = { captureContent: true, maxEventChars: 4000, maxEventsPerRun: 2000 };
const config = { providerId: 'test-provider', protocol: 'openai', model: 'test-model', effort: 'medium', role: 'main' };
const at = '2026-06-01T10:00:00.000Z';
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
type Input = { type: AgentObservationEvent['type']; [key: string]: unknown };

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), 'mica-harness-'));
  const root = join(temporary, 'capture');
  const errors: unknown[] = [];
  const recorder = new HarnessRecorder(root, (error) => {
    errors.push(error);
  });
  t.onTestFinished(async () => {
    await recorder.dispose();
    await rm(temporary, { recursive: true, force: true });
  });
  return { temporary, root, errors, recorder };
}
function runner(
  recorder: HarnessRecorder,
  settings: {
    owner?: object;
    runId?: number;
    cwd?: string;
    title?: string;
    capture?: CaptureOptions;
    timestamp?: string;
  } = {},
) {
  const owner = settings.owner ?? {};
  const session = {
    id: 'session',
    title: settings.title ?? 'Harness tests',
    cwd: settings.cwd ?? resolve('workspace-a'),
  };
  const emit = (event: Input): void =>
    recorder.observe(
      { owner, runId: settings.runId ?? 1, timestamp: settings.timestamp ?? at, ...event } as AgentObservationEvent,
      session,
      settings.capture ?? options,
    );
  return {
    emit,
    start: (input = 'Task input') => emit({ type: 'run:start', config, input }),
    finish: (outcome: 'completed' | 'aborted' | 'error' = 'completed', error?: string) =>
      emit({ type: 'run:finish', outcome, elapsedMs: 125, ...(error ? { error } : {}) }),
    call: (args = '{"path":"missing.txt"}', name = 'read_file', id = 'call-1') =>
      emit({ type: 'tool:call', name, args, id }),
    result: (result = '{"isError":true,"message":"ENOENT: no such file"}', name = 'read_file', id = 'call-1') =>
      emit({ type: 'tool:result', name, result, id }),
  };
}
async function trace(run: RunSummary): Promise<Record<string, unknown>[]> {
  const text = await readFile(run.traceFile, 'utf8');
  return text.trim()
    ? text
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
}

// 子运行（委派 / helper）的 runId 是负数：早先版本按「必须非负」校验，会把它们整份
// 当成损坏记录丢掉，报告里既没有委派树也没有 helper 汇总。
test('keeps child runs that use negative run IDs', async (t) => {
  const { recorder, errors } = await fixture(t);
  const cwd = resolve('workspace-a');
  const main = runner(recorder, { runId: 1, cwd });
  main.start('主会话');
  main.finish();
  const helper = runner(recorder, { runId: -1, cwd });
  helper.emit({ type: 'run:start', config, input: 'summarize', helper: { kind: 'compaction' } });
  helper.emit({ type: 'request:start', messageCount: 2 });
  helper.finish();

  const report = await recorder.review(cwd);
  assert.deepEqual(
    report.runs.map((run) => run.sourceRunId).sort((a, b) => a - b),
    [-1, 1],
  );
  assert.equal(report.helpers.total, 1);
  assert.equal(report.helpers.kinds[0].kind, 'compaction');
  assert.deepEqual(
    report.warnings.filter((warning) => warning.includes('corrupt')),
    [],
  );
  assert.deepEqual(errors, []);
});

test('parallel owners with the same source run ID and overlapping tool IDs remain isolated', async (t) => {
  const { recorder, root, errors } = await fixture(t);
  const cwdA = resolve('workspace-a');
  const cwdB = resolve('workspace-b');
  const a = runner(recorder, { cwd: cwdA });
  const b = runner(recorder, { cwd: cwdB });
  a.start('First task');
  b.start('Second task');
  a.call('{"path":"a"}');
  b.call('{"path":"b"}');
  a.result();
  b.result('{"success":true,"content":"Error is a class in this source file"}');
  a.emit({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3 } });
  b.emit({ type: 'usage', usage: { inputTokens: 20, outputTokens: 7 } });
  await Promise.all([
    Promise.resolve().then(() => a.finish('error', 'ENOENT')),
    Promise.resolve().then(() => b.finish()),
  ]);
  const report = await recorder.review();
  assert.equal(report.runs.length, 2);
  assert.equal(new Set(report.runs.map((run) => run.id)).size, 2);
  const runA = report.runs.find((run) => run.cwd === cwdA)!;
  const runB = report.runs.find((run) => run.cwd === cwdB)!;
  assert.equal(runA.toolErrors, 1);
  assert.equal(runB.toolErrors, 0);
  assert.equal(runA.outcome, 'error');
  assert.equal(runB.outcome, 'completed');
  assert.equal(runA.inputTokens, 10);
  assert.equal(runB.inputTokens, 20);
  assert.equal(runA.cachedInputTokens, 3);
  assert.equal(runB.cachedInputTokens, 0);
  for (const run of report.runs) {
    assert.equal(run.sourceRunId, 1);
    assert.equal(run.traceFile, join(root, 'runs', run.id, 'events.jsonl'));
    const events = await trace(run);
    assert.deepEqual(
      events.map((event) => event.seq),
      [1, 2, 3, 4, 5],
    );
    assert.equal(events.at(-1)?.type, 'run:finish');
  }
  assert.equal((await recorder.review(cwdA)).runs.length, 1);
  assert.equal((await recorder.review(resolve('unrelated-workspace'))).runs.length, 0);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(errors, []);
});

test('one owner can interleave multiple run IDs without mixing pending calls', async (t) => {
  const { recorder } = await fixture(t);
  const owner = {};
  const a = runner(recorder, { owner, runId: 1 });
  const b = runner(recorder, { owner, runId: 2 });
  a.start();
  b.start();
  a.call();
  b.call();
  a.result();
  b.result('Operation succeeded.');
  b.finish();
  a.finish();
  const report = await recorder.review();
  assert.equal(report.runs.find((run) => run.sourceRunId === 1)?.toolErrors, 1);
  assert.equal(report.runs.find((run) => run.sourceRunId === 2)?.toolErrors, 0);
});

test('findings aggregate across runs using canonical redacted arguments and decisions survive reload', async (t) => {
  const { recorder, root } = await fixture(t);
  const cwd = resolve('workspace-a');
  for (let index = 0; index < 2; index++) {
    const run = runner(recorder, { runId: index + 1, cwd });
    run.start();
    for (let call = 0; call < 3; call++) {
      run.call(
        index === 0
          ? '{"path":"missing.txt","api_key":"first-secret"}'
          : '{"api_key":"second-secret","path":"missing.txt"}',
      );
      run.result();
    }
    run.emit({ type: 'retry', attempt: 1, delayMs: 50, error: 'request timed out' });
    run.finish('error', 'request timed out');
  }
  const report = await recorder.review(cwd);
  assert.equal(report.findings.length, 4);
  assert.equal(report.findings.find((finding) => finding.kind === 'tool-error')?.occurrences, 6);
  assert.equal(report.findings.find((finding) => finding.kind === 'repeated-call')?.occurrences, 2);
  assert.equal(report.findings.find((finding) => finding.kind === 'retry')?.occurrences, 2);
  assert.equal(report.findings.find((finding) => finding.kind === 'run-error')?.occurrences, 2);
  const finding = report.findings.find((item) => item.kind === 'tool-error')!;
  assert.equal(new Set(finding.evidence.map((item) => item.runId)).size, 2);
  await recorder.decide(finding.id, 'accepted', 'Try a preflight check; api_key=private-note-value');
  const reloaded = new HarnessRecorder(root);
  t.onTestFinished(() => reloaded.dispose());
  const updated = await reloaded.review(cwd);
  const accepted = updated.findings.find((item) => item.id === finding.id)!;
  assert.equal(accepted.status, 'accepted');
  assert.match(accepted.note!, /REDACTED/);
  assert.ok(!accepted.note!.includes('private-note-value'));
  assert.ok(accepted.updatedAt);
  assert.ok(updated.runs.every((run) => run.outcome === 'error'));
  await reloaded.decide(finding.id, 'validated', 'Comparable replay passed an independent check.');
  assert.equal((await recorder.review()).findings.find((item) => item.id === finding.id)?.status, 'validated');
  await assert.rejects(recorder.decide('../escape', 'accepted', 'invalid'), /Invalid finding ID/);
  await assert.rejects(recorder.decide(finding.id, 'invented' as 'open', 'invalid'), /Invalid finding status/);
});

test('redaction precedes truncation and resolved prompts are represented only by hash and character count', async (t) => {
  const { recorder, root } = await fixture(t);
  const run = runner(recorder);
  const prompt = 'PRIVATE RESOLVED PROMPT: secret instructions never captured';
  run.start();
  run.emit({ type: 'prompt:resolved', prompt });
  run.emit({ type: 'prompt:resolved', prompt });
  const args = JSON.stringify({
    path: 'file.txt',
    api_key: 'key-object-secret',
    nested: { password: 'nested-secret' },
    command: 'curl -H "Authorization: Bearer bearer-secret-value" https://user:uri-password@example.com',
    image_data: 'private-image-content',
  });
  run.call(args, 'run_shell');
  run.result(
    'sk-proj-abcdefghijk123456\nghp_abcdefghijk123456\nCookie: session=private-cookie\n' + 'A'.repeat(300),
    'run_shell',
  );
  run.finish();
  const report = await recorder.review();
  const summary = report.runs[0];
  assert.deepEqual(summary.promptHashes, [{ sha256: sha(prompt), chars: prompt.length }]);
  const events = await trace(summary);
  assert.deepEqual(events.find((event) => event.type === 'prompt:resolved')?.prompt, {
    sha256: sha(prompt),
    chars: prompt.length,
  });
  const persisted =
    (await readFile(summary.traceFile, 'utf8')) +
    (await readFile(join(root, 'runs', summary.id, 'summary.json'), 'utf8'));
  for (const secret of [
    prompt,
    'key-object-secret',
    'nested-secret',
    'bearer-secret-value',
    'uri-password',
    'private-image-content',
    'sk-proj-abcdefghijk123456',
    'ghp_abcdefghijk123456',
    'private-cookie',
    'A'.repeat(300),
  ])
    assert.ok(!persisted.includes(secret), secret);
  assert.match(persisted, /REDACTED/);
  assert.ok(!JSON.stringify(report).includes(prompt));
});

test('metadata capture omits content while retaining useful counts, hashes, and outcomes', async (t) => {
  const { recorder, root } = await fixture(t);
  const run = runner(recorder, {
    title: 'Private task-derived title canary',
    capture: { ...options, captureContent: false },
  });
  run.start('private task input');
  run.emit({ type: 'request:start', messageCount: 4, tools: ['tool-definition-private'] });
  run.call('{"text":"private tool argument"}');
  run.result('Error: private tool failure');
  run.emit({ type: 'retry', attempt: 2, delayMs: 100, error: 'private provider failure' });
  run.finish('error', 'private final failure');
  const report = await recorder.review();
  const summary = report.runs[0];
  const events = await trace(summary);
  const payloads = [
    events[0].input,
    events[1].tools,
    events[2].args,
    events[3].result,
    events[4].error,
    events[5].error,
  ] as Record<string, unknown>[];
  for (const value of payloads) {
    assert.deepEqual(Object.keys(value).sort(), ['chars', 'sha256']);
    assert.match(value.sha256 as string, /^[a-f0-9]{64}$/);
    assert.ok((value.chars as number) > 0);
  }
  assert.equal(summary.error, undefined);
  assert.equal(summary.sessionTitle, null);
  assert.equal(summary.requestCount, 1);
  assert.equal(summary.toolErrors, 1);
  assert.equal(summary.retries, 1);
  const persisted =
    (await readFile(summary.traceFile, 'utf8')) +
    (await readFile(join(root, 'runs', summary.id, 'summary.json'), 'utf8'));
  for (const text of [
    'Private task-derived title canary',
    'private task input',
    'tool-definition-private',
    'private tool argument',
    'private tool failure',
    'private provider failure',
    'private final failure',
  ])
    assert.ok(!persisted.includes(text));
});

test('content truncation preserves full sanitized hashes and event limits still include final summary counters', async (t) => {
  const { recorder } = await fixture(t);
  const run = runner(recorder, { capture: { ...options, maxEventChars: 16, maxEventsPerRun: 2 } });
  const input = 'A long ordinary task input that needs truncation';
  run.start(input);
  run.call();
  run.result();
  run.emit({ type: 'usage', usage: { inputTokens: 12, outputTokens: 8 } });
  run.finish('error', 'A long ordinary final error that needs truncation');
  const report = await recorder.review();
  const summary = report.runs[0];
  const events = await trace(summary);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].input, {
    sha256: sha(input),
    chars: input.length,
    content: input.slice(0, 16),
    truncated: true,
  });
  assert.equal(summary.eventCount, 5);
  assert.equal(summary.droppedEvents, 3);
  assert.equal(summary.toolErrors, 1);
  assert.equal(summary.inputTokens, 12);
  assert.equal(summary.outputTokens, 8);
  assert.equal(summary.outcome, 'error');
  assert.equal(summary.finishedAt, at);
  assert.equal(summary.elapsedMs, 125);
  assert.equal(summary.error?.length, 16);
  assert.equal(summary.findings.find((finding) => finding.kind === 'run-error')?.evidence[0].seq, 5);
  assert.ok(summary.findings.every((finding) => finding.evidence.every((item) => item.available === false)));
  const persisted = JSON.parse(
    await readFile(join(report.root, 'runs', summary.id, 'summary.json'), 'utf8'),
  ) as RunSummary;
  assert.ok(persisted.findings.every((finding) => finding.evidence.every((item) => item.available === false)));
  const markdown = await readFile(await recorder.exportReport(), 'utf8');
  assert.match(markdown, /event 3 — evidence unavailable \(summary metadata only\)/);
  assert.match(markdown, /event 5 — evidence unavailable \(summary metadata only\)/);
  assert.ok(!markdown.includes(`[Run ${summary.id}, event 3]`));
  assert.ok(!markdown.includes(`[Run ${summary.id}, event 5]`));
  assert.ok(report.warnings.some((warning) => warning.includes('omitted 3')));
});

test('zero-event capture still creates a trace and stores the finish in its summary', async (t) => {
  const { recorder } = await fixture(t);
  const run = runner(recorder, { capture: { ...options, maxEventsPerRun: 0 } });
  run.start();
  run.finish();
  const report = await recorder.review();
  assert.equal(report.runs[0].outcome, 'completed');
  assert.equal(report.runs[0].droppedEvents, 2);
  assert.equal(await readFile(report.runs[0].traceFile, 'utf8'), '');
  assert.ok(!report.warnings.some((warning) => /missing|corrupt/.test(warning)));
});

test('a secret crossing the content limit is redacted before truncation and hashing', async (t) => {
  const { recorder } = await fixture(t);
  const run = runner(recorder, { capture: { ...options, maxEventChars: 12 } });
  run.start('api_key=boundary-secret-value');
  run.finish();
  const summary = (await recorder.review()).runs[0];
  const input = (await trace(summary))[0].input;
  const sanitized = 'api_key=[REDACTED]';
  assert.deepEqual(input, {
    sha256: sha(sanitized),
    chars: sanitized.length,
    content: sanitized.slice(0, 12),
    truncated: true,
  });
  assert.ok(!(await readFile(summary.traceFile, 'utf8')).includes('boundary'));
});

test('polling is excluded from repeated-call candidates and successful Error content is not a tool error', async (t) => {
  const { recorder } = await fixture(t);
  const run = runner(recorder);
  run.start();
  for (const name of ['functions.wait_for', 'background_tasks_read', 'background_tasks_list']) {
    for (let index = 0; index < 5; index++) {
      run.call('{"task_id":"same"}', name);
      run.result('{"status":"running"}', name);
    }
  }
  for (const content of [
    'The Error class is exported here.',
    'const text = "Error: example failure";',
    '{"success":true,"content":"Error: example failure"}',
    '{"exitCode":0,"stdout":"Error: test fixture"}',
  ]) {
    run.call();
    run.result(content);
  }
  run.finish();
  const report = await recorder.review();
  assert.equal(report.runs[0].toolErrors, 0);
  assert.ok(!report.findings.some((finding) => finding.kind === 'repeated-call' && finding.module !== 'read_file'));
  assert.ok(!report.findings.some((finding) => finding.kind === 'tool-error'));
});

test('explicit errors and nonzero exit metadata produce candidates without implying task failure', async (t) => {
  const { recorder } = await fixture(t);
  const run = runner(recorder);
  run.start();
  for (const result of [
    '{"isError":true,"message":"permission denied"}',
    '{"success":false,"error":"invalid argument"}',
    '{"status":"error","message":"timed out"}',
    '{"exitCode":2,"stdout":""}',
    'Process exited with code 1\nordinary output',
    'Tool execution failed: not found',
  ]) {
    run.call('{}', 'run_shell');
    run.result(result, 'run_shell');
  }
  run.finish();
  const report = await recorder.review();
  assert.equal(report.runs[0].toolErrors, 6);
  assert.equal(report.runs[0].outcome, 'completed');
  assert.ok(report.findings.every((finding) => finding.status === 'open'));
  assert.ok(!report.findings.some((finding) => finding.kind === 'run-error'));
  assert.match(report.interpretation, /Completed runs are not user validation/);
});

test('dispose interrupts unfinished runs, preserves completed outcomes, and ignores later events', async (t) => {
  const { recorder } = await fixture(t);
  const active = runner(recorder);
  const completed = runner(recorder, { runId: 2 });
  active.start();
  completed.start();
  completed.finish();
  await recorder.dispose();
  await recorder.dispose();
  active.finish();
  const report = await recorder.review();
  assert.equal(report.runs.length, 2);
  const interrupted = report.runs.find((run) => run.sourceRunId === 1)!;
  assert.equal(interrupted.outcome, 'interrupted');
  assert.ok(interrupted.finishedAt);
  assert.ok(interrupted.elapsedMs! >= 0);
  assert.equal(interrupted.eventCount, 1);
  assert.equal(report.runs.find((run) => run.sourceRunId === 2)?.outcome, 'completed');
  assert.ok(report.warnings.some((warning) => warning.includes('interrupted before a finish event')));
});

test('unknown events and duplicate start do not create extra runs, while running snapshots remain visible', async (t) => {
  const { recorder } = await fixture(t);
  const run = runner(recorder);
  run.call();
  run.finish();
  assert.equal((await recorder.review()).runs.length, 0);
  run.start();
  run.start();
  run.emit({ type: 'history:rewritten', beforeCount: 10, afterCount: 4 });
  const report = await recorder.review();
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].outcome, 'running');
  assert.equal(report.runs[0].eventCount, 2);
  assert.ok(report.warnings.some((warning) => warning.includes('no finish event')));
  const events = await trace(report.runs[0]);
  assert.equal(events[1].beforeCount, 10);
  assert.equal(events[1].afterCount, 4);
});

test('corrupt summaries, traces, and decisions generate warnings and do not hide healthy runs', async (t) => {
  const { recorder, root } = await fixture(t);
  const a = runner(recorder);
  a.start();
  a.call();
  a.result();
  a.finish();
  const b = runner(recorder, { runId: 2 });
  b.start();
  b.finish();
  let report = await recorder.review();
  const run = report.runs.find((item) => item.sourceRunId === 1)!;
  const other = report.runs.find((item) => item.sourceRunId === 2)!;
  const corrupt = join(root, 'runs', 'broken-run');
  await mkdir(corrupt);
  await writeFile(join(corrupt, 'summary.json'), '{broken');
  await writeFile(run.traceFile, '{invalid event\n');
  await rm(other.traceFile);
  await mkdir(join(root, 'decisions'), { recursive: true });
  await writeFile(join(root, 'decisions', `${run.findings[0].id}.json`), '{broken');
  report = await recorder.review();
  assert.equal(report.runs.length, 2);
  assert.ok(report.warnings.some((warning) => warning.includes('corrupt run broken-run')));
  assert.ok(report.warnings.some((warning) => warning.includes('corrupt trace at line 1')));
  assert.ok(report.warnings.some((warning) => warning.includes('missing or unreadable trace')));
  assert.ok(report.warnings.some((warning) => warning.includes('Unreadable decision')));
  assert.equal(report.findings[0].status, 'open');
});

test('invalid summary schemas and missing trace lines are reported', async (t) => {
  const { recorder, root } = await fixture(t);
  const run = runner(recorder);
  run.start();
  run.finish();
  const summary = (await recorder.review()).runs[0];
  await writeFile(summary.traceFile, '');
  assert.ok(
    (await recorder.review()).warnings.some((warning) =>
      warning.includes('trace has fewer events than its summary counts'),
    ),
  );
  const bad = { ...summary, toolCalls: -1 };
  await writeFile(join(root, 'runs', summary.id, 'summary.json'), JSON.stringify(bad));
  const report = await recorder.review();
  assert.equal(report.runs.length, 0);
  assert.ok(report.warnings.some((warning) => warning.includes('invalid summary schema')));
});

// 摘要每 25 条事件才落一次盘：宿主被杀掉的运行，轨迹会比摘要多几行。
// 那是摘要滞后，不是轨迹损坏——按损坏处理会让这些运行的证据永远不可用。
test('a trace that outran its summary checkpoint is not corrupt', async (t) => {
  const { recorder } = await fixture(t);
  const run = runner(recorder);
  run.start();
  run.finish();
  const summary = (await recorder.review()).runs[0];
  await appendFile(
    summary.traceFile,
    `${JSON.stringify({ seq: summary.eventCount + 1, type: 'usage', timestamp: at })}\n`,
  );
  const report = await recorder.review();
  assert.deepEqual(
    report.warnings.filter((warning) => warning.includes('corrupt trace') || warning.includes('fewer events')),
    [],
  );
});

test('all recorder directories and files have private permissions', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX file mode assertions');
    return;
  }
  const { recorder, root } = await fixture(t);
  const run = runner(recorder);
  run.start();
  run.call();
  run.result();
  run.finish();
  const report = await recorder.review();
  await recorder.decide(report.findings[0].id, 'dismissed', 'Expected failure.');
  const exported = await recorder.exportReport();
  for (const directory of [
    root,
    join(root, 'runs'),
    join(root, 'runs', report.runs[0].id),
    join(root, 'decisions'),
    join(root, 'reports'),
  ])
    assert.equal((await stat(directory)).mode & 0o777, 0o700, directory);
  for (const file of [
    report.runs[0].traceFile,
    join(root, 'runs', report.runs[0].id, 'summary.json'),
    join(root, 'decisions', `${report.findings[0].id}.json`),
    exported,
  ])
    assert.equal((await stat(file)).mode & 0o777, 0o600, file);
});

test('Markdown reports include scoped runs, aggregated evidence, manual decisions, and interpretation', async (t) => {
  const { recorder, root } = await fixture(t);
  const run = runner(recorder);
  run.start();
  run.call();
  run.result();
  run.finish();
  const outside = runner(recorder, { runId: 2, cwd: resolve('workspace-b') });
  outside.start();
  outside.finish();
  const report = await recorder.review(resolve('workspace-a'));
  await recorder.decide(report.findings[0].id, 'accepted', 'Check [input] <script>');
  const path = await recorder.exportReport(resolve('workspace-a'));
  assert.equal(path.startsWith(join(root, 'reports')), true);
  assert.match(path, /\.md$/);
  const text = await readFile(path, 'utf8');
  for (const phrase of [
    '# Harness review',
    '## Runs',
    '## Findings',
    '## Warnings',
    'Tool errors do not imply task failure',
    'Completed runs are not user validation',
    'Suggestion:',
    'Evaluation:',
    'Status: **accepted**',
    report.findings[0].id,
    '../runs/',
    'event 3',
  ])
    assert.ok(text.includes(phrase), phrase);
  assert.ok(text.includes('Check \\[input\\] \\<script\\>'));
  assert.ok(!text.includes('2 in scope'));
  const files = await readdir(join(root, 'reports'));
  assert.equal(files.length, 1);
});

test('empty reviews and exports are useful before the first run', async (t) => {
  const { recorder } = await fixture(t);
  const report = await recorder.review();
  assert.deepEqual(report.runs, []);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.scannedRuns, 0);
  const markdown = await readFile(await recorder.exportReport(), 'utf8');
  assert.match(markdown, /No runs in this scope/);
  assert.match(markdown, /No findings recorded/);
});

test('persistence failures are isolated from observe and explicit decisions reject their failed writes', async (t) => {
  const { temporary } = await fixture(t);
  const root = join(temporary, 'file-instead-of-directory');
  await writeFile(root, 'blocked');
  const errors: unknown[] = [];
  const recorder = new HarnessRecorder(root, (error) => {
    errors.push(error);
    throw new Error('callback failure');
  });
  t.onTestFinished(() => recorder.dispose());
  const run = runner(recorder);
  assert.doesNotThrow(() => {
    run.start();
    run.finish();
  });
  await recorder.flush();
  assert.ok(errors.length > 0);
  const report = await recorder.review();
  assert.ok(report.warnings.some((warning) => warning.includes('Persistence error')));
  await assert.rejects(recorder.decide('a'.repeat(64), 'accepted', 'Cannot persist.'));
  await assert.rejects(recorder.exportReport());
});

test('YAML literal and folded block secrets are redacted before single-line rules, including read_file line numbers', async (t) => {
  const { recorder, root } = await fixture(t);
  const run = runner(recorder);
  run.start();
  const canaries: string[] = [];
  const numberers: ((line: string, number: number) => string)[] = [
    (line) => line,
    (line, number) => `${number} | ${line}`,
    (line, number) => `${number}: ${line}`,
    (line, number) => `L${number}: ${line}`,
  ];
  for (const marker of ['|', '>', '|-', '|+', '|2', '|2-', '|-2', '>+', '>2+', '>+2']) {
    for (const numberLine of numberers) {
      const secret = `yaml-block-canary-${canaries.length}`;
      const second = `yaml-continuation-canary-${canaries.length}`;
      canaries.push(secret, second);
      const source = [
        '  password: ' + marker + ' # sensitive',
        `    123 | ${secret}`,
        '',
        `    ${second}`,
        '  public: retained-safe-value',
      ];
      const content = source.map((line, index) => numberLine(line, index + 100)).join('\n');
      run.call();
      run.result(content);
    }
  }
  canaries.push('minimal-yaml-password-canary');
  run.call();
  run.result('password: |\n  minimal-yaml-password-canary');
  run.finish();
  const report = await recorder.review();
  const summary = report.runs[0];
  const persisted =
    (await readFile(summary.traceFile, 'utf8')) +
    (await readFile(join(root, 'runs', summary.id, 'summary.json'), 'utf8'));
  const markdown = await readFile(await recorder.exportReport(), 'utf8');
  for (const canary of canaries) {
    assert.ok(!persisted.includes(canary), canary);
    assert.ok(!JSON.stringify(report).includes(canary), canary);
    assert.ok(!markdown.includes(canary), canary);
  }
  const results = (await trace(summary)).filter((event) => event.type === 'tool:result');
  for (const event of results.slice(0, -1))
    assert.match((event.result as { content: string }).content, /public: retained-safe-value/);
  const sanitized = 'password: [REDACTED]\n  [REDACTED]';
  assert.deepEqual(results.at(-1)?.result, {
    sha256: sha(sanitized),
    chars: sanitized.length,
    content: sanitized,
    truncated: false,
  });
});

test('accepted findings stay within their workspace while all finding kinds aggregate across its runs', async (t) => {
  const { recorder } = await fixture(t);
  const cwdA = resolve('workspace-a');
  const cwdB = resolve('workspace-b');
  const fail = (cwd: string, runId: number): void => {
    const run = runner(recorder, { cwd, runId });
    run.start();
    for (let index = 0; index < 3; index++) {
      run.call();
      run.result();
    }
    run.emit({ type: 'retry', attempt: 1, delayMs: 1, error: 'timed out' });
    run.finish('error', 'timed out');
  };
  fail(cwdA, 1);
  const original = await recorder.review(cwdA);
  assert.equal(original.findings.length, 4);
  for (const finding of original.findings) await recorder.decide(finding.id, 'accepted', 'Decision for workspace A');
  fail(cwdA, 2);
  fail(cwdB, 3);
  const a = await recorder.review(cwdA);
  const b = await recorder.review(cwdB);
  assert.equal(a.findings.length, 4);
  assert.equal(b.findings.length, 4);
  for (const finding of a.findings) {
    assert.equal(finding.status, 'accepted');
    assert.equal(new Set(finding.evidence.map((item) => item.runId)).size, 2);
    assert.equal(finding.occurrences, finding.kind === 'tool-error' ? 6 : 2);
  }
  for (const finding of b.findings) {
    assert.equal(finding.status, 'open');
    assert.equal(finding.note, undefined);
    assert.ok(!a.findings.some((item) => item.id === finding.id));
  }
  assert.equal((await recorder.review()).findings.length, 8);
});

test('capture and review canonicalize symlinked cwd and loaded summaries while nonexistent paths use resolve', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Symlink creation requires Windows privileges');
    return;
  }
  const { recorder, temporary, root } = await fixture(t);
  const workspace = join(temporary, 'workspace');
  const alias = join(temporary, 'workspace-link');
  await mkdir(workspace);
  await symlink(workspace, alias);
  const canonical = realpathSync.native(workspace);
  for (const [index, cwd] of [alias, workspace].entries()) {
    const run = runner(recorder, { cwd, runId: index + 1 });
    run.start();
    run.call();
    run.result();
    run.finish();
  }
  let report = await recorder.review(alias);
  assert.equal(report.cwd, canonical);
  assert.equal(report.runs.length, 2);
  assert.ok(report.runs.every((run) => run.cwd === canonical));
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].occurrences, 2);
  const historical = report.runs[0];
  await writeFile(join(root, 'runs', historical.id, 'summary.json'), JSON.stringify({ ...historical, cwd: alias }));
  report = await recorder.review(workspace);
  assert.equal(report.runs.length, 2);
  assert.ok(report.runs.every((run) => run.cwd === canonical));
  const missing = join(temporary, 'does-not-exist', '..', 'absent-workspace');
  const run = runner(recorder, { cwd: missing, runId: 3 });
  run.start();
  run.finish();
  const fallback = await recorder.review(missing);
  assert.equal(fallback.cwd, resolve(missing));
  assert.equal(fallback.runs[0].cwd, resolve(missing));
});

test('macOS /var and /private/var cwd share a finding and scope', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS /var alias');
    return;
  }
  const { recorder } = await fixture(t);
  const workspace = await mkdtemp('/var/tmp/mica-harness-cwd-');
  t.onTestFinished(() => rm(workspace, { recursive: true, force: true }));
  const canonical = realpathSync.native(workspace);
  assert.ok(canonical.startsWith('/private/var/'));
  const alias = canonical.replace(/^\/private\/var\//, '/var/');
  for (const [index, cwd] of [alias, canonical].entries()) {
    const run = runner(recorder, { cwd, runId: index + 1 });
    run.start();
    run.call();
    run.result();
    run.finish();
  }
  for (const cwd of [alias, canonical]) {
    const report = await recorder.review(cwd);
    assert.equal(report.cwd, canonical);
    assert.equal(report.runs.length, 2);
    assert.equal(report.findings.length, 1);
    assert.equal(report.findings[0].occurrences, 2);
  }
});

test('shell command metadata classifies timeouts, signals and null exits without treating source or stdout as metadata', async (t) => {
  const { recorder } = await fixture(t);
  const run = runner(recorder);
  const command = (metadata: string, stdout = ''): string =>
    `[command]\ncommand: sample\n${metadata}\n[/command]\n[stdout]\n${stdout}\n[/stdout]`;
  run.start();
  const failures = [
    [command('timed_out: true\nsignal: SIGTERM\nexit_code: null'), 'timeout'],
    [command('timed_out: false\nsignal: SIGKILL\nexit_code: null'), 'signal'],
    [command('timed_out: false\nsignal: null\nexit_code: null'), 'tool-error'],
    [command('timed_out: false\nsignal: null\nexit_code: 7'), 'exit-7'],
    ['{"timed_out":true,"exit_code":null,"signal":"SIGTERM"}', 'timeout'],
    ['{"timed_out":false,"exit_code":null,"signal":"SIGTERM"}', 'signal'],
    ['{"exit_code":null,"signal":null}', 'tool-error'],
  ];
  for (const [result] of failures) {
    run.call('{}', 'functions.run_shell');
    run.result(result, 'functions.run_shell');
  }
  const normalMetadata = command(
    'timed_out: false\nsignal: null\nexit_code: 0',
    'timed_out: true\nsignal: SIGKILL\nexit_code: 9',
  );
  run.call('{}', 'run_shell');
  run.result(normalMetadata, 'run_shell');
  for (const content of [
    'timed_out: true\nsignal: SIGTERM\nexit_code: null',
    'exit_code: 7',
    '{"exit_code":7,"signal":null,"timed_out":false}',
    '1 | timed_out: true\n2 | signal: SIGKILL\n3 | exit_code: null',
    command('timed_out: true\nsignal: SIGTERM\nexit_code: 8'),
    '{"exit_code":null,"signal":"SIGTERM","timed_out":true}',
  ]) {
    run.call();
    run.result(content);
  }
  run.finish();
  const summary = (await recorder.review()).runs[0];
  assert.equal(summary.toolErrors, failures.length);
  const results = (await trace(summary)).filter((event) => event.type === 'tool:result');
  assert.deepEqual(
    results.slice(0, failures.length).map((event) => event.errorCategory),
    failures.map((entry) => entry[1]),
  );
  assert.ok(results.slice(failures.length).every((event) => event.errorCategory === null));
});

test('harness_review error envelopes produce findings while all its results stay metadata-only', async (t) => {
  const { recorder } = await fixture(t);
  const run = runner(recorder);
  run.start();
  const nestedReportCanary = 'nested-report-content-canary';
  run.call('{"action":"report"}', 'harness_review');
  run.result(JSON.stringify({ ok: true, report: { runs: [{ input: nestedReportCanary }] } }), 'harness_review');
  run.call('{"action":"export"}', 'functions.harness_review');
  run.result('{"ok":false,"error":"permission denied: private-review-error-canary"}', 'functions.harness_review');
  run.call();
  run.result('ordinary captured content');
  run.finish();
  const report = await recorder.review();
  assert.equal(report.runs[0].toolErrors, 1);
  assert.match(report.findings[0].title, /permission/);
  const events = await trace(report.runs[0]);
  const reviewResults = events.filter(
    (event) => event.type === 'tool:result' && String(event.name).endsWith('harness_review'),
  );
  assert.equal(reviewResults.length, 2);
  for (const event of reviewResults) assert.deepEqual(Object.keys(event.result as object).sort(), ['chars', 'sha256']);
  assert.equal(
    (events.find((event) => event.type === 'tool:result' && event.name === 'read_file')?.result as { content: string })
      .content,
    'ordinary captured content',
  );
  const text = await readFile(report.runs[0].traceFile, 'utf8');
  assert.ok(!text.includes(nestedReportCanary));
  assert.ok(!text.includes('private-review-error-canary'));
});

test('evidence is available only for stored events, including after missing or corrupt traces', async (t) => {
  const { recorder, root } = await fixture(t);
  const run = runner(recorder, { capture: { ...options, maxEventsPerRun: 3 } });
  run.start();
  run.call();
  run.result();
  run.finish('error', 'timeout');
  let report = await recorder.review();
  const summary = report.runs[0];
  assert.equal(report.findings.find((finding) => finding.kind === 'tool-error')?.evidence[0].available, true);
  assert.equal(report.findings.find((finding) => finding.kind === 'run-error')?.evidence[0].available, false);
  const saved = JSON.parse(await readFile(join(root, 'runs', summary.id, 'summary.json'), 'utf8')) as RunSummary;
  assert.equal(saved.findings.find((finding) => finding.kind === 'tool-error')?.evidence[0].available, true);
  assert.equal(saved.findings.find((finding) => finding.kind === 'run-error')?.evidence[0].available, false);
  await writeFile(summary.traceFile, '{corrupt}\n');
  report = await recorder.review();
  assert.ok(report.findings.every((finding) => finding.evidence.every((item) => item.available === false)));
  await rm(summary.traceFile);
  report = await recorder.review();
  assert.ok(report.findings.every((finding) => finding.evidence.every((item) => item.available === false)));
  const markdown = await readFile(await recorder.exportReport(), 'utf8');
  assert.match(markdown, /evidence unavailable/);
  assert.ok(!markdown.includes(`[Run ${summary.id}, event`));
});

test('scope filtering precedes the run limit and out-of-scope traces are never inspected', async (t) => {
  const { recorder, root } = await fixture(t);
  const cwd = resolve('workspace-a');
  const run = runner(recorder, { cwd });
  run.start();
  run.finish();
  const initial = (await recorder.review(cwd)).runs[0];
  const originalDirectory = join(root, 'runs', initial.id);
  await utimes(originalDirectory, new Date('2000-01-01'), new Date('2000-01-01'));
  const clone = async (scope: string): Promise<void> => {
    const id = randomUUID();
    const directory = join(root, 'runs', id);
    await mkdir(directory);
    await writeFile(
      join(directory, 'summary.json'),
      JSON.stringify({ ...initial, id, cwd: scope, traceFile: join(directory, 'events.jsonl') }),
    );
    // A missing trace is deliberate: only in-scope runs should be inspected.
  };
  for (let index = 0; index < 301; index++) await clone(resolve('workspace-b'));
  let report = await recorder.review(cwd);
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].id, initial.id);
  assert.equal(report.scannedRuns, 302);
  assert.deepEqual(report.warnings, []);
  // The review window must be wide enough for weeks of daily work (real sets reached 493)
  // and still keep scope filtering ahead of it.
  for (let index = 0; index < 350; index++) await clone(cwd);
  report = await recorder.review(cwd);
  assert.equal(report.runs.length, 351);
  // The original run is the least recently updated one, so it sorts last but stays in scope.
  assert.equal(report.runs.at(-1)?.id, initial.id);
  assert.equal(report.limits.runs, 2000);
  assert.ok(!report.warnings.some((warning) => warning.includes('most recently updated runs in the selected scope')));
  // Every clone has no trace at all; the original run still has one.
  assert.equal(
    report.warnings.filter((warning) => warning.includes('missing or unreadable trace')).length,
    report.runs.length - 1,
  );
}, 20_000);

test('prune removes only old finished runs in scope and keeps active or unreadable ones', async (t) => {
  const { recorder, root } = await fixture(t);
  const cwd = resolve('workspace-a');
  const other = resolve('workspace-b');

  const active = runner(recorder, { runId: 1, cwd, owner: {} });
  active.start('still running');

  const finished = runner(recorder, { runId: 2, cwd, owner: {} });
  finished.start('finished long ago');
  finished.finish();

  const foreign = runner(recorder, { runId: 3, cwd: other, owner: {} });
  foreign.start('another workspace');
  foreign.finish();

  // Age the finished runs so they fall outside the retention window. The active
  // run keeps its recent timestamp and must survive regardless.
  await recorder.flush();
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const runsDir = join(root, 'runs');
  for (const id of await readdir(runsDir)) {
    const file = join(runsDir, id, 'summary.json');
    const summary = JSON.parse(await readFile(file, 'utf8'));
    if (summary.outcome === 'running') continue;
    await writeFile(file, JSON.stringify({ ...summary, startedAt: old, finishedAt: old }));
  }

  const scoped = await recorder.prune({ olderThanDays: 30, cwd });
  assert.equal(scoped.deletedRuns, 1);
  assert.equal(scoped.skippedActive, 1);
  assert.ok(scoped.freedBytes > 0);

  const after = await recorder.review();
  const remaining = after.runs.map((run) => run.cwd);
  assert.ok(remaining.includes(cwd), 'the still-running run in scope is kept');
  assert.ok(remaining.includes(other), 'another workspace is never touched');
  assert.equal(after.runs.filter((run) => run.cwd === cwd).length, 1);
}, 20_000);

test('suggestions change with the failure cause instead of repeating one paragraph', async (t) => {
  const { recorder } = await fixture(t);
  const run = runner(recorder, { runId: 1 });
  run.start();
  run.call('{"patch":"a"}', 'apply_patch', 'c-1');
  run.result('工具 apply_patch 执行失败：\nError: 第 3 行的 hunk 没有任何增删内容', 'apply_patch', 'c-1');
  run.call('{"command":"bun run build"}', 'run_shell', 'c-2');
  run.result('[command]\nexit_code: 1\n[/command]', 'run_shell', 'c-2');
  run.finish();
  const report = await recorder.review();
  const help = (title: string) => report.findings.find((finding) => finding.title === title)!;
  const hunk = help('Tool error in apply_patch: empty-hunk');
  const shell = help('Tool error in run_shell: exit-1');
  assert.notEqual(hunk.suggestion, shell.suggestion);
  assert.match(hunk.suggestion, /hunk/);
  assert.match(shell.suggestion, /退出码/);
  assert.match(shell.suggestion, /1/);
  assert.ok(hunk.evaluation.length > 0 && shell.evaluation.length > 0);
});

test('rebuild re-derives findings from stored traces and leaves counters intact', async (t) => {
  const { recorder, root } = await fixture(t);
  const cwd = resolve('workspace-a');
  const run = runner(recorder, { runId: 1, cwd });
  run.start('rebuild fixture');
  run.call('{"patch":"a"}', 'apply_patch', 'c-1');
  run.result('工具 apply_patch 执行失败：\nError: 第 3 行的 hunk 没有任何增删内容', 'apply_patch', 'c-1');
  run.emit({ type: 'usage', usage: { inputTokens: 11, outputTokens: 4, cachedInputTokens: 2 } });
  run.finish();
  await recorder.flush();

  const runsDir = join(root, 'runs');
  const [id] = await readdir(runsDir);
  const file = join(runsDir, id, 'summary.json');
  const before = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(before.findings.length, 1);

  // Simulate findings recorded by an older classification rule: the fragmented
  // per-argument key plus the generic advice that users could not act on.
  const legacy = {
    ...before.findings[0],
    id: 'a'.repeat(64),
    title: 'Tool error in apply_patch: tool-error',
    suggestion: 'Review the failing call and its arguments.',
    occurrences: 4,
  };
  await writeFile(file, JSON.stringify({ ...before, findings: [legacy, { ...legacy, id: 'b'.repeat(64) }] }));

  const result = await recorder.rebuild({ cwd });
  assert.equal(result.rebuilt, 1);
  assert.equal(result.findings, 1);

  const after = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(
    after.findings.map((finding: { title: string }) => finding.title),
    ['Tool error in apply_patch: empty-hunk'],
  );
  assert.match(after.findings[0].suggestion, /hunk/);
  assert.equal(after.findings[0].evidence[0].available, true);
  // Traces are weaker than the live counters (they may have dropped events), so
  // rebuild must not touch anything except findings.
  for (const key of ['requestCount', 'toolCalls', 'toolErrors', 'inputTokens', 'outputTokens', 'outcome', 'startedAt'])
    assert.deepEqual(after[key], before[key], key);
}, 20_000);

test('rebuild skips live runs and reports unreadable traces instead of inventing evidence', async (t) => {
  const { recorder, root } = await fixture(t);
  const cwd = resolve('workspace-a');
  const live = runner(recorder, { runId: 1, cwd });
  live.start('still running');
  await recorder.flush();

  const runsDir = join(root, 'runs');
  const liveId = (await readdir(runsDir))[0];
  // A run whose trace no longer parses must be reported, not silently rebuilt
  // into an empty finding list that looks like "no problems found".
  const brokenDir = join(runsDir, 'broken-run');
  await mkdir(brokenDir, { recursive: true });
  await writeFile(
    join(brokenDir, 'summary.json'),
    JSON.stringify({
      ...JSON.parse(await readFile(join(runsDir, liveId, 'summary.json'), 'utf8')),
      id: 'broken-run',
      outcome: 'completed',
      traceFile: join(brokenDir, 'events.jsonl'),
    }),
  );
  await writeFile(join(brokenDir, 'events.jsonl'), '{"seq":1,"type":"tool:call"}\nnot-json\n');

  const result = await recorder.rebuild({ cwd });
  assert.equal(result.skippedRunning, 1);
  assert.equal(result.skippedUnreadable, 1);
  assert.equal(result.rebuilt, 0);
}, 20_000);
test('rebuild preserves fingerprints, all finding kinds and decisions with metadata-only or truncated content', async (t) => {
  const { recorder } = await fixture(t);
  for (const [index, capture] of [
    { ...options, captureContent: false },
    { ...options, maxEventChars: 8 },
  ].entries()) {
    const cwd = resolve(`workspace-rebuild-${index}`);
    const run = runner(recorder, { runId: index + 1, cwd, capture });
    run.start();
    for (const args of [
      '{"path":"same"}',
      '{"path":"same"}',
      '{"path":"same"}',
      '{"path":"other-a"}',
      '{"path":"other-b"}',
    ]) {
      run.call(args);
      run.result();
    }
    run.emit({ type: 'retry', attempt: 1, delayMs: 10, error: 'request timed out' });
    run.finish('error', 'permission denied');
    const before = await recorder.review(cwd);
    assert.equal(before.findings.length, 4);
    await recorder.decide(before.findings[0].id, 'accepted', 'Keep the existing decision');
    const expected = await recorder.review(cwd);
    assert.equal((await recorder.rebuild({ cwd })).rebuilt, 1);
    const after = await recorder.review(cwd);
    assert.deepEqual(after.findings, expected.findings);
    assert.equal(after.runs[0].toolErrors, expected.runs[0].toolErrors);
  }
});

test('rebuild leaves findings untouched when capture or a damaged trace is incomplete', async (t) => {
  const { recorder } = await fixture(t);
  const capped = runner(recorder, { capture: { ...options, maxEventsPerRun: 2 } });
  capped.start();
  capped.call();
  capped.result();
  capped.finish('error', 'timeout');
  const damaged = runner(recorder, { runId: 2 });
  damaged.start();
  damaged.call();
  damaged.result();
  damaged.finish();
  const before = await recorder.review();
  const target = before.runs.find((run) => run.sourceRunId === 2)!;
  await writeFile(target.traceFile, 'null\n');
  const result = await recorder.rebuild();
  assert.equal(result.rebuilt, 0);
  assert.equal(result.skippedUnreadable, 2);
  const after = await recorder.review();
  assert.deepEqual(
    after.findings.map((item) => [item.id, item.occurrences]),
    before.findings.map((item) => [item.id, item.occurrences]),
  );
});

test('scoped pruning and rebuilding keep runs without workspace metadata and malformed summaries', async (t) => {
  const { recorder, root } = await fixture(t);
  const run = runner(recorder);
  run.start();
  run.finish();
  const summary = (await recorder.review()).runs[0];
  const file = join(root, 'runs', summary.id, 'summary.json');
  const { cwd: _cwd, ...unscoped } = summary;
  await writeFile(file, JSON.stringify({ ...unscoped, finishedAt: '2000-01-01T00:00:00.000Z' }));
  const corrupt = join(root, 'runs', randomUUID());
  await mkdir(corrupt);
  await writeFile(join(corrupt, 'summary.json'), 'null');
  const cwd = resolve('workspace-a');
  assert.equal((await recorder.prune({ olderThanDays: 1, cwd })).deletedRuns, 0);
  assert.equal((await recorder.rebuild({ cwd })).rebuilt, 0);
  assert.equal((await readdir(join(root, 'runs'))).length, 2);
  await assert.rejects(recorder.prune({ olderThanDays: Number.NaN }), /Invalid retention/);
});

test('rebuild preserves historical metadata-only findings whose trace cannot recover their category', async (t) => {
  const { recorder } = await fixture(t);
  const run = runner(recorder, { capture: { ...options, captureContent: false } });
  run.start();
  run.emit({ type: 'retry', attempt: 1, delayMs: 10, error: 'timeout' });
  run.finish();
  const before = await recorder.review();
  const events = await trace(before.runs[0]);
  delete events[1].errorCategory;
  await writeFile(before.runs[0].traceFile, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  assert.equal((await recorder.rebuild()).skippedUnreadable, 1);
  assert.deepEqual((await recorder.review()).findings, before.findings);
});

test('one recurring tool error stays one finding no matter how many argument variants hit it', async (t) => {
  const { recorder } = await fixture(t);
  const run = runner(recorder, { runId: 1 });
  run.start();
  // Same tool, different patches, same underlying cause. Keying the finding by
  // the argument fingerprint produced one look-alike review item per call, which
  // is what real runs showed (10 empty hunks -> 10 identical suggestions).
  for (let index = 0; index < 4; index++) {
    run.call(`{"patch":"*** Update File: f${index}.ts\\n*** End Patch"}`, 'apply_patch', `call-${index}`);
    run.result(
      JSON.stringify({
        isError: true,
        message: `工具 apply_patch 执行失败：\nError: 第 ${index + 3} 行的 hunk 没有任何增删内容`,
      }),
      'apply_patch',
      `call-${index}`,
    );
  }
  run.finish();
  const report = await recorder.review();
  const failures = report.findings.filter((finding) => finding.kind === 'tool-error');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].title, 'Tool error in apply_patch: empty-hunk');
  assert.equal(failures[0].occurrences, 4);
  assert.equal(failures[0].evidence.length, 4);
});

test('tool-specific error causes are classified instead of falling into tool-error', async (t) => {
  const { recorder } = await fixture(t);
  const run = runner(recorder, { runId: 1 });
  run.start();
  const cases: Array<[string, string]> = [
    ['工具 apply_patch 执行失败：\nError: patch 必须以 *** Begin Patch 开始', 'invalid-patch-header'],
    ['{"isError":true,"message":"hunk failed: context not found"}', 'patch-context-mismatch'],
  ];
  for (const [index, [result, cause]] of cases.entries()) {
    run.call(`{"patch":"p${index}"}`, 'apply_patch', `p-${index}`);
    run.result(result, 'apply_patch', `p-${index}`);
    const report = await recorder.review();
    assert.ok(
      report.findings.some((finding) => finding.title === `Tool error in apply_patch: ${cause}`),
      `expected ${cause} in ${report.findings.map((finding) => finding.title).join(', ')}`,
    );
  }
  // A plain "ENOENT: no such file" must still be a missing-file problem, not one
  // of the patch categories above.
  run.call('{"path":"gone.txt"}', 'read_file', 'r-1');
  run.result('{"isError":true,"message":"ENOENT: no such file or directory"}', 'read_file', 'r-1');
  const final = await recorder.review();
  assert.ok(final.findings.some((finding) => finding.title === 'Tool error in read_file: not-found'));
  run.finish();
});

test('terminalProgram keeps the program that decides the exit code', () => {
  const cases: Array<[string, string]> = [
    ['cd x && rg foo', 'rg'],
    ['a; b', 'b'],
    ['rg foo | head', 'head'],
    ['FOO=1 bun test', 'bun'],
    ['bun test 2>&1 | tail -25', 'tail'],
    ['time -p bun run typecheck', 'bun'],
    ['sudo -E env FOO=1 rg -n foo src', 'rg'],
    ['./node_modules/.bin/vitest run', 'vitest'],
    ['rg foo\ngit status', 'git'],
    ['rg foo || true', 'true'],
    ['rg "a|b" src', 'rg'],
    ['rg foo 2>/dev/null', 'rg'],
    ['cat <<EOF\nrg nope\nEOF', 'cat'],
    ['rg foo -- -not-a-flag', 'rg'],
    ["rg 'unterminated", ''],
    ['   ', ''],
  ];
  for (const [command, program] of cases) assert.equal(terminalProgram(command), program, command);
});

test('expectedExit only accepts the nonzero codes a command documents itself', () => {
  assert.equal(expectedExit('rg', 1, 'rg -n needle src'), true);
  // 2 means rg could not search at all: a real failure.
  assert.equal(expectedExit('rg', 2, 'rg -n needle src'), false);
  assert.equal(expectedExit('grep', 1, 'grep -q x f'), true);
  assert.equal(expectedExit('diff', 1, 'diff a b'), true);
  assert.equal(expectedExit('ls', 1, 'ls missing'), true);
  assert.equal(expectedExit('test', 1, 'test -f missing'), true);
  assert.equal(expectedExit('[', 1, '[ -f missing ]'), true);
  assert.equal(expectedExit('git', 1, 'git diff --quiet'), true);
  assert.equal(expectedExit('git', 1, 'git diff --exit-code HEAD'), true);
  assert.equal(expectedExit('git', 1, 'git diff HEAD'), false);
  assert.equal(expectedExit('bun', 1, 'bun run build'), false);
  assert.equal(expectedExit('rg', 0, 'rg -n needle src'), false);
});

test('similarity compares normalised character bigrams', () => {
  const task = '把压缩服务改成只在空闲时跑，并保证不占用 turn lease';
  assert.equal(similarity(task, task), 1);
  assert.equal(similarity(task, `  ${task.toUpperCase()}  `), 1);
  assert.ok(similarity(task, `${task}，谢谢`) > 0.8);
  assert.ok(similarity(task, 'Reformat the review report table so the numbers line up') < 0.3);
  assert.equal(similarity('', task), 0);
});

test('splitPromptSections labels top-level blocks and ignores malformed markup', () => {
  assert.deepEqual(splitPromptSections(''), []);
  assert.deepEqual(
    splitPromptSections('plain text only').map((section) => section.label),
    ['text'],
  );
  const prompt = [
    'Preamble text',
    '\n\n<document source="AGENT.md">\nBase instructions\n</document>',
    '\n\n<injection source="plugin" plugin="todo" section="plan">\nPlan discipline\n</injection>',
    '\n\n<role name="需求开发">\nRole body\n</role>',
    '\n\n<custom attr="1">tail</custom>',
    '\n\n',
  ].join('');
  const sections = splitPromptSections(prompt);
  assert.deepEqual(
    sections.map((section) => section.label),
    ['text', 'document:AGENT.md', 'injection:todo/plan', 'role:需求开发', 'custom'],
  );
  const document = '<document source="AGENT.md">\nBase instructions\n</document>';
  assert.equal(sections[1].sha256, sha(document));
  assert.equal(sections[1].chars, document.length);
  // Malformed markup degrades to coarser sections instead of throwing.
  assert.equal(splitPromptSections('<document source="a">\nunterminated')[0].label, 'document:a');
  assert.equal(splitPromptSections('<b>x</i>tail')[0].label, 'b');
  assert.equal(splitPromptSections('<div><div>nested</div></div>').length, 1);
});

test('nonzero exits a command documents itself are counted apart from real tool errors', async (t) => {
  const { recorder } = await fixture(t);
  const cwd = resolve('workspace-shell-exits');
  const run = runner(recorder, { cwd });
  run.start('shell exit semantics');
  const cases: Array<[string, string]> = [
    // No match is how rg reports "nothing found".
    ['rg -n needle src', '1'],
    // 2 means rg could not even search.
    ['rg -n needle src --unknown-flag', '2'],
    ['test -f missing.txt', '1'],
    // The pipeline's status is tail's, not bun's.
    ['bun run build 2>&1 | tail -25', '1'],
    ['diff a.txt b.txt', '1'],
  ];
  for (const [index, [command, code]] of cases.entries()) {
    const id = `shell-${index}`;
    run.call(JSON.stringify({ command }), 'run_shell', id);
    run.result(`[command]\nexit_code: ${code}\n[/command]`, 'run_shell', id);
  }
  run.finish();
  const report = await recorder.review(cwd);
  const summary = report.runs[0];
  assert.equal(summary.expectedExits, 3);
  assert.equal(summary.toolErrors, 2);
  assert.deepEqual(summary.findings.map((finding) => finding.title).sort(), [
    'Tool error in run_shell: exit-1',
    'Tool error in run_shell: exit-2',
  ]);
  const events = await trace(summary);
  const expected = events.filter((event) => event.type === 'tool:result' && event.expectedExit === true);
  assert.equal(expected.length, 3);
  assert.ok(expected.every((event) => event.errorCategory === null));
  // The same verdict has to come back out of the stored trace.
  assert.equal((await recorder.rebuild({ cwd })).rebuilt, 1);
  assert.deepEqual((await recorder.review(cwd)).findings, report.findings);
});

test('a repeated call is reported only while nothing has changed in between', async (t) => {
  const { recorder } = await fixture(t);
  const cwd = resolve('workspace-repeat');
  const run = runner(recorder, { cwd });
  run.start('repetition semantics');
  const shell = (command: string, stdout: string, id: string): void => {
    run.call(JSON.stringify({ command }), 'run_shell', id);
    run.result(`[command]\nexit_code: 0\n[/command]\n[stdout]\n${stdout}\n[/stdout]`, 'run_shell', id);
  };
  // Untouched workspace, unchanged output: no progress.
  for (let index = 0; index < 3; index++) shell('bun run typecheck', 'Type check passed', `idle-${index}`);
  // Same command, but a different command ran in between (the file was edited): progress.
  shell('bun run build', 'build ok', 'edit-0');
  shell('bun run build', 'build ok', 'edit-1');
  run.call('{"patch":"*** Begin Patch"}', 'apply_patch', 'write-1');
  run.result('{"success":true}', 'apply_patch', 'write-1');
  shell('bun run build', 'build ok', 'edit-2');
  // Repeated probing whose answers keep changing is not a loop either.
  for (let index = 0; index < 3; index++) shell('curl -s localhost:3000/health', `status ${index}`, `poll-${index}`);
  run.finish();
  const report = await recorder.review(cwd);
  const repeated = report.findings.filter((finding) => finding.kind === 'repeated-call');
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].occurrences, 1);
  assert.match(repeated[0].evidence[0].detail ?? '', /across 3 calls/);
  assert.equal(report.runs[0].toolErrors, 0);
  assert.equal((await recorder.rebuild({ cwd })).rebuilt, 1);
  assert.deepEqual((await recorder.review(cwd)).findings, report.findings);
});

test('polling tools and subagent reads never become repeated-call candidates', async (t) => {
  const { recorder } = await fixture(t);
  const run = runner(recorder, { runId: 1 });
  run.start('polling semantics');
  const polls: Array<[string, string]> = [
    ['agent', '{"operation":"await","task_id":"t1"}'],
    ['agent', '{"operation":"join","task_ids":["t1"]}'],
    ['agent', '{"operation":"read","task_id":"t1"}'],
    ['agent', '{"operation":"list"}'],
    ['background_tasks_read', '{"task_id":"t1"}'],
    ['background_tasks_list', '{}'],
    ['wait_for', '{"kind":"port","port":3000}'],
    ['pty_read', '{"id":"p1"}'],
  ];
  for (const [index, [name, args]] of polls.entries())
    for (let repeat = 0; repeat < 4; repeat++) {
      run.call(args, name, `poll-${index}-${repeat}`);
      run.result('{"status":"running"}', name, `poll-${index}-${repeat}`);
    }
  run.finish();
  const report = await recorder.review();
  assert.deepEqual(
    report.findings.filter((finding) => finding.kind === 'repeated-call'),
    [],
  );
});

test('resolved prompts record which section drifted without storing its text', async (t) => {
  const { recorder, root } = await fixture(t);
  const run = runner(recorder, { cwd: resolve('workspace-prompt') });
  const prompt = [
    'Preamble',
    '<document source="AGENT.md">',
    'project-canary-instructions',
    '</document>',
    '<injection source="plugin" plugin="todo" section="plan">',
    'plan-canary-body',
    '</injection>',
  ].join('\n');
  run.start('prompt sections');
  run.emit({ type: 'prompt:resolved', prompt });
  run.finish();
  const summary = (await recorder.review()).runs[0];
  const sections = summary.promptSections!;
  assert.deepEqual(
    sections.map((section) => section.label),
    ['text', 'document:AGENT.md', 'injection:todo/plan'],
  );
  const document = '<document source="AGENT.md">\nproject-canary-instructions\n</document>';
  assert.deepEqual(sections[1], { label: 'document:AGENT.md', sha256: sha(document), chars: document.length });
  // The whole-prompt digest is unchanged, and both the summary and the trace carry sections.
  assert.deepEqual(summary.promptHashes, [{ sha256: sha(prompt), chars: prompt.length }]);
  const event = (await trace(summary)).find((item) => item.type === 'prompt:resolved')!;
  assert.deepEqual(
    (event.promptSections as Array<{ label: string }>).map((section) => section.label),
    ['text', 'document:AGENT.md', 'injection:todo/plan'],
  );
  const persisted =
    (await readFile(summary.traceFile, 'utf8')) +
    (await readFile(join(root, 'runs', summary.id, 'summary.json'), 'utf8'));
  assert.ok(persisted.includes('document:AGENT.md'));
  assert.ok(!persisted.includes('project-canary-instructions'));
  assert.ok(!persisted.includes('plan-canary-body'));
});

test('a retry of the same task after a failed run is recorded once and replayed identically', async (t) => {
  const { recorder } = await fixture(t);
  const cwd = resolve('workspace-retry');
  const task = 'Refactor the compaction service so idle history collapses without touching the turn lease.';
  const other = 'Teach the review report to print expected exits per run.';
  const runs: Array<[number, string, 'aborted' | 'completed', string]> = [
    [1, task, 'aborted', '2026-06-01T10:00:00.000Z'],
    [2, task, 'completed', '2026-06-01T10:05:00.000Z'],
    [3, other, 'completed', '2026-06-01T10:10:00.000Z'],
    // Identical input after a successful run is a rerun, not a rejected answer.
    [4, other, 'completed', '2026-06-01T10:15:00.000Z'],
  ];
  for (const [runId, input, outcome, timestamp] of runs) {
    const run = runner(recorder, { runId, cwd, timestamp });
    run.start(input);
    run.finish(outcome);
  }
  const report = await recorder.review(cwd);
  const retries = report.findings.filter((finding) => finding.kind === 'user-retry');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].title, '上次运行未成功后重试了同一任务');
  assert.equal(retries[0].module, 'session');
  assert.equal(retries[0].occurrences, 1);
  assert.match(retries[0].suggestion, /对比两次的运行记录/);
  assert.match(retries[0].evidence[0].detail ?? '', /aborted/);
  assert.equal((await recorder.rebuild({ cwd })).rebuilt, 4);
  assert.deepEqual((await recorder.review(cwd)).findings, report.findings);
});

test('runs left behind by a dead host are reclaimed while the current process is left alone', async (t) => {
  const { recorder, root } = await fixture(t);
  const cwd = resolve('workspace-zombie');
  const live = runner(recorder, { runId: 1, cwd });
  live.start('still running in this process');
  await recorder.flush();
  const runsDir = join(root, 'runs');
  const [liveId] = await readdir(runsDir);
  const liveFile = join(runsDir, liveId, 'summary.json');
  // A child that has already exited: its pid cannot be alive any more.
  const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  assert.ok(deadPid > 0, 'the probe process must report a pid');
  const template = JSON.parse(await readFile(liveFile, 'utf8')) as RunSummary;
  const abandoned = async (): Promise<string> => {
    const id = randomUUID();
    const directory = join(runsDir, id);
    await mkdir(directory);
    await writeFile(
      join(directory, 'summary.json'),
      JSON.stringify({ ...template, id, hostPid: deadPid, traceFile: join(directory, 'events.jsonl') }),
    );
    return id;
  };
  const deadId = await abandoned();
  assert.equal(await recorder.reclaim(), 1);
  const reclaimed = JSON.parse(await readFile(join(runsDir, deadId, 'summary.json'), 'utf8')) as RunSummary;
  assert.equal(reclaimed.outcome, 'interrupted');
  assert.ok(reclaimed.reclaimedAt);
  assert.equal((JSON.parse(await readFile(liveFile, 'utf8')) as RunSummary).outcome, 'running');
  // Already reclaimed: nothing is rewritten twice.
  assert.equal(await recorder.reclaim(), 0);
  // A review reclaims on its own and says how many unfinished runs it closed.
  const second = await abandoned();
  const report = await recorder.review(cwd);
  assert.ok(report.warnings.some((warning) => warning.includes('已回收 1 个宿主已退出的未完成运行')));
  assert.equal(report.runs.length, 3);
  assert.equal(report.runs.find((run) => run.id === deadId)?.outcome, 'interrupted');
  assert.equal(report.runs.find((run) => run.id === second)?.outcome, 'interrupted');
  assert.equal(report.runs.find((run) => run.id === liveId)?.outcome, 'running');
});

// 早期记录没有 hostPid：不能用 pid 判断，但也不能让它们永远挂在 running 上。
test('reclaims a legacy running run once it stops being written, and leaves fresh ones alone', async (t) => {
  const { recorder, root } = await fixture(t);
  const cwd = resolve('workspace-legacy');
  const live = runner(recorder, { runId: 1, cwd });
  live.start('legacy run');
  await recorder.flush();
  const runsDir = join(root, 'runs');
  const [liveId] = await readdir(runsDir);
  const liveFile = join(runsDir, liveId, 'summary.json');
  const template = JSON.parse(await readFile(liveFile, 'utf8')) as RunSummary;
  const legacy = async (ageMs: number): Promise<string> => {
    const id = randomUUID();
    const directory = join(runsDir, id);
    await mkdir(directory);
    const { hostPid: _hostPid, ...rest } = template;
    const file = join(directory, 'summary.json');
    await writeFile(file, JSON.stringify({ ...rest, id, traceFile: join(directory, 'events.jsonl') }));
    const stamp = new Date(Date.now() - ageMs);
    await utimes(file, stamp, stamp);
    return id;
  };
  const stale = await legacy(7 * 60 * 60 * 1000);
  const fresh = await legacy(60 * 1000);
  assert.equal(await recorder.reclaim(), 1);
  assert.equal(
    (JSON.parse(await readFile(join(runsDir, stale, 'summary.json'), 'utf8')) as RunSummary).outcome,
    'interrupted',
  );
  assert.equal(
    (JSON.parse(await readFile(join(runsDir, fresh, 'summary.json'), 'utf8')) as RunSummary).outcome,
    'running',
  );
  assert.equal((JSON.parse(await readFile(liveFile, 'utf8')) as RunSummary).outcome, 'running');
});

test('summaries recorded before expected exits existed still load with a zero count', async (t) => {
  const { recorder, root } = await fixture(t);
  const run = runner(recorder, { cwd: resolve('workspace-legacy') });
  run.start('legacy summary');
  run.finish();
  const summary = (await recorder.review()).runs[0];
  const { expectedExits: _expected, ...legacy } = summary;
  await writeFile(join(root, 'runs', summary.id, 'summary.json'), JSON.stringify(legacy));
  const report = await recorder.review();
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].expectedExits, 0);
});

test('summaries record the host shape, capturing pid and update time', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'mica-harness-host-'));
  const root = join(temporary, 'capture');
  const recorder = new HarnessRecorder(root, () => {}, { mode: 'session', host: 'desktop' });
  t.onTestFinished(async () => {
    await recorder.dispose();
    await rm(temporary, { recursive: true, force: true });
  });
  const run = runner(recorder, { cwd: resolve('workspace-host') });
  run.start('host metadata');
  await recorder.flush();
  const summary = (await recorder.review()).runs[0];
  assert.equal(summary.mode, 'session');
  assert.equal(summary.host, 'desktop');
  assert.equal(summary.hostPid, process.pid);
  assert.ok(summary.updatedAt && Number.isFinite(Date.parse(summary.updatedAt)));
  // Without host context the fields are simply absent instead of being written as undefined.
  const plain = await fixture(t);
  const bare = runner(plain.recorder, { cwd: resolve('workspace-host') });
  bare.start('host metadata');
  const bareSummary = (await plain.recorder.review()).runs[0];
  assert.equal('mode' in bareSummary, false);
  assert.equal('host' in bareSummary, false);
});

test('compactions are counted per strategy with the last one kept, and never become a finding', async (t) => {
  const { recorder, errors } = await fixture(t);
  const cwd = resolve('workspace-compaction');
  const run = runner(recorder, { cwd });
  run.start('compact fixture');
  run.emit({
    type: 'compaction',
    strategy: 'local',
    reason: 'auto-compact',
    beforeMessages: 80,
    afterMessages: 60,
    beforeChars: 240_000,
    afterChars: 180_000,
    applied: true,
  });
  run.emit({
    type: 'compaction',
    strategy: 'llm',
    reason: 'auto-compact',
    beforeMessages: 60,
    afterMessages: 12,
    applied: true,
  });
  // 检查之后决定不压的那一次没有改动历史：它不是一次压缩。
  run.emit({
    type: 'compaction',
    strategy: 'idle',
    reason: 'idle',
    beforeMessages: 12,
    afterMessages: 12,
    applied: false,
  });
  run.finish();

  const summary = (await recorder.review(cwd)).runs[0];
  assert.deepEqual(summary.compactions, { local: 1, llm: 1, idle: 0 });
  assert.deepEqual(summary.lastCompaction, {
    strategy: 'llm',
    reason: 'auto-compact',
    beforeMessages: 60,
    afterMessages: 12,
  });
  // 压缩是正常机制，计数之外不产生任何问题条目。
  assert.deepEqual((await recorder.review(cwd)).findings, []);

  // 轨迹里带着重放需要的字段，rebuild 才数得出同样的次数。
  const events = await trace(summary);
  assert.equal(events.filter((event) => event.type === 'compaction').length, 3);
  assert.equal(events.find((event) => event.type === 'compaction')?.applied, true);
  const markdown = await readFile(await recorder.exportReport(cwd), 'utf8');
  assert.match(markdown, /\| 1 \/ 1 \/ 0 \|/);

  assert.equal((await recorder.rebuild({ cwd })).rebuilt, 1);
  const rebuilt = (await recorder.review(cwd)).runs[0];
  assert.deepEqual(rebuilt.compactions, { local: 1, llm: 1, idle: 0 });
  assert.deepEqual(rebuilt.lastCompaction, summary.lastCompaction);
  assert.deepEqual(errors, []);
});

test('delegated runs are aggregated by type under their parent session', async (t) => {
  const { recorder } = await fixture(t);
  const cwd = resolve('workspace-delegation');
  const child = (
    runId: number,
    delegation: { type: string; parentSessionId?: string },
    outcome: 'completed' | 'aborted' | 'error',
    requests: number,
    outputTokens: number,
  ): void => {
    const run = runner(recorder, { runId, cwd });
    run.emit({ type: 'run:start', config, input: `subagent ${runId}`, delegation });
    for (let index = 0; index < requests; index++) run.emit({ type: 'request:start', messageCount: index });
    run.emit({ type: 'usage', usage: { inputTokens: 10, outputTokens } });
    run.finish(outcome);
  };
  child(1, { type: 'Explore', parentSessionId: 'parent-session' }, 'completed', 2, 100);
  child(2, { type: 'Explore', parentSessionId: 'parent-session' }, 'error', 4, 40);
  child(3, { type: 'Implementer', parentSessionId: 'parent-session' }, 'aborted', 1, 10);
  child(4, { type: 'Explore', parentSessionId: 'other-parent' }, 'completed', 3, 20);
  // 没有委派来源的运行不进委派树。
  const main = runner(recorder, { runId: 5, cwd });
  main.start('主会话');
  main.finish();

  const report = await recorder.review(cwd);
  assert.equal(report.delegation.parents.length, 2);
  assert.deepEqual(report.runs.find((run) => run.sourceRunId === 1)?.delegation, {
    type: 'Explore',
    parentSessionId: 'parent-session',
  });
  assert.equal(report.runs.find((run) => run.sourceRunId === 5)?.delegation, undefined);
  const parent = report.delegation.parents.find((item) => item.parentSessionId === 'parent-session')!;
  assert.equal(parent.runs, 3);
  assert.deepEqual(parent.types, [
    { type: 'Explore', runs: 2, completed: 1, failed: 1, aborted: 0, avgRequests: 3, avgOutputTokens: 70 },
    { type: 'Implementer', runs: 1, completed: 0, failed: 0, aborted: 1, avgRequests: 1, avgOutputTokens: 10 },
  ]);
  assert.equal(report.delegation.parents.find((item) => item.parentSessionId === 'other-parent')?.runs, 1);
  // 委派只是统计，不是问题条目。
  assert.deepEqual(
    report.findings.filter((finding) => finding.kind === 'user-correction'),
    [],
  );
  const markdown = await readFile(await recorder.exportReport(cwd), 'utf8');
  assert.match(markdown, /## Delegation/);
  assert.match(markdown, /\| parent-session \| Explore \| 2 \| 1 \| 1 \| 0 \| 3 \| 70 \|/);
});

test('a helper run records its source and keeps it through a rebuild', async (t) => {
  const { recorder } = await fixture(t);
  const cwd = resolve('workspace-helper');
  const run = runner(recorder, { cwd });
  run.emit({
    type: 'run:start',
    config,
    input: 'compact this transcript',
    helper: { kind: ' compaction ', pluginId: 'auto-compact', purpose: 'summary' },
  });
  run.finish();
  const before = (await recorder.review(cwd)).runs[0]!;
  assert.deepEqual(before.helper, { kind: 'compaction', pluginId: 'auto-compact', purpose: 'summary' });
  // 轨迹里也带着它：重放不能把「压缩摘要」重新读成「用户的一轮」。
  assert.deepEqual((await trace(before)).find((event) => event.type === 'run:start')?.helper, before.helper);
  assert.equal((await recorder.rebuild({ cwd })).rebuilt, 1);
  assert.deepEqual((await recorder.review(cwd)).runs[0]!.helper, before.helper);
  const markdown = await readFile(await recorder.exportReport(cwd), 'utf8');
  // 只有 helper 运行时，Runs 表就是「没有用户的一轮」——它只出现在 Helpers 里。
  assert.match(markdown, /No runs in this scope/);
  assert.match(markdown, /\| auto-compact · compaction \| 1 \| 1 \| 0 \| 0 \| 0 \| — \| 0 \|/);
  assert.match(markdown, /## Plugin health/);
  assert.match(markdown, /No plugin background failures recorded/);
});

test('helper runs are aggregated by source and stay out of the Runs table', async (t) => {
  const { recorder } = await fixture(t);
  const cwd = resolve('workspace-helpers');
  const helper = (
    runId: number,
    source: { kind: string; pluginId?: string },
    outcome: 'completed' | 'error' | 'aborted',
    requestMs: number,
    outputTokens: number,
  ): void => {
    const run = runner(recorder, { runId, cwd });
    run.emit({ type: 'run:start', config, input: `helper ${runId}`, helper: source });
    run.emit({ type: 'request:start', messageCount: 1 });
    run.emit({ type: 'request:end', durationMs: requestMs, attempts: 1, outcome: 'completed' });
    run.emit({ type: 'usage', usage: { inputTokens: 10, outputTokens } });
    run.finish(outcome);
  };
  helper(1, { kind: 'compaction' }, 'completed', 400, 100);
  helper(2, { kind: 'compaction' }, 'error', 600, 20);
  helper(3, { kind: 'plugin-llm', pluginId: 'session-rename' }, 'completed', 200, 10);
  const main = runner(recorder, { runId: 4, cwd });
  main.start('主会话');
  main.finish();

  const report = await recorder.review(cwd);
  assert.equal(report.helpers.total, 3);
  assert.deepEqual(report.helpers.kinds, [
    {
      kind: 'compaction',
      runs: 2,
      completed: 1,
      failed: 1,
      aborted: 0,
      requests: 2,
      avgRequestMs: 500,
      avgOutputTokens: 60,
    },
    {
      kind: 'plugin-llm',
      pluginId: 'session-rename',
      runs: 1,
      completed: 1,
      failed: 0,
      aborted: 0,
      requests: 1,
      avgRequestMs: 200,
      avgOutputTokens: 10,
    },
  ]);

  const markdown = await readFile(await recorder.exportReport(cwd), 'utf8');
  assert.match(markdown, /## Helpers/);
  assert.match(markdown, /\| compaction \| 2 \| 1 \| 1 \| 0 \| 2 \| 500 \| 60 \|/);
  assert.match(markdown, /\| session-rename · plugin-llm \| 1 \| 1 \| 0 \| 0 \| 1 \| 200 \| 10 \|/);
  // 一次 turn 配一条摘要：helper 进了 Runs 表，表就会翻倍而没人看。
  const runsTable = markdown.split('## Runs')[1]!.split('## Delegation')[0]!;
  assert.equal(runsTable.match(/\| \[/g)?.length, 1);
  for (const run of report.runs.filter((item) => item.helper)) assert.ok(!runsTable.includes(run.id));
});

test('helper runs never read as the user retrying the previous task', async (t) => {
  const { recorder } = await fixture(t);
  const cwd = resolve('workspace-helper-retry');
  // 压缩摘要每轮喂的都是同一段 transcript：按「失败后重试同一任务」推导，它每次都是重试。
  const transcript = 'The same conversation transcript is summarized again at every turn of this session.';
  for (const runId of [1, 2]) {
    const run = runner(recorder, { runId, cwd });
    run.emit({ type: 'run:start', config, input: transcript, helper: { kind: 'compaction' } });
    run.finish('error', 'request timed out');
  }
  const report = await recorder.review(cwd);
  assert.deepEqual(
    report.findings.filter((finding) => finding.kind === 'user-retry'),
    [],
  );
  // 它确实失败了两次：失败条目还在，只是来源写在标题里，而不是伪装成用户的重试。
  const failures = report.findings.filter((finding) => finding.kind === 'run-error');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.occurrences, 2);
  assert.equal(failures[0]!.title, 'Helper run failed: compaction (timeout)');

  // 反向也成立：helper 不能把「上一轮用户说了什么」挤掉，紧随其后的真实重试仍要被认出来。
  const task = 'Refactor the compaction service so idle history collapses without touching the turn lease.';
  const first = runner(recorder, { runId: 3, cwd });
  first.start(task);
  first.finish('aborted');
  const retry = runner(recorder, { runId: 4, cwd });
  retry.start(task);
  retry.finish();
  const retries = (await recorder.review(cwd)).findings.filter((finding) => finding.kind === 'user-retry');
  assert.equal(retries.length, 1);
  assert.equal(retries[0]!.occurrences, 1);

  // 委派子代理同理：它的输入是父代理派给它的任务，失败了重开一次不是「用户重试」。
  const delegatedTask = 'Walk every caller of the compaction service and report the ones that skip the lease.';
  for (const runId of [5, 6]) {
    const child = runner(recorder, { runId, cwd });
    child.emit({
      type: 'run:start',
      config,
      input: delegatedTask,
      delegation: { type: 'Explore' },
    });
    child.finish('error', 'max turns');
  }
  const delegatedRetries = (await recorder.review(cwd)).findings.filter((finding) => finding.kind === 'user-retry');
  assert.equal(delegatedRetries.length, 1);
  assert.equal(delegatedRetries[0]!.occurrences, 1);
});

test('a failing helper run names its source and stays apart from ordinary run failures', async (t) => {
  const { recorder } = await fixture(t);
  const cwd = resolve('workspace-helper-error');
  const compact = runner(recorder, { cwd });
  compact.emit({
    type: 'run:start',
    config,
    input: 'summary',
    helper: { kind: 'compaction', pluginId: 'auto-compact' },
  });
  compact.finish('error', 'request timed out');
  const bare = runner(recorder, { runId: 2, cwd });
  bare.emit({ type: 'run:start', config, input: 'summary', helper: { kind: 'btw' } });
  bare.finish('error', 'request timed out');
  const main = runner(recorder, { runId: 3, cwd });
  main.start('a normal turn');
  main.finish('error', 'request timed out');

  const findings = (await recorder.review(cwd)).findings.filter((finding) => finding.kind === 'run-error');
  // 三种来源各自一条：合并成一条就分不清该改压缩、旁问还是主流程。
  assert.deepEqual(findings.map((finding) => finding.module).sort(), ['helper:btw', 'plugin:auto-compact', 'runtime']);
  const helper = findings.find((finding) => finding.module === 'plugin:auto-compact')!;
  assert.equal(helper.title, 'Helper run failed: auto-compact · compaction (timeout)');
  assert.equal(findings.find((finding) => finding.module === 'runtime')!.title, 'Run ended with an error: timeout');
});

test('plugin background failures are throttled, aggregated and exposed as a review item', async (t) => {
  const { recorder, root } = await fixture(t);
  const failure = (tick: number, timestamp: string) => ({
    pluginId: 'mobile-relay',
    timestamp,
    type: 'background:failed' as const,
    taskId: 'poll',
    tick,
    failures: tick,
    error: `connect ${tick} refused`,
  });
  // 每个任务的第一条一定落盘：一次失败立刻可见。
  recorder.notePluginEvent(failure(1, at));
  // 5 分钟内第二次不落盘：常驻任务每 30 秒坏一次，一天就是几千行同一个结论。
  recorder.notePluginEvent(failure(2, at));
  await recorder.flush();
  const file = join(root, 'plugin-events.jsonl');
  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), {
    at,
    pluginId: 'mobile-relay',
    taskId: 'poll',
    tick: 1,
    failures: 1,
    error: 'connect 1 refused',
  });
  // 只失败一次只是噪声：记录在案，但不生成条目。
  assert.deepEqual((await recorder.review()).findings, []);

  // 之前进程留下的记录与一条坏行：坏行不该让整次复盘失败。
  await appendFile(
    file,
    `${JSON.stringify({ at: '2026-06-01T10:05:00.000Z', pluginId: 'mobile-relay', taskId: 'poll', tick: 2, failures: 2, error: 'connect 2 refused' })}\n`,
  );
  await appendFile(file, 'not-json\n');
  await appendFile(
    file,
    `${JSON.stringify({ at: '2026-06-01T10:09:00.000Z', pluginId: 'mobile-relay', taskId: 'poll', tick: 3, failures: 3, error: 'connect 3 refused' })}\n`,
  );

  const report = await recorder.review();
  assert.deepEqual(report.pluginFailures, [
    {
      pluginId: 'mobile-relay',
      taskId: 'poll',
      count: 3,
      lastAt: '2026-06-01T10:09:00.000Z',
      lastError: 'connect 3 refused',
    },
  ]);
  assert.ok(report.warnings.some((warning) => warning.includes('unreadable line')));
  const finding = report.findings.find((item) => item.kind === 'plugin-background')!;
  assert.equal(finding.id, 'plugin-background:mobile-relay:poll');
  assert.equal(finding.module, 'plugin:mobile-relay');
  assert.equal(finding.occurrences, 3);
  assert.match(finding.title, /mobile-relay\/poll/);
  assert.match(finding.evaluation, /connect 3 refused/);
  // 插件事件不属于任何一条 run：不伪造 runId。
  assert.deepEqual(finding.evidence, []);

  // 人工判断对这些条目同样生效（id 直接当 decisions/<id>.json）。
  await recorder.decide(finding.id, 'accepted', '已修好轮询');
  assert.equal((await recorder.review()).findings.find((item) => item.id === finding.id)?.status, 'accepted');

  const markdown = await readFile(await recorder.exportReport(), 'utf8');
  assert.match(markdown, /## Plugin health/);
  assert.match(markdown, /\| mobile-relay \| poll \| 3 \|/);
});

test('hook failures are recorded like background tasks, with a lower-bound count', async (t) => {
  const { recorder, root } = await fixture(t);
  recorder.notePluginEvent({
    pluginId: 'commit',
    timestamp: at,
    type: 'hook:failed',
    hook: 'turn:after',
    failures: 1,
    error: 'boom',
  });
  await recorder.flush();
  const file = join(root, 'plugin-events.jsonl');
  // 钩子没有 taskId：报告里按 `hook:<名字>` 归组，与常驻任务同一条聚合路径。
  const [line] = (await readFile(file, 'utf8')).trim().split('\n');
  assert.equal(JSON.parse(line!).taskId, 'hook:turn:after');
  // 限流后只剩一条，但累计数写进去了：只看行数会把「一直在炸」读成「只坏过一次」。
  for (const failures of [2, 40])
    await appendFile(
      file,
      `${JSON.stringify({ at, pluginId: 'commit', taskId: 'hook:turn:after', tick: 0, failures, error: 'boom' })}\n`,
    );

  const report = await recorder.review();
  assert.deepEqual(report.pluginFailures, [
    { pluginId: 'commit', taskId: 'hook:turn:after', count: 40, lastAt: at, lastError: 'boom' },
  ]);
  const finding = report.findings.find((item) => item.kind === 'plugin-background')!;
  assert.equal(finding.occurrences, 40);
  assert.match(finding.title, /commit\/hook:turn:after/);
});

test('two tasks whose names sanitize alike keep separate review items', async (t) => {
  const { recorder, root } = await fixture(t);
  await mkdir(root, { recursive: true });
  const file = join(root, 'plugin-events.jsonl');
  // `tick:a` 与 `tick_a` 清洗后都是 `tick_a`：只按清洗结果拼 id，后一条会覆盖前一条。
  for (const taskId of ['tick:a', 'tick_a'])
    for (const tick of [1, 2, 3])
      await appendFile(
        file,
        `${JSON.stringify({ at, pluginId: 'relay', taskId, tick, failures: tick, error: 'refused' })}\n`,
      );

  const report = await recorder.review();
  assert.deepEqual(report.pluginFailures.map((row) => row.taskId).sort(), ['tick:a', 'tick_a']);
  const findings = report.findings.filter((item) => item.kind === 'plugin-background');
  assert.equal(findings.length, 2);
  // 干净的名字保持可读；被改写过的补摘要，两者不会撞在一起。
  assert.ok(findings.some((item) => item.id === 'plugin-background:relay:tick_a'));
  assert.ok(findings.some((item) => /^plugin-background:relay:tick_a-[a-f0-9]{8}$/.test(item.id)));
  for (const item of findings) await recorder.decide(item.id, 'accepted', '');
  assert.deepEqual(
    (await recorder.review()).findings.filter((item) => item.kind === 'plugin-background').map((item) => item.status),
    ['accepted', 'accepted'],
  );
});

test('a delegation row omits an average it cannot compute instead of writing zero', () => {
  const base = {
    version: 1 as const,
    id: 'run',
    sourceRunId: 1,
    sessionId: 'parent-session',
    sessionTitle: null,
    config,
    outcome: 'completed' as const,
    startedAt: at,
    requestCount: 0,
    toolCalls: 0,
    toolErrors: 0,
    expectedExits: 0,
    retries: 0,
    compactions: { local: 0, llm: 0, idle: 0 },
    inputTokens: 0,
    outputTokens: 7,
    cachedInputTokens: 0,
    droppedEvents: 0,
    eventCount: 0,
    traceFile: 'events.jsonl',
    promptHashes: [],
    findings: [],
    delegation: { type: 'Reviewer', parentSessionId: 'parent-session' },
  };
  // 老摘要可能没有这些计量字段：算不出来就整项不写，0 会被读成「一次请求都没花」。
  const incomplete = { ...base, requestCount: undefined, outputTokens: undefined } as unknown as RunSummary;
  assert.deepEqual(summarizeDelegation([incomplete]).parents[0]!.types[0], {
    type: 'Reviewer',
    runs: 1,
    completed: 1,
    failed: 0,
    aborted: 0,
  });
  // 有字段的运行照常参与平均：0 次请求是真的 0，就写 0。
  const complete = { ...base } as unknown as RunSummary;
  assert.deepEqual(summarizeDelegation([incomplete, complete]).parents[0]!.types[0], {
    type: 'Reviewer',
    runs: 2,
    completed: 2,
    failed: 0,
    aborted: 0,
    avgRequests: 0,
    avgOutputTokens: 7,
  });
});

test('a user correction is attached to the next run of its session and merges into one finding', async (t) => {
  const { recorder } = await fixture(t);
  const cwd = resolve('workspace-correction');
  recorder.noteCorrection({ sessionId: 'session', kind: 'edit', chars: 40 });
  recorder.noteCorrection({ sessionId: 'session', kind: 'edit', chars: 60 });
  recorder.noteCorrection({ sessionId: 'session', kind: 'recall' });

  const run = runner(recorder, { cwd });
  run.start('after corrections');
  run.finish();
  const report = await recorder.review(cwd);
  assert.deepEqual(report.runs[0].corrections, { edit: 2, recall: 1, retry: 0 });
  const findings = report.findings.filter((finding) => finding.kind === 'user-correction');
  assert.equal(findings.length, 2);
  const edit = findings.find((finding) => finding.title === '用户改写了上一轮的输入并重跑')!;
  assert.equal(edit.module, 'session');
  // 同会话同 kind 只有一条，出现次数就是纠正次数。
  assert.equal(edit.occurrences, 2);
  assert.match(edit.suggestion, /prompt 段落/);
  assert.match(edit.evidence[0]!.detail ?? '', /kind: edit; 2 correction\(s\)/);
  assert.match(edit.evidence[0]!.detail ?? '', /100 chars/);
  assert.equal(findings.find((finding) => finding.title === '用户撤回了还没发出的排队输入')?.occurrences, 1);

  // 取走即清空：下一次同一会话的运行不再重复带上这几条。
  const second = runner(recorder, { runId: 2, cwd });
  second.start('next run');
  second.finish();
  const next = await recorder.review(cwd);
  assert.equal(next.runs.find((item) => item.sourceRunId === 2)?.corrections, undefined);
  assert.equal(next.findings.filter((finding) => finding.kind === 'user-correction').length, 2);
  assert.equal(next.findings.find((finding) => finding.id === edit.id)?.occurrences, 2);
});

test('a correction without a session is dropped and reported, and attributed when one run is active', async (t) => {
  const { recorder } = await fixture(t);
  const cwd = resolve('workspace-correction-owner');
  // 没有任何运行在跑、也没给 sessionId：不猜归属，只计数。
  recorder.noteCorrection({ kind: 'edit' });
  const live = runner(recorder, { runId: 1, cwd });
  live.start('first run');
  // 此刻恰好一条会话在跑，这条纠正认得出属于谁。
  recorder.noteCorrection({ kind: 'retry' });
  live.finish();
  const second = runner(recorder, { runId: 2, cwd });
  second.start('second run');
  second.finish();

  const report = await recorder.review(cwd);
  const byRun = (id: number) => report.runs.find((run) => run.sourceRunId === id)!;
  assert.equal(byRun(1).corrections, undefined);
  assert.deepEqual(byRun(2).corrections, { edit: 0, recall: 0, retry: 1 });
  assert.equal(report.findings.filter((finding) => finding.kind === 'user-correction').length, 1);
  assert.ok(report.warnings.some((warning) => warning.includes('丢弃了 1 次无法确定会话的用户纠正')));
});

test('rebuild keeps recorded corrections and the findings derived from them', async (t) => {
  const { recorder, root } = await fixture(t);
  const cwd = resolve('workspace-correction-rebuild');
  recorder.noteCorrection({ sessionId: 'session', kind: 'edit' });
  recorder.noteCorrection({ sessionId: 'session', kind: 'retry' });
  const run = runner(recorder, { cwd });
  run.start('after corrections');
  run.finish();
  const before = await recorder.review(cwd);
  const corrections = before.findings.filter((finding) => finding.kind === 'user-correction');
  assert.equal(corrections.length, 2);
  assert.equal((await recorder.rebuild({ cwd })).rebuilt, 1);

  const after = await recorder.review(cwd);
  assert.deepEqual(after.runs[0].corrections, { edit: 1, recall: 0, retry: 1 });
  assert.deepEqual(
    after.findings
      .filter((finding) => finding.kind === 'user-correction')
      .map((finding) => [finding.id, finding.occurrences])
      .sort(),
    corrections.map((finding) => [finding.id, finding.occurrences]).sort(),
  );
  const stored = JSON.parse(await readFile(join(root, 'runs', after.runs[0].id, 'summary.json'), 'utf8'));
  assert.deepEqual(stored.corrections, { edit: 1, recall: 0, retry: 1 });
});

test('plugin install state is captured with a stable hash and dropped when unreadable', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'mica-harness-plugins-'));
  const root = join(temporary, 'capture');
  const statusFile = join(temporary, 'plugin-status.json');
  const errors: unknown[] = [];
  const recorder = new HarnessRecorder(
    root,
    (error) => {
      errors.push(error);
    },
    { pluginStatusPath: statusFile },
  );
  t.onTestFinished(async () => {
    await recorder.dispose();
    await rm(temporary, { recursive: true, force: true });
  });
  const entries = [
    { id: 'zz-skipped', status: 'skipped', error: '缺少宿主能力：desktop' },
    { id: 'a-loaded', status: 'loaded' },
    { id: 'm-failed', status: 'failed', error: 'boom' },
    { id: 'a-skipped', status: 'skipped' },
    { id: 'b-loaded', status: 'loaded' },
  ];
  const write = async (plugins: unknown[]): Promise<void> => {
    const file = { host: 'app-server', root: join(temporary, 'plugins'), updatedAt: at, plugins, loadFailed: [] };
    await writeFile(statusFile, JSON.stringify(file));
  };
  const emitRun = (runId: number): void => {
    const run = runner(recorder, { runId, cwd: resolve(`workspace-plugins-${runId}`) });
    run.start(`plugin snapshot ${runId}`);
    run.finish();
  };

  await write(entries);
  emitRun(1);
  const summary = (await recorder.review()).runs.find((run) => run.sourceRunId === 1)!;
  assert.equal(summary.plugins?.host, 'app-server');
  assert.equal(summary.plugins?.loaded, 2);
  assert.deepEqual(summary.plugins?.failed, ['m-failed']);
  assert.deepEqual(summary.plugins?.skipped, ['a-skipped', 'zz-skipped']);
  assert.match(summary.plugins!.hash, /^[a-f0-9]{12}$/);

  // 同一份状态换个顺序写盘：hash 必须不变，否则「插件集合变了」会被顺序噪声淹没。
  await write([...entries].reverse());
  emitRun(2);
  const reordered = (await recorder.review()).runs.find((run) => run.sourceRunId === 2)!;
  assert.equal(reordered.plugins?.hash, summary.plugins!.hash);
  assert.deepEqual(reordered.plugins?.skipped, summary.plugins!.skipped);

  // 文件缺失或损坏都只是「这一轮没有快照」：不报错、不生成问题条目。
  await rm(statusFile);
  emitRun(3);
  await writeFile(statusFile, '{not json');
  emitRun(4);
  const report = await recorder.review();
  for (const runId of [3, 4])
    assert.equal('plugins' in report.runs.find((run) => run.sourceRunId === runId)!, false, `run ${runId}`);
  assert.deepEqual(errors, []);
  assert.ok(!report.warnings.some((warning) => warning.includes('plugin-status')));
});
