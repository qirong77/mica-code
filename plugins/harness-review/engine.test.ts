import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'vitest';
import type { AgentObservationEvent } from '@packages/mica-plugin/index.js';
import { HarnessRecorder, type CaptureOptions, type RunSummary } from './engine.js';

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
  settings: { owner?: object; runId?: number; cwd?: string; title?: string; capture?: CaptureOptions } = {},
) {
  const owner = settings.owner ?? {};
  const session = {
    id: 'session',
    title: settings.title ?? 'Harness tests',
    cwd: settings.cwd ?? resolve('workspace-a'),
  };
  const emit = (event: Input): void =>
    recorder.observe(
      { owner, runId: settings.runId ?? 1, timestamp: at, ...event } as AgentObservationEvent,
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
  assert.ok((await recorder.review()).warnings.some((warning) => warning.includes('trace count differs')));
  const bad = { ...summary, toolCalls: -1 };
  await writeFile(join(root, 'runs', summary.id, 'summary.json'), JSON.stringify(bad));
  const report = await recorder.review();
  assert.equal(report.runs.length, 0);
  assert.ok(report.warnings.some((warning) => warning.includes('invalid summary schema')));
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

test('scope filtering precedes the 300-run limit and out-of-scope traces are never inspected', async (t) => {
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
  for (let index = 0; index < 300; index++) await clone(cwd);
  report = await recorder.review(cwd);
  assert.equal(report.runs.length, 300);
  assert.ok(!report.runs.some((item) => item.id === initial.id));
  assert.ok(
    report.warnings.some((warning) => warning.includes('300 most recently updated runs in the selected scope')),
  );
  assert.equal(report.warnings.filter((warning) => warning.includes('missing or unreadable trace')).length, 300);
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
