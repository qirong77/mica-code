import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import type { AgentObservationEvent } from '@packages/mica-plugin/index.js';

export type CaptureOptions = { captureContent: boolean; maxEventChars: number; maxEventsPerRun: number };
export type FindingStatus = 'open' | 'accepted' | 'dismissed' | 'validated' | 'regressed';
type Config = { providerId: string; protocol: string; model: string; effort: string; role: string };
type Outcome = 'running' | 'completed' | 'aborted' | 'error' | 'interrupted';
export type Evidence = { runId: string; seq: number; traceFile: string; available: boolean; detail?: string };
export type ReviewFinding = {
  id: string;
  kind: 'tool-error' | 'repeated-call' | 'run-error' | 'retry';
  title: string;
  module: string;
  suggestion: string;
  evaluation: string;
  status: FindingStatus;
  note?: string;
  updatedAt?: string;
  occurrences: number;
  evidence: Evidence[];
};
export type RunSummary = {
  version: 1;
  id: string;
  sourceRunId: number;
  sessionId: string | null;
  sessionTitle: string | null;
  cwd?: string;
  config: Config;
  outcome: Outcome;
  startedAt: string;
  finishedAt?: string;
  elapsedMs?: number;
  error?: string;
  requestCount: number;
  toolCalls: number;
  toolErrors: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  droppedEvents: number;
  eventCount: number;
  traceFile: string;
  promptHashes: { sha256: string; chars: number }[];
  findings: ReviewFinding[];
};
export type ReviewReport = {
  version: 1;
  generatedAt: string;
  root: string;
  cwd?: string;
  runs: RunSummary[];
  findings: ReviewFinding[];
  warnings: string[];
  scannedRuns: number;
  limits: { runs: number; findingsPerRun: number; evidencePerFinding: number };
  interpretation: string;
};
type StoredEvent = { seq: number; type: string; timestamp: string; [key: string]: unknown };
type Call = { name: string; argsHash: string };
type RunState = {
  summary: RunSummary;
  options: CaptureOptions;
  prepared?: boolean;
  seq: number;
  written: number;
  calls: Map<string, { count: number; first: number; name: string }>;
  pending: Map<string, Call>;
  candidates: Map<string, ReviewFinding>;
};
const MAX_RUNS = 300;
const MAX_SCANNED_RUNS = 10_000;
const MAX_FINDINGS = 100;
const MAX_EVIDENCE = 20;
const MAX_KEYS = 1000;
const STATUSES = new Set<FindingStatus>(['open', 'accepted', 'dismissed', 'validated', 'regressed']);
const OUTCOMES = new Set<Outcome>(['running', 'completed', 'aborted', 'error', 'interrupted']);
const SENSITIVE_KEY = /api.?key|access.?key|token|password|passwd|authorization|cookie|secret|credential|private.?key/i;
const POLLING =
  /(?:^|[._:/-])(?:wait_for|background_tasks_read|background_tasks_list|pty_read|read_terminal|terminal_read|wait|sleep|poll)(?:$|[._:/-])/i;
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

function canonicalCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    return resolve(cwd);
  }
}
function redactYamlBlocks(text: string): string {
  const lines = text.split('\n');
  const lineNumber = /^[ \t]*(?:L?\d+[ \t]*[|│:]|L?\d+\t)[ \t]?/;
  for (let index = 0; index < lines.length; index++) {
    const numbered = lines[index].match(lineNumber)?.[0];
    const header = lines[index].slice(numbered?.length ?? 0).match(
      /^([ \t]*)["']?(?:api[_-]?key|access[_-]?key|(?:access[_-]?|refresh[_-]?)?token|password|passwd|authorization|cookie|secret|credential|private[_-]?key)["']?[ \t]*:[ \t]*[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:#.*)?\r?$/i,
    );
    if (!header) continue;
    for (let next = index + 1; next < lines.length; next++) {
      const prefix = numbered ? lines[next].match(lineNumber)?.[0] ?? '' : '';
      const body = lines[next].slice(prefix.length);
      const indent = body.match(/^[ \t]*/)![0];
      if (body.trim() && indent.length <= header[1].length) break;
      if (body.trim()) lines[next] = prefix + indent + '[REDACTED]';
      index = next;
    }
  }
  return lines.join('\n');
}

/** Run before truncation, including when content capture is disabled. */
function redactText(text: string): string {
  return (
    redactYamlBlocks(text)
      .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|SECRET)[^-]*-----[\s\S]*?-----END [^-]+-----/g, '[REDACTED PRIVATE KEY]')
      .replace(/data:[^;,\s]+(?:;[^,\s]*)?;base64,[A-Za-z0-9+/=_\s-]+/gi, '[REDACTED BASE64]')
      .replace(/\bhttps?:\/\/[^\s/@]+:[^\s/@]+@/gi, (value) => `${value.slice(0, value.indexOf('://') + 3)}[REDACTED]@`)
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      .replace(
        /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g,
        '[REDACTED TOKEN]',
      )
      .replace(
        /((?:api[_-]?key|access[_-]?key|(?:access[_-]?|refresh[_-]?)?token|password|passwd|authorization|cookie|secret|credential|private[_-]?key)\s*["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;&}\]]+)([^\r\n]*)/gi,
        '$1[REDACTED]',
      )
      // Unlabelled image/base64 payloads are not useful review evidence.
      .replace(/[A-Za-z0-9+/]{256,}={0,2}/g, '[REDACTED BINARY]')
  );
}
function sanitize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    // JSON strings are common tool arguments/results; redact keys before storing or hashing.
    if (depth < 12 && /^[\s]*[\[{]/.test(value)) {
      try {
        return JSON.stringify(sanitize(JSON.parse(value), depth + 1, seen));
      } catch {
        /* plain text */
      }
    }
    return redactText(value);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'object') return String(value);
  if (depth >= 12 || seen.has(value)) return '[OMITTED]';
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) result = value.slice(0, MAX_KEYS).map((item) => sanitize(item, depth + 1, seen));
  else {
    const object: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort().slice(0, MAX_KEYS)) {
      object[redactText(key)] =
        SENSITIVE_KEY.test(key) || /^(?:base64|image_data|imageData)$/i.test(key)
          ? '[REDACTED]'
          : sanitize((value as Record<string, unknown>)[key], depth + 1, seen);
    }
    result = object;
  }
  seen.delete(value);
  return result;
}
function textOf(value: unknown): string {
  const safe = sanitize(value);
  return typeof safe === 'string' ? safe : (JSON.stringify(safe) ?? String(safe));
}
function canonicalArgs(args: string): string {
  try {
    return textOf(JSON.parse(args));
  } catch {
    return textOf(args);
  }
}
function boundedText(value: unknown, max = 1000): string {
  return textOf(value).slice(0, max);
}
function positive(value: number | undefined, fallback: number, max: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(max, Math.floor(value!))) : fallback;
}
function optionsOf(options: CaptureOptions): CaptureOptions {
  return {
    captureContent: options.captureContent === true,
    maxEventChars: positive(options.maxEventChars, 4000, 100_000),
    maxEventsPerRun: positive(options.maxEventsPerRun, 2000, 100_000),
  };
}
function payload(value: unknown, options: CaptureOptions): object {
  const text = textOf(value);
  return {
    sha256: digest(text),
    chars: text.length,
    ...(options.captureContent
      ? { content: text.slice(0, options.maxEventChars), truncated: text.length > options.maxEventChars }
      : {}),
  };
}
function errorCategory(raw: string, name: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* shell/plain result */
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const item = parsed as Record<string, unknown>;
    if (item.isError === true || item.success === false || item.ok === false || item.status === 'error') {
      return classifyError(textOf(item.error ?? item.message ?? item));
    }
    if (/(?:^|[.:/])run_shell$/.test(name)) {
      if (item.timed_out === true) return 'timeout';
      if (item.signal !== undefined && item.signal !== null) return 'signal';
      if (item.exit_code === null || item.exitCode === null) return 'tool-error';
      const exitCode = item.exitCode ?? item.exit_code;
      if (typeof exitCode === 'number' && Number.isInteger(exitCode) && exitCode !== 0) return `exit-${exitCode}`;
    }
    // A successful envelope can contain source text or logs beginning with Error:.
    return null;
  }
  // Only the shell tool's leading command envelope is metadata. Source files
  // and stdout can legitimately contain the same keys or entire sample blocks.
  if (/(?:^|[.:/])run_shell$/.test(name)) {
    const command = raw.match(
      /^\s*\[command\][ \t]*\r?\n([\s\S]*?)(?=\r?\n\[\/?(?:command|stdout|stderr|output)\]|$)/i,
    )?.[1];
    if (command !== undefined) {
      if (/^\s*timed_out\s*:\s*true\s*$/im.test(command)) return 'timeout';
      if (/^\s*signal\s*:\s*(?!null\s*$)\S+\s*$/im.test(command)) return 'signal';
      const code = command.match(/^\s*exit_code\s*:\s*(null|-?\d+)\s*$/im)?.[1];
      if (code === 'null') return 'tool-error';
      if (code !== undefined && Number(code) !== 0) return `exit-${code}`;
      return null;
    }
  }
  // Read-file content may contain the word Error anywhere. Only a tool error
  // prefix or explicit shell exit metadata is considered deterministic evidence.
  const exit = /(?:^|[.:/])run_shell$/.test(name)
    ? raw.match(/^\s*(?:Process exited with (?:code|status)|Exit code|Exit status)\s*[:=]?\s*(-?\d+)\b/i)
    : null;
  if (exit && Number(exit[1]) !== 0) return `exit-${exit[1]}`;
  if (/^(?:Error:|Tool (?:execution )?(?:error|failed):|工具[^\n]*(?:失败|错误)[:：])/i.test(raw.trimStart()))
    return classifyError(raw);
  return null;
}
function classifyError(text: string): string {
  if (/ENOENT|not found|no such file/i.test(text)) return 'not-found';
  if (/EACCES|EPERM|permission denied|unauthorized|forbidden/i.test(text)) return 'permission';
  if (/timeout|timed out|ETIMEDOUT/i.test(text)) return 'timeout';
  if (/invalid|validation|schema|argument/i.test(text)) return 'invalid-input';
  if (/rate.?limit|\b429\b/i.test(text)) return 'rate-limit';
  return 'tool-error';
}
function timestamp(value: string): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : new Date().toISOString();
}
function finiteCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class HarnessRecorder {
  private readonly root: string;
  private readonly owners = new WeakMap<object, Map<number, RunState>>();
  private readonly active = new Set<RunState>();
  private tail: Promise<void> = Promise.resolve();
  private readonly writeWarnings: string[] = [];
  private disposed = false;

  constructor(
    root: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.root = resolve(root);
  }

  private enqueue(work: () => Promise<void>): void {
    this.tail = this.tail.then(work).catch((error: unknown) => {
      if (this.writeWarnings.length < 100)
        this.writeWarnings.push(`Persistence error: ${boundedText(error instanceof Error ? error.message : error)}`);
      try {
        this.onError(error);
      } catch {
        /* reporting must not break the host task */
      }
    });
  }
  private async directory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
  private async atomic(path: string, data: string): Promise<void> {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
  private async runDirectory(state: RunState): Promise<string> {
    const directory = join(this.root, 'runs', state.summary.id);
    if (state.prepared) return directory;
    await this.directory(this.root);
    await this.directory(join(this.root, 'runs'));
    await this.directory(directory);
    // Even a zero-event capture has an empty, private trace alongside its summary.
    await appendFile(state.summary.traceFile, '', { mode: 0o600 });
    await chmod(state.summary.traceFile, 0o600);
    state.prepared = true;
    return directory;
  }
  private save(state: RunState): void {
    this.enqueue(async () => {
      const directory = await this.runDirectory(state);
      await this.atomic(join(directory, 'summary.json'), JSON.stringify(state.summary, null, 2));
    });
  }
  private addFinding(
    state: RunState,
    kind: ReviewFinding['kind'],
    key: string,
    seq: number,
    title: string,
    module: string,
    suggestion: string,
    evaluation: string,
    detail?: string,
  ): void {
    const id = digest(`${state.summary.cwd ?? ''}\n${kind}\n${key}`);
    let finding = state.candidates.get(id);
    if (!finding) {
      if (state.candidates.size >= MAX_FINDINGS) return;
      finding = { id, kind, title, module, suggestion, evaluation, status: 'open', occurrences: 0, evidence: [] };
      state.candidates.set(id, finding);
      state.summary.findings.push(finding);
    }
    finding.occurrences++;
    if (finding.evidence.length < MAX_EVIDENCE)
      finding.evidence.push({
        runId: state.summary.id,
        seq,
        traceFile: state.summary.traceFile,
        available: false,
        ...(detail ? { detail: boundedText(detail, 300) } : {}),
      });
  }

  observe(
    event: AgentObservationEvent,
    session: { id: string; title: string; cwd?: string } | null,
    options: CaptureOptions,
  ): void {
    if (this.disposed) return;
    try {
      this.capture(event, session, options);
    } catch (error) {
      try {
        this.onError(error);
      } catch {
        /* isolate observer failures */
      }
    }
  }
  private capture(
    event: AgentObservationEvent,
    session: { id: string; title: string; cwd?: string } | null,
    options: CaptureOptions,
  ): void {
    let runs = this.owners.get(event.owner);
    if (!runs) {
      runs = new Map();
      this.owners.set(event.owner, runs);
    }
    let state = runs.get(event.runId);
    if (event.type === 'run:start') {
      if (state) return;
      const id = randomUUID();
      const config: Config = {
        providerId: boundedText(event.config.providerId, 200),
        protocol: boundedText(event.config.protocol, 100),
        model: boundedText(event.config.model, 200),
        effort: boundedText(event.config.effort, 100),
        role: boundedText(event.config.role, 100),
      };
      state = {
        summary: {
          version: 1,
          id,
          sourceRunId: event.runId,
          sessionId: session ? boundedText(session.id, 300) : null,
          sessionTitle: session && options.captureContent === true ? boundedText(session.title, 500) : null,
          ...(session?.cwd ? { cwd: canonicalCwd(session.cwd) } : {}),
          config,
          outcome: 'running',
          startedAt: timestamp(event.timestamp),
          requestCount: 0,
          toolCalls: 0,
          toolErrors: 0,
          retries: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          droppedEvents: 0,
          eventCount: 0,
          traceFile: join(this.root, 'runs', id, 'events.jsonl'),
          promptHashes: [],
          findings: [],
        },
        options: optionsOf(options),
        seq: 0,
        written: 0,
        calls: new Map(),
        pending: new Map(),
        candidates: new Map(),
      };
      runs.set(event.runId, state);
      this.active.add(state);
      this.save(state);
    }
    if (!state) return;
    const seq = ++state.seq;
    state.summary.eventCount = seq;
    const stored: StoredEvent = { seq, type: event.type, timestamp: timestamp(event.timestamp) };
    switch (event.type) {
      case 'run:start':
        stored.config = copy(state.summary.config);
        stored.input = payload(event.input, state.options);
        break;
      case 'request:start': {
        state.summary.requestCount++;
        stored.messageCount = event.messageCount;
        const tools = (event as unknown as { tools?: unknown }).tools;
        if (tools !== undefined) stored.tools = payload(tools, state.options);
        break;
      }
      case 'prompt:resolved': {
        const fingerprint = { sha256: digest(event.prompt), chars: event.prompt.length };
        if (
          state.summary.promptHashes.length < 100 &&
          !state.summary.promptHashes.some((entry) => entry.sha256 === fingerprint.sha256)
        )
          state.summary.promptHashes.push(fingerprint);
        stored.prompt = fingerprint;
        break;
      }
      case 'history:rewritten':
        stored.beforeCount = event.beforeCount;
        stored.afterCount = event.afterCount;
        break;
      case 'tool:call': {
        state.summary.toolCalls++;
        const name = boundedText(event.name, 200);
        const argsHash = digest(canonicalArgs(event.args));
        const key = `${name}\n${argsHash}`;
        if (state.pending.size >= 200) state.pending.delete(state.pending.keys().next().value!);
        state.pending.set(event.id ?? `name:${name}`, { name, argsHash });
        let call = state.calls.get(key);
        if (!call && state.calls.size < MAX_KEYS) {
          call = { count: 0, first: seq, name };
          state.calls.set(key, call);
        }
        if (call) {
          call.count++;
          if (call.count >= 3 && !POLLING.test(name))
            this.addFinding(
              state,
              'repeated-call',
              key,
              seq,
              `Repeated call to ${name}`,
              name,
              'Inspect whether identical arguments are intentional; consider a progress check, caching, or clearer next-step guidance if the calls are redundant.',
              'Replay a comparable task and compare useful progress and call count. Polling, pagination, and changing external state can justify repeated calls.',
              `Identical redacted arguments; call ${call.count}. Repetition alone does not establish lack of progress.`,
            );
        }
        stored.name = name;
        stored.args = payload(event.args, state.options);
        stored.argsHash = argsHash;
        // Tool IDs are opaque correlation values; hash them rather than persist arbitrary content.
        if (event.id) stored.idHash = digest(event.id);
        break;
      }
      case 'tool:result': {
        const name = boundedText(event.name, 200);
        const pendingKey = event.id ?? `name:${name}`;
        const call = state.pending.get(pendingKey);
        state.pending.delete(pendingKey);
        const category = errorCategory(event.result, name);
        if (category) {
          state.summary.toolErrors++;
          this.addFinding(
            state,
            'tool-error',
            `${name}\n${call?.argsHash ?? 'unknown-arguments'}\n${category}`,
            seq,
            `Tool error in ${name}: ${category}`,
            name,
            'Review the failing call and its arguments; consider input validation, environment guidance, or bounded recovery when the cause is confirmed.',
            'Replay the same redacted argument pattern in a comparable environment and verify the tool succeeds and the task still meets its acceptance criteria.',
            `Error category: ${category}. A tool error does not establish task failure.`,
          );
        }
        stored.name = name;
        stored.result = payload(
          event.result,
          /(?:^|[.:/])harness_review$/.test(name) ? { ...state.options, captureContent: false } : state.options,
        );
        stored.errorCategory = category;
        if (event.id) stored.idHash = digest(event.id);
        break;
      }
      case 'usage': {
        const usage = {
          inputTokens: finiteCount(event.usage.inputTokens),
          outputTokens: finiteCount(event.usage.outputTokens),
          cachedInputTokens: finiteCount(event.usage.cachedInputTokens ?? 0),
        };
        state.summary.inputTokens += usage.inputTokens;
        state.summary.outputTokens += usage.outputTokens;
        state.summary.cachedInputTokens += usage.cachedInputTokens;
        stored.usage = usage;
        break;
      }
      case 'retry': {
        state.summary.retries++;
        stored.attempt = event.attempt;
        stored.delayMs = event.delayMs;
        stored.error = payload(event.error, state.options);
        const category = classifyError(event.error);
        this.addFinding(
          state,
          'retry',
          `${state.summary.config.providerId}\n${state.summary.config.model}\n${category}`,
          seq,
          `Request retry: ${category}`,
          'runtime',
          'Inspect provider availability, limits, and retry configuration before proposing a runtime change.',
          'Run comparable requests and compare retry rate, latency, and completion without masking persistent errors.',
          `Attempt ${event.attempt}; category ${category}.`,
        );
        break;
      }
      case 'run:finish': {
        state.summary.outcome = event.outcome;
        state.summary.finishedAt = timestamp(event.timestamp);
        state.summary.elapsedMs = finiteCount(event.elapsedMs);
        stored.outcome = event.outcome;
        stored.elapsedMs = state.summary.elapsedMs;
        if (event.error) {
          if (state.options.captureContent) state.summary.error = boundedText(event.error, state.options.maxEventChars);
          stored.error = payload(event.error, state.options);
        }
        if (event.outcome === 'error') {
          const category = classifyError(event.error ?? '');
          this.addFinding(
            state,
            'run-error',
            `${state.summary.config.providerId}\n${state.summary.config.model}\n${category}`,
            seq,
            `Run ended with an error: ${category}`,
            'runtime',
            'Inspect the final error and preceding trace before identifying a runtime or guidance change.',
            'Replay the original acceptance criteria and confirm both task completion and an independent user or test check.',
            `Runtime reported error: ${category}.`,
          );
        }
        break;
      }
    }
    if (state.written < state.options.maxEventsPerRun) {
      state.written++;
      // Serialize synchronously: no caller-owned objects survive into the queue.
      const line = `${JSON.stringify(stored)}\n`;
      const path = state.summary.traceFile;
      this.enqueue(async () => {
        await this.runDirectory(state!);
        await appendFile(path, line, { mode: 0o600 });
        for (const finding of state!.summary.findings)
          for (const evidence of finding.evidence) if (evidence.seq === seq) evidence.available = true;
      });
    } else state.summary.droppedEvents++;
    if (event.type === 'run:finish' || seq % 25 === 0) this.save(state);
    if (event.type === 'run:finish') {
      this.active.delete(state);
      runs.delete(event.runId);
    }
  }

  async flush(): Promise<void> {
    for (const state of this.active) this.save(state);
    await this.tail;
  }
  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      for (const state of this.active) {
        state.summary.outcome = 'interrupted';
        state.summary.finishedAt = new Date().toISOString();
        state.summary.elapsedMs = Math.max(
          0,
          Date.parse(state.summary.finishedAt) - Date.parse(state.summary.startedAt),
        );
        this.save(state);
      }
      this.active.clear();
    }
    await this.tail;
  }

  async review(cwd?: string): Promise<ReviewReport> {
    await this.flush();
    const filter = cwd ? canonicalCwd(cwd) : undefined;
    const warnings = [...this.writeWarnings];
    const runs: RunSummary[] = [];
    let entries: { id: string; modified: number }[] = [];
    try {
      const directories = await readdir(join(this.root, 'runs'), { withFileTypes: true });
      const candidates = directories.filter((entry) => entry.isDirectory());
      if (candidates.length > MAX_SCANNED_RUNS)
        warnings.push(
          `Global directory scan limited to ${MAX_SCANNED_RUNS} of ${candidates.length} runs before scope filtering; this review may be incomplete.`,
        );
      entries = await Promise.all(
        candidates.slice(0, MAX_SCANNED_RUNS).map(async (entry) => {
          try {
            return { id: entry.name, modified: (await stat(join(this.root, 'runs', entry.name))).mtimeMs };
          } catch {
            return { id: entry.name, modified: 0 };
          }
        }),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        warnings.push(`Cannot list runs: ${boundedText(String(error))}`);
    }
    entries.sort((a, b) => b.modified - a.modified || a.id.localeCompare(b.id));
    let scannedRuns = 0;
    for (const entry of entries) {
      scannedRuns++;
      const file = join(this.root, 'runs', entry.id, 'summary.json');
      try {
        const info = await stat(file);
        if (info.size > 4_000_000) throw new Error('summary exceeds size limit');
        const summary = JSON.parse(await readFile(file, 'utf8')) as RunSummary;
        if (!validSummary(summary, entry.id) || summary.traceFile !== join(this.root, 'runs', entry.id, 'events.jsonl'))
          throw new Error('invalid summary schema');
        if (summary.cwd) summary.cwd = canonicalCwd(summary.cwd);
        if (filter && summary.cwd !== filter) continue;
        if (runs.length >= MAX_RUNS) {
          warnings.push(`Review limited to the ${MAX_RUNS} most recently updated runs in the selected scope.`);
          break;
        }
        runs.push(summary);
        if (summary.outcome === 'running')
          warnings.push(
            `Run ${summary.id} has no finish event and remains running; it may still be active or have been interrupted by a process exit.`,
          );
        if (summary.outcome === 'interrupted')
          warnings.push(`Run ${summary.id} was interrupted before a finish event; task success is unknown.`);
        if (summary.droppedEvents > 0)
          warnings.push(
            `Run ${summary.id} omitted ${summary.droppedEvents} trace events at its capture limit; summary counters include them. Evidence without a stored event is marked unavailable.`,
          );
      } catch (error) {
        warnings.push(
          `Unreadable or corrupt run ${entry.id}: ${boundedText(error instanceof Error ? error.message : error)}`,
        );
      }
    }
    for (const summary of runs) await inspectTrace(summary, warnings);
    runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const merged = new Map<string, ReviewFinding>();
    for (const run of runs)
      for (const candidate of run.findings) {
        const existing = merged.get(candidate.id);
        if (!existing) {
          merged.set(candidate.id, copy(candidate));
          continue;
        }
        existing.occurrences += candidate.occurrences;
        existing.evidence.push(...candidate.evidence.slice(0, Math.max(0, MAX_EVIDENCE - existing.evidence.length)));
      }
    for (const finding of merged.values()) {
      try {
        const file = join(this.root, 'decisions', `${finding.id}.json`);
        if ((await stat(file)).size > 20_000) throw new Error('decision exceeds size limit');
        const decision = JSON.parse(await readFile(file, 'utf8')) as {
          id: string;
          status: FindingStatus;
          note: string;
          updatedAt?: string;
        };
        if (
          !decision ||
          decision.id !== finding.id ||
          !STATUSES.has(decision.status) ||
          typeof decision.note !== 'string' ||
          typeof decision.updatedAt !== 'string' ||
          !Number.isFinite(Date.parse(decision.updatedAt))
        )
          throw new Error('invalid decision schema');
        finding.status = decision.status;
        finding.note = boundedText(decision.note, 8000);
        finding.updatedAt = decision.updatedAt;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          warnings.push(`Unreadable decision ${finding.id}: ${boundedText(String(error))}`);
      }
    }
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      root: this.root,
      ...(filter ? { cwd: filter } : {}),
      runs,
      findings: [...merged.values()].sort((a, b) => b.occurrences - a.occurrences || a.id.localeCompare(b.id)),
      warnings,
      scannedRuns,
      limits: { runs: MAX_RUNS, findingsPerRun: MAX_FINDINGS, evidencePerFinding: MAX_EVIDENCE },
      interpretation:
        'Findings are review candidates, not established causes. Tool errors do not imply task failure. Completed runs are not user validation. Decisions are manual and persist across runs; repeated calls may reflect legitimate polling or pagination.',
    };
  }

  async decide(id: string, status: FindingStatus, note: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid finding ID');
    if (!STATUSES.has(status)) throw new Error('Invalid finding status');
    const data = JSON.stringify(
      { id, status, note: boundedText(note, 8000), updatedAt: new Date().toISOString() },
      null,
      2,
    );
    // Explicit user actions report write failures to the caller as well as onError.
    let failure: unknown;
    this.enqueue(async () => {
      try {
        await this.directory(this.root);
        await this.directory(join(this.root, 'decisions'));
        await this.atomic(join(this.root, 'decisions', `${id}.json`), data);
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    await this.tail;
    if (failure) throw failure;
  }

  async exportReport(cwd?: string): Promise<string> {
    const report = await this.review(cwd);
    const directory = join(this.root, 'reports');
    const path = join(directory, `review-${randomUUID()}.md`);
    let failure: unknown;
    this.enqueue(async () => {
      try {
        await this.directory(this.root);
        await this.directory(directory);
        await this.atomic(path, markdownReport(report, directory));
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    await this.tail;
    if (failure) throw failure;
    return path;
  }
}

function validSummary(value: RunSummary, directoryId: string): boolean {
  if (!value || value.version !== 1 || value.id !== directoryId || !OUTCOMES.has(value.outcome)) return false;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id)) return false;
  if (!Number.isInteger(value.sourceRunId) || value.sourceRunId < 0) return false;
  if (
    !(value.sessionId === null || typeof value.sessionId === 'string') ||
    !(value.sessionTitle === null || typeof value.sessionTitle === 'string')
  )
    return false;
  if (
    typeof value.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    typeof value.traceFile !== 'string'
  )
    return false;
  if (
    value.finishedAt !== undefined &&
    (typeof value.finishedAt !== 'string' || !Number.isFinite(Date.parse(value.finishedAt)))
  )
    return false;
  if (value.elapsedMs !== undefined && (!Number.isFinite(value.elapsedMs) || value.elapsedMs < 0)) return false;
  if (value.error !== undefined && typeof value.error !== 'string') return false;
  if (value.cwd !== undefined && typeof value.cwd !== 'string') return false;
  if (
    !value.config ||
    !['providerId', 'protocol', 'model', 'effort', 'role'].every(
      (key) => typeof value.config[key as keyof Config] === 'string',
    )
  )
    return false;
  if (
    ![
      'requestCount',
      'toolCalls',
      'toolErrors',
      'retries',
      'inputTokens',
      'outputTokens',
      'cachedInputTokens',
      'droppedEvents',
      'eventCount',
    ].every(
      (key) =>
        typeof value[key as keyof RunSummary] === 'number' &&
        Number.isFinite(value[key as keyof RunSummary]) &&
        Number(value[key as keyof RunSummary]) >= 0,
    )
  )
    return false;
  if (
    !['requestCount', 'toolCalls', 'toolErrors', 'retries', 'droppedEvents', 'eventCount'].every((key) =>
      Number.isInteger(value[key as keyof RunSummary]),
    ) ||
    value.droppedEvents > value.eventCount
  )
    return false;
  if (
    !Array.isArray(value.promptHashes) ||
    value.promptHashes.length > 100 ||
    !Array.isArray(value.findings) ||
    value.findings.length > MAX_FINDINGS
  )
    return false;
  if (
    !value.promptHashes.every(
      (item) => item && /^[a-f0-9]{64}$/.test(item.sha256) && Number.isInteger(item.chars) && item.chars >= 0,
    )
  )
    return false;
  return value.findings.every(
    (finding) =>
      finding &&
      /^[a-f0-9]{64}$/.test(finding.id) &&
      ['tool-error', 'repeated-call', 'run-error', 'retry'].includes(finding.kind) &&
      ['title', 'module', 'suggestion', 'evaluation'].every(
        (key) => typeof finding[key as keyof ReviewFinding] === 'string',
      ) &&
      STATUSES.has(finding.status) &&
      Number.isInteger(finding.occurrences) &&
      finding.occurrences > 0 &&
      Array.isArray(finding.evidence) &&
      finding.evidence.length <= MAX_EVIDENCE &&
      finding.evidence.every(
        (evidence) =>
          evidence &&
          evidence.runId === value.id &&
          Number.isInteger(evidence.seq) &&
          evidence.seq > 0 &&
          evidence.seq <= value.eventCount &&
          evidence.traceFile === value.traceFile &&
          (evidence.available === undefined || typeof evidence.available === 'boolean') &&
          (evidence.detail === undefined || typeof evidence.detail === 'string'),
      ),
  );
}

async function inspectTrace(summary: RunSummary, warnings: string[]): Promise<void> {
  const evidence = summary.findings.flatMap((finding) => finding.evidence);
  const bySeq = new Map<number, Evidence[]>();
  for (const item of evidence) {
    item.available = false;
    const items = bySeq.get(item.seq) ?? [];
    items.push(item);
    bySeq.set(item.seq, items);
  }
  try {
    const info = await stat(summary.traceFile);
    if (info.size > 20_000_000) {
      warnings.push(`Run ${summary.id} trace exceeds the 20 MB inspection limit; integrity was not checked.`);
      return;
    }
    const text = await readFile(summary.traceFile, 'utf8');
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    let previous = 0;
    for (let index = 0; index < lines.length; index++) {
      try {
        const event = JSON.parse(lines[index]) as StoredEvent;
        if (
          !event ||
          !Number.isInteger(event.seq) ||
          event.seq !== previous + 1 ||
          typeof event.type !== 'string' ||
          typeof event.timestamp !== 'string' ||
          !Number.isFinite(Date.parse(event.timestamp))
        )
          throw new Error('invalid event');
        previous = event.seq;
        for (const item of bySeq.get(event.seq) ?? []) item.available = true;
      } catch {
        warnings.push(`Run ${summary.id} has a corrupt trace at line ${index + 1}.`);
        return;
      }
    }
    if (lines.length !== summary.eventCount - summary.droppedEvents)
      warnings.push(
        `Run ${summary.id} trace count differs from its summary; events may be missing or the run may still be active.`,
      );
  } catch {
    warnings.push(`Run ${summary.id} has a missing or unreadable trace: ${summary.traceFile}`);
  }
}

function markdownText(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/([\\`*_{}\[\]()<>|#!])/g, '\\$1');
}
function markdownReport(report: ReviewReport, directory: string): string {
  const link = (file: string): string =>
    encodeURI(relative(directory, file).split('\\').join('/')).replace(/</g, '%3C').replace(/>/g, '%3E');
  const lines = [
    '# Harness review',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    `Scope: ${markdownText(report.cwd ?? 'all working directories')}`,
    '',
    report.interpretation,
    '',
    `Scanned ${report.scannedRuns} runs; ${report.runs.length} in scope; ${report.findings.length} aggregated findings.`,
    '',
    '## Runs',
    '',
    '| Run | Outcome | Model | Requests | Tools / errors | Retries | Tokens in / out / cached | Dropped events |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const run of report.runs)
    lines.push(
      `| [${run.id}](<${link(run.traceFile)}>) | ${run.outcome} | ${markdownText(run.config.model)} | ${run.requestCount} | ${run.toolCalls} / ${run.toolErrors} | ${run.retries} | ${run.inputTokens} / ${run.outputTokens} / ${run.cachedInputTokens} | ${run.droppedEvents} |`,
    );
  if (!report.runs.length) lines.push('', 'No runs in this scope.');
  lines.push('', '## Findings', '');
  if (!report.findings.length) lines.push('No findings recorded.', '');
  for (const finding of report.findings) {
    lines.push(
      `### ${markdownText(finding.title)}`,
      '',
      `ID: ${finding.id}`,
      '',
      `Status: **${finding.status}** · Occurrences: ${finding.occurrences} · Module: ${markdownText(finding.module)}`,
      '',
      `Suggestion: ${markdownText(finding.suggestion)}`,
      '',
      `Evaluation: ${markdownText(finding.evaluation)}`,
      '',
    );
    if (finding.note) lines.push(`Decision note: ${markdownText(finding.note)}`, '');
    if (finding.updatedAt) lines.push(`Decision updated: ${markdownText(finding.updatedAt)}`, '');
    for (const evidence of finding.evidence) {
      const label = `Run ${evidence.runId}, event ${evidence.seq}`;
      lines.push(
        `- ${evidence.available ? `[${label}](<${link(evidence.traceFile)}>)` : `${label} — evidence unavailable (summary metadata only)`}${evidence.detail ? `: ${markdownText(evidence.detail)}` : ''}`,
      );
    }
    lines.push('');
  }
  lines.push('## Warnings', '');
  lines.push(...(report.warnings.length ? report.warnings.map((warning) => `- ${markdownText(warning)}`) : ['None.']));
  lines.push(
    '',
    `Review limits: ${report.limits.runs} runs, ${report.limits.findingsPerRun} findings per run, ${report.limits.evidencePerFinding} evidence items per finding.`,
    '',
  );
  return lines.join('\n');
}
