import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
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
  /** Workspace this aggregation belongs to. Findings are keyed per workspace, so
   *  a global review shows the same cause once per project — without this the
   *  rows are indistinguishable. */
  cwd?: string;
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
const MAX_PENDING_TRACE_BYTES = 4 * 1024 * 1024;
const STATUSES = new Set<FindingStatus>(['open', 'accepted', 'dismissed', 'validated', 'regressed']);
const OUTCOMES = new Set<Outcome>(['running', 'completed', 'aborted', 'error', 'interrupted']);
const SENSITIVE_KEY = /api.?key|access.?key|token|password|passwd|authorization|cookie|secret|credential|private.?key/i;
const POLLING =
  /(?:^|[._:/-])(?:wait_for|background_tasks_read|background_tasks_list|pty_read|read_terminal|terminal_read|wait|sleep|poll)(?:$|[._:/-])/i;
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Stored payloads keep the original text under `content` (or drop it entirely in
 * metadata-only mode). Rebuilding has to read the text back out to classify it.
 */
function storedText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    if (typeof item.content === 'string') return item.content;
    if (typeof item.message === 'string') return item.message;
  }
  return value === undefined ? '' : JSON.stringify(value);
}

function hasCompleteContent(value: unknown): boolean {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.content === 'string' && item.truncated !== true;
}

/** Bytes on disk for one run directory, so prune can report what it reclaimed. */
async function directorySize(directory: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(target);
    else
      try {
        total += (await stat(target)).size;
      } catch {
        /* vanished between readdir and stat */
      }
  }
  return total;
}

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
    const header = lines[index]
      .slice(numbered?.length ?? 0)
      .match(
        /^([ \t]*)["']?(?:api[_-]?key|access[_-]?key|(?:access[_-]?|refresh[_-]?)?token|password|passwd|authorization|cookie|secret|credential|private[_-]?key)["']?[ \t]*:[ \t]*[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:#.*)?\r?$/i,
      );
    if (!header) continue;
    for (let next = index + 1; next < lines.length; next++) {
      const prefix = numbered ? (lines[next].match(lineNumber)?.[0] ?? '') : '';
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
/**
 * Per-cause guidance for a failing tool call. A review item whose suggestion is
 * the same sentence for every cause tells the user nothing they could not see in
 * the title, which is exactly what real runs produced: 13 `apply_patch` failures
 * collapsed into one paragraph of generic advice. Keys come from classifyError
 * and errorCategory.
 */
function errorGuidance(name: string, category: string): { suggestion: string; evaluation: string } {
  const patch = /(?:^|[.:/])apply_patch$/.test(name);
  if (category === 'empty-hunk')
    return {
      suggestion:
        'patch 里的 hunk 没有任何增删行——通常是把上下文行当成了修改内容。整段重写，或补上真实的 +/- 行后再提交。',
      evaluation: '重放同一处编辑，确认发出的 patch 至少含一行增删，且目标文件最终内容与预期一致。',
    };
  if (category === 'invalid-patch-header')
    return {
      suggestion:
        'patch 缺少 *** Begin Patch 包裹，或被截断、加了额外前缀。检查生成 patch 的拼接方式（heredoc、多段模板）后重新发送。',
      evaluation: '用同一段构造流程再生成一次 patch，对比发出内容的首尾是否完整。',
    };
  if (category === 'patch-context-mismatch')
    return {
      suggestion:
        'patch 的上下文与文件当前内容不一致：改动前没重读文件，或文件已被其他会话改写。改前重新 read_file 定位目标行。',
      evaluation: '重放同一处修改，确认读取发生在最后一次写入之后，patch 一次即成功。',
    };
  if (category === 'not-found')
    return {
      suggestion: '目标路径不存在。确认路径按当前 cwd 解析，大小写与扩展名和仓库实际一致。',
      evaluation: '用同一路径先 list_files 或 rg 确认存在，再重放原调用。',
    };
  if (category === 'permission')
    return {
      suggestion: '权限被拒。确认是否在写受保护目录，或该操作本应交由用户执行。',
      evaluation: '在同一用户、同一目录下重放等价的最小权限命令。',
    };
  if (category === 'timeout')
    return {
      suggestion:
        '调用超时。耗时命令改用 background_tasks_start 启动，再用 wait_for / background_tasks_read 取结果，不要靠调大前台超时。',
      evaluation: '把同一命令改为后台启动，确认它能正常结束且输出可取回。',
    };
  if (category === 'invalid-input')
    return {
      suggestion: '参数不合法。按工具 schema 校正字段名、类型与取值范围，避免用同类错误参数连续重试。',
      evaluation: '用校正后的参数重放，确认工具正常执行。',
    };
  if (category === 'rate-limit')
    return {
      suggestion: '被上游限流。降低并发或请求频率，必要时退避后重试。',
      evaluation: '在相同负载下重放，确认不再触发限流。',
    };
  if (category === 'signal')
    return {
      suggestion:
        '命令被信号终止（可能是用户中断或系统回收）。确认是否该由后台任务承载，并在重试前检查是否有残留进程。',
      evaluation: '重放同一命令，确认它不再被外部信号打断。',
    };
  if (/^exit-\d+$/.test(category))
    return {
      suggestion: `命令以非零退出码结束（${category.slice(5)}）。先读该命令的实际输出定位失败点，而不是原样重试；检查类命令要看是不是把"有差异"当成了失败。`,
      evaluation: '重放同一命令并查看完整 stdout/stderr，确认退出码变为 0 或失败原因已被解释。',
    };
  return {
    suggestion: patch
      ? '按失败原文定位具体规则：先读一次目标文件，再用最小 patch 验证。'
      : '读失败原文定位原因；确认是参数、环境还是外部状态问题后再重试，避免同类调用连续失败。',
    evaluation: '在与失败时相当的环境里重放同一调用，确认成功且任务验收标准仍然满足。',
  };
}

function classifyError(text: string): string {
  // Tool-specific causes first: the generic rules below would swallow these
  // ("context not found" looks like a missing file) and every occurrence would
  // collapse into one uninformative `tool-error`.
  if (/hunk 没有任何增删内容|hunk (?:has|contains) no (?:changes|additions|removals)/i.test(text)) {
    return 'empty-hunk';
  }
  if (/\*\*\* Begin Patch|必须以.*Begin Patch|must (?:start|begin) with \*\*\* Begin Patch/i.test(text)) {
    return 'invalid-patch-header';
  }
  if (
    // Real runs also produced `Update File 失败：<path> 中找不到 hunk 对应内容`,
    // which means the same thing as the English forms.
    /context not found|old_string[^\n]*not found|invalid context|hunk failed|patch (?:does not apply|failed)|找不到 ?hunk|找不到要替换的内容/i.test(
      text,
    )
  ) {
    return 'patch-context-mismatch';
  }
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
  private readonly pendingWrites = new Map<
    RunState,
    { lines: string[]; sequences: Set<number>; bytes: number; checkpoint: boolean }
  >();
  private pendingTraceBytes = 0;
  private drainScheduled = false;

  constructor(
    root: string,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.root = resolve(root);
  }

  private enqueue(work: () => Promise<void>): void {
    this.tail = this.tail.then(work).catch((error: unknown) => this.persistenceError(error));
  }
  private persistenceError(error: unknown): void {
    if (this.writeWarnings.length < 100)
      this.writeWarnings.push(`Persistence error: ${boundedText(error instanceof Error ? error.message : error)}`);
    try {
      this.onError(error);
    } catch {
      /* reporting must not break the host task */
    }
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
  private save(state: RunState, line?: string, seq?: number): boolean {
    let batch = this.pendingWrites.get(state);
    if (!batch) {
      batch = { lines: [], sequences: new Set(), bytes: 0, checkpoint: false };
      this.pendingWrites.set(state, batch);
    }
    if (line === undefined) batch.checkpoint = true;
    const bytes = line === undefined ? 0 : Buffer.byteLength(line);
    const accepted = this.pendingTraceBytes + bytes <= MAX_PENDING_TRACE_BYTES;
    if (line !== undefined && accepted) {
      batch.lines.push(line);
      batch.sequences.add(seq!);
      batch.bytes += bytes;
      this.pendingTraceBytes += bytes;
    }
    if (this.drainScheduled) return accepted;
    this.drainScheduled = true;
    this.enqueue(async () => {
      try {
        while (this.pendingWrites.size > 0) {
          const [current, pending] = this.pendingWrites.entries().next().value!;
          this.pendingWrites.delete(current);
          try {
            const directory = await this.runDirectory(current);
            if (pending.lines.length > 0) {
              await appendFile(current.summary.traceFile, pending.lines.join(''), { mode: 0o600 });
              for (const finding of current.summary.findings)
                for (const evidence of finding.evidence)
                  if (pending.sequences.has(evidence.seq)) evidence.available = true;
            }
            if (pending.checkpoint)
              await this.atomic(join(directory, 'summary.json'), JSON.stringify(current.summary, null, 2));
          } catch (error) {
            // A failed run directory must not block persistence for other owners.
            this.persistenceError(error);
          } finally {
            // In-flight lines still occupy memory until their append completes.
            this.pendingTraceBytes -= pending.bytes;
          }
        }
      } finally {
        this.drainScheduled = false;
      }
    });
    return accepted;
  }
  /**
   * Findings are derived data, so the live writer and `rebuild` must share one
   * implementation: anything derivable from a stored trace has to be derivable
   * again later, otherwise a classification fix can never reach existing runs.
   */
  private noteToolCall(
    state: RunState,
    seq: number,
    name: string,
    args: string,
    correlation?: string,
    recordedHash?: string,
  ): string {
    const argsHash = recordedHash ?? digest(canonicalArgs(args));
    const pendingKey = correlation ?? `name:${name}`;
    if (state.pending.size >= 200) state.pending.delete(state.pending.keys().next().value!);
    state.pending.set(pendingKey, { name, argsHash });
    const key = `${name}\n${argsHash}`;
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
          '同一工具用完全相同的参数被连续调用多次。确认是有意为之（轮询、分页、外部状态在变），否则补一次进度判断或改用能一次拿到结果的方式。',
          '重放同类任务，对比调用次数与实际推进量。轮询、分页与外部状态变化可以正当地重复调用。',
          `Identical redacted arguments; call ${call.count}. Repetition alone does not establish lack of progress.`,
        );
    }
    return argsHash;
  }

  private noteToolResult(
    state: RunState,
    seq: number,
    name: string,
    result: string,
    correlation?: string,
    recordedCategory?: string | null,
  ): string | null {
    const pendingKey = correlation ?? `name:${name}`;
    const call = state.pending.get(pendingKey);
    state.pending.delete(pendingKey);
    const category = recordedCategory === undefined ? errorCategory(result, name) : recordedCategory;
    if (!category) return null;
    state.summary.toolErrors++;
    const guidance = errorGuidance(name, category);
    this.addFinding(
      state,
      'tool-error',
      // Keyed by tool + cause, not by arguments: the suggestion is identical for
      // every call, so per-argument keys turned one recurring failure (10 empty
      // hunks in a single run) into 10 look-alike review items. The argument
      // fingerprint stays in the evidence detail for tracing.
      `${name}\n${category}`,
      seq,
      `Tool error in ${name}: ${category}`,
      name,
      guidance.suggestion,
      guidance.evaluation,
      `Error category: ${category}; arguments ${call?.argsHash?.slice(0, 12) ?? 'unknown'}. A tool error does not establish task failure.`,
    );
    return category;
  }

  private noteRuntimeError(
    state: RunState,
    seq: number,
    kind: 'retry' | 'run-error',
    category: string,
    attempt?: number,
  ): void {
    const retry = kind === 'retry';
    this.addFinding(
      state,
      kind,
      `${state.summary.config.providerId}\n${state.summary.config.model}\n${category}`,
      seq,
      retry ? `Request retry: ${category}` : `Run ended with an error: ${category}`,
      'runtime',
      retry
        ? 'Inspect provider availability, limits, and retry configuration before proposing a runtime change.'
        : 'Inspect the final error and preceding trace before identifying a runtime or guidance change.',
      retry
        ? 'Run comparable requests and compare retry rate, latency, and completion without masking persistent errors.'
        : 'Replay the original acceptance criteria and confirm both task completion and an independent user or test check.',
      retry ? `Attempt ${attempt}; category ${category}.` : `Runtime reported error: ${category}.`,
    );
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
      finding = {
        id,
        kind,
        title,
        module,
        suggestion,
        evaluation,
        status: 'open',
        occurrences: 0,
        ...(state.summary.cwd ? { cwd: state.summary.cwd } : {}),
        evidence: [],
      };
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
    const captureTrace = state.written < state.options.maxEventsPerRun;
    const stored: StoredEvent = { seq, type: event.type, timestamp: timestamp(event.timestamp) };
    switch (event.type) {
      case 'run:start':
        stored.config = copy(state.summary.config);
        if (captureTrace) stored.input = payload(event.input, state.options);
        break;
      case 'request:start': {
        state.summary.requestCount++;
        stored.messageCount = event.messageCount;
        const tools = (event as unknown as { tools?: unknown }).tools;
        if (captureTrace && tools !== undefined) stored.tools = payload(tools, state.options);
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
        const argsHash = this.noteToolCall(state, seq, name, event.args, event.id ? digest(event.id) : undefined);
        stored.name = name;
        if (captureTrace) stored.args = payload(event.args, state.options);
        stored.argsHash = argsHash;
        // Tool IDs are opaque correlation values; hash them rather than persist arbitrary content.
        if (event.id) stored.idHash = digest(event.id);
        break;
      }
      case 'tool:result': {
        const name = boundedText(event.name, 200);
        const category = this.noteToolResult(state, seq, name, event.result, event.id ? digest(event.id) : undefined);
        stored.name = name;
        if (captureTrace)
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
        if (captureTrace) stored.error = payload(event.error, state.options);
        const category = classifyError(event.error);
        stored.errorCategory = category;
        this.noteRuntimeError(state, seq, 'retry', category, event.attempt);
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
          if (captureTrace) stored.error = payload(event.error, state.options);
        }
        if (event.outcome === 'error') {
          const category = classifyError(event.error ?? '');
          stored.errorCategory = category;
          this.noteRuntimeError(state, seq, 'run-error', category);
        }
        break;
      }
    }
    if (captureTrace) {
      // Serialize synchronously: no caller-owned objects survive into the queue.
      const line = `${JSON.stringify(stored)}\n`;
      if (this.save(state, line, seq)) state.written++;
      else state.summary.droppedEvents++;
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

  /**
   * Delete run directories older than `olderThanDays`. Manual only: retaining
   * history is the point of the plugin, and the data lives under `$MICA_HOME`
   * (not a temp dir), so nothing here deletes on a schedule. Runs without a
   * finish event are always kept — they may belong to a live session.
   */
  async prune(options: { olderThanDays: number; cwd?: string }): Promise<{
    deletedRuns: number;
    keptRuns: number;
    freedBytes: number;
    skippedActive: number;
  }> {
    await this.flush();
    if (!Number.isFinite(options.olderThanDays) || options.olderThanDays < 1)
      throw new Error('Invalid retention window');
    const days = Math.max(1, Math.floor(options.olderThanDays));
    const cutoff = Date.now() - days * 86_400_000;
    const scope = options.cwd ? canonicalCwd(options.cwd) : undefined;
    let deletedRuns = 0;
    let keptRuns = 0;
    let freedBytes = 0;
    let skippedActive = 0;
    let entries: { name: string }[] = [];
    try {
      entries = (await readdir(join(this.root, 'runs'), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { deletedRuns, keptRuns, freedBytes, skippedActive };
      throw error;
    }
    for (const entry of entries) {
      const directory = join(this.root, 'runs', entry.name);
      let summary: RunSummary | null = null;
      try {
        const file = join(directory, 'summary.json');
        if ((await stat(file)).size > 4_000_000) throw new Error('summary exceeds size limit');
        summary = JSON.parse(await readFile(file, 'utf8')) as RunSummary;
        if (!validSummary(summary, entry.name)) throw new Error('invalid summary schema');
      } catch {
        // Unreadable runs carry no evidence: keep them so the review keeps
        // reporting them as corrupt instead of silently disappearing.
        keptRuns++;
        continue;
      }
      if (scope && (!summary.cwd || canonicalCwd(summary.cwd) !== scope)) {
        keptRuns++;
        continue;
      }
      if (summary.outcome === 'running') {
        keptRuns++;
        skippedActive++;
        continue;
      }
      const endedAt = Date.parse(summary.finishedAt ?? summary.startedAt);
      if (!Number.isFinite(endedAt) || endedAt >= cutoff) {
        keptRuns++;
        continue;
      }
      const size = await directorySize(directory);
      try {
        await rm(directory, { recursive: true, force: true });
        deletedRuns++;
        freedBytes += size;
      } catch (error) {
        this.onError(error);
        keptRuns++;
      }
    }
    return { deletedRuns, keptRuns, freedBytes, skippedActive };
  }

  /**
   * Re-derive findings for stored runs from their traces. Findings are derived
   * data and traces are the source of truth, so a classification fix (or a
   * changed aggregation key) can be applied to runs recorded before it — without
   * this, every historical run keeps the old fragmented findings forever.
   *
   * Counters, timings and outcome are left untouched: traces may have dropped
   * events at the capture limit, so recomputing them would undercount. Only
   * `findings` is replaced.
   */
  async rebuild(options: { cwd?: string } = {}): Promise<{
    rebuilt: number;
    findings: number;
    skippedRunning: number;
    skippedUnreadable: number;
  }> {
    await this.flush();
    const scope = options.cwd ? canonicalCwd(options.cwd) : undefined;
    let rebuilt = 0;
    let findings = 0;
    let skippedRunning = 0;
    let skippedUnreadable = 0;
    let entries: string[] = [];
    try {
      entries = (await readdir(join(this.root, 'runs'), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { rebuilt, findings, skippedRunning, skippedUnreadable };
      throw error;
    }
    for (const id of entries) {
      const directory = join(this.root, 'runs', id);
      let summary: RunSummary;
      try {
        const file = join(directory, 'summary.json');
        if ((await stat(file)).size > 4_000_000) throw new Error('summary exceeds size limit');
        summary = JSON.parse(await readFile(file, 'utf8')) as RunSummary;
        if (!validSummary(summary, id) || summary.traceFile !== join(directory, 'events.jsonl'))
          throw new Error('invalid summary schema');
      } catch {
        skippedUnreadable++;
        continue;
      }
      if (scope && (!summary.cwd || canonicalCwd(summary.cwd) !== scope)) continue;
      // A live run keeps deriving findings in memory and would overwrite this on
      // its next checkpoint; leave it alone.
      if (summary.outcome === 'running') {
        skippedRunning++;
        continue;
      }
      // 被采集上限截断的轨迹无法恢复全部问题，不能拿部分结果覆盖已有证据。
      if (summary.droppedEvents > 0) {
        skippedUnreadable++;
        continue;
      }
      let lines: string[];
      try {
        if ((await stat(summary.traceFile)).size > 20_000_000) throw new Error('trace exceeds size limit');
        lines = (await readFile(summary.traceFile, 'utf8')).split('\n').filter(Boolean);
      } catch {
        skippedUnreadable++;
        continue;
      }
      const state: RunState = {
        summary: { ...summary, findings: [] },
        options: { captureContent: false, maxEventChars: 4000, maxEventsPerRun: 2000 },
        seq: 0,
        written: lines.length,
        calls: new Map(),
        pending: new Map(),
        candidates: new Map(),
      };
      let expected = 0;
      let usable = true;
      for (const line of lines) {
        let event: StoredEvent;
        try {
          event = JSON.parse(line) as StoredEvent;
        } catch {
          usable = false;
          break;
        }
        // seq must stay consecutive: evidence points at it by number.
        if (
          !event ||
          event.seq !== ++expected ||
          typeof event.type !== 'string' ||
          typeof event.timestamp !== 'string' ||
          !Number.isFinite(Date.parse(event.timestamp))
        ) {
          usable = false;
          break;
        }
        const hasArgsHash = typeof event.argsHash === 'string' && /^[a-f0-9]{64}$/.test(event.argsHash);
        const hasCategory = typeof event.errorCategory === 'string' || event.errorCategory === null;
        if (
          (event.type === 'tool:call' && !hasArgsHash && !hasCompleteContent(event.args)) ||
          (event.type === 'tool:result' && !hasCategory && !hasCompleteContent(event.result)) ||
          ((event.type === 'retry' || (event.type === 'run:finish' && event.outcome === 'error')) &&
            typeof event.errorCategory !== 'string' &&
            !hasCompleteContent(event.error))
        ) {
          usable = false;
          break;
        }
        this.replay(state, event);
      }
      if (!usable || expected !== summary.eventCount) {
        skippedUnreadable++;
        continue;
      }
      // Every replayed event exists on disk, so re-derived evidence is traceable.
      for (const finding of state.candidates.values())
        for (const evidence of finding.evidence) evidence.available = true;
      const replaced = [...state.candidates.values()];
      try {
        // Another mica process (desktop app-server, CLI) may be writing this run
        // right now. Re-read before replacing so a run that went back to
        // `running` keeps its live findings instead of ours.
        const latest = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')) as RunSummary;
        if (latest.outcome === 'running' || latest.finishedAt !== summary.finishedAt) {
          skippedRunning++;
          continue;
        }
        await this.atomic(join(directory, 'summary.json'), JSON.stringify({ ...summary, findings: replaced }, null, 2));
        rebuilt++;
        findings += replaced.length;
      } catch (error) {
        this.onError(error);
        skippedUnreadable++;
      }
    }
    return { rebuilt, findings, skippedRunning, skippedUnreadable };
  }

  /** Replay one stored event through the same derivation the live writer uses. */
  private replay(state: RunState, event: StoredEvent): void {
    const seq = event.seq;
    // The persisted idHash is what correlates a call with its result on replay.
    const correlation = typeof event.idHash === 'string' ? event.idHash : undefined;
    const name = boundedText(String(event.name ?? ''), 200);
    if (event.type === 'tool:call') {
      const argsHash =
        typeof event.argsHash === 'string' && /^[a-f0-9]{64}$/.test(event.argsHash) ? event.argsHash : undefined;
      this.noteToolCall(state, seq, name, storedText(event.args), correlation, argsHash);
    } else if (event.type === 'tool:result') {
      const category =
        !hasCompleteContent(event.result) && (typeof event.errorCategory === 'string' || event.errorCategory === null)
          ? event.errorCategory
          : undefined;
      this.noteToolResult(state, seq, name, storedText(event.result), correlation, category);
    } else if (event.type === 'retry' || (event.type === 'run:finish' && event.outcome === 'error')) {
      const category =
        !hasCompleteContent(event.error) && typeof event.errorCategory === 'string'
          ? event.errorCategory
          : classifyError(storedText(event.error));
      this.noteRuntimeError(
        state,
        seq,
        event.type === 'retry' ? 'retry' : 'run-error',
        category,
        Number(event.attempt),
      );
    }
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
          event.seq <= previous ||
          (summary.droppedEvents === 0 && event.seq !== previous + 1) ||
          event.seq > summary.eventCount ||
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
      ...(finding.cwd ? [`Workspace: ${markdownText(finding.cwd)}`, ''] : []),
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
