import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import type { AgentObservationEvent } from '@packages/mica-plugin/index.js';

export type CaptureOptions = { captureContent: boolean; maxEventChars: number; maxEventsPerRun: number };
/**
 * 问题推导规则的版本。改了 classify / 退出码白名单 / 重复调用判定就加一：
 * 宿主据此决定要不要把历史记录的 findings 重算一次（计数与结论不动）。
 */
export const CLASSIFIER_VERSION = 2;
export type FindingStatus = 'open' | 'accepted' | 'dismissed' | 'validated' | 'regressed';
type Config = { providerId: string; protocol: string; model: string; effort: string; role: string };
type Outcome = 'running' | 'completed' | 'aborted' | 'error' | 'interrupted';
export type Evidence = { runId: string; seq: number; traceFile: string; available: boolean; detail?: string };
/** One top-level block of the resolved prompt: what it is, not what it says. */
export type PromptSection = { label: string; sha256: string; chars: number };
/** Fingerprint of the run's user input. `excerpt` is stored only with content capture. */
export type RunInput = { sha256: string; chars: number; excerpt?: string };
export type ReviewFinding = {
  id: string;
  kind: 'tool-error' | 'repeated-call' | 'run-error' | 'retry' | 'user-retry';
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
  /** Nonzero exits that the command itself documents as normal (`rg` no match, …). */
  expectedExits: number;
  retries: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  droppedEvents: number;
  eventCount: number;
  traceFile: string;
  promptHashes: { sha256: string; chars: number }[];
  /** Latest resolved prompt split into its top-level blocks, for prompt drift attribution. */
  promptSections?: PromptSection[];
  input?: RunInput;
  /** Host shape at capture time: `session` (TUI / app-server) or `one-shot` (`mica exec`). */
  mode?: string;
  host?: string;
  /**
   * Capturing process; a run left `running` by a killed host is reclaimed by pid.
   * Summary written before pid tracking has no value — unknown is never reclaimed.
   */
  hostPid?: number;
  updatedAt?: string;
  reclaimedAt?: string;
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
type Call = { name: string; argsHash: string; command?: string };
type CallRecord = {
  count: number;
  first: number;
  name: string;
  /** Seq of the previous call with this exact tool and arguments. */
  prevSeq: number;
  /** Digests of the results seen so far (bounded to MAX_RESULT_HASHES). */
  resultHashes: Set<string>;
  emitted: boolean;
};
type WriteMark = { seq: number; key: string };
type InputMemory = Map<string, { runSummaryId: string; sha256: string; text: string; outcome: Outcome }>;
type RunState = {
  summary: RunSummary;
  options: CaptureOptions;
  prepared?: boolean;
  seq: number;
  written: number;
  calls: Map<string, CallRecord>;
  writeMarks: WriteMark[];
  pending: Map<string, Call>;
  candidates: Map<string, ReviewFinding>;
};
const MAX_RUNS = 2000;
/** 没有 hostPid 的旧记录：summary 超过这么久没被写过，就当宿主已经退出。 */
const STALE_RUN_MS = 6 * 60 * 60 * 1000;
const MAX_SCANNED_RUNS = 10_000;
const MAX_FINDINGS = 100;
const MAX_EVIDENCE = 20;
const MAX_KEYS = 1000;
const MAX_WRITE_MARKS = 500;
const MAX_RESULT_HASHES = 4;
const MAX_PROMPT_SECTIONS = 60;
const MAX_INPUT_MEMORY = 500;
const MAX_PENDING_TRACE_BYTES = 4 * 1024 * 1024;
const STATUSES = new Set<FindingStatus>(['open', 'accepted', 'dismissed', 'validated', 'regressed']);
const OUTCOMES = new Set<Outcome>(['running', 'completed', 'aborted', 'error', 'interrupted']);
const SENSITIVE_KEY = /api.?key|access.?key|token|password|passwd|authorization|cookie|secret|credential|private.?key/i;
const POLLING =
  /(?:^|[._:/-])(?:wait_for|background_tasks_read|background_tasks_list|pty_read|read_terminal|terminal_read|wait|sleep|poll)(?:$|[._:/-])/i;
const SHELL_TOOL = /(?:^|[.:/])run_shell$/;
const RETRY_OUTCOMES = new Set<Outcome>(['aborted', 'error', 'interrupted']);
const NO_MATCH_EXIT = new Set(['rg', 'ripgrep', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'ugrep']);
const MISSING_EXIT = new Set(['ls', 'stat', 'test', '[', 'which', 'type', 'find']);
const DIFF_EXIT = new Set(['diff', 'cmp']);
const SHELL_WRAPPERS = new Set(['sudo', 'env', 'time', 'nohup', 'command', 'builtin', 'exec']);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Tools that change workspace or machine state: repeating a call after one of these is
 *  a fresh attempt (restarted server, edited file), not a no-progress loop. */
const WRITE_TOOLS = new Set([
  'write_file',
  'apply_patch',
  'edit_file',
  'multi_edit',
  'create_file',
  'delete_file',
  'move_file',
  'background_tasks_start',
  'background_tasks_kill',
  'pty_write',
  'run_shell',
  'memory',
]);
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

/** `functions.run_shell` and `mcp:server.run_shell` are the same tool for our purposes. */
function baseName(name: string): string {
  const parts = name.split(/[.:/]/);
  return parts[parts.length - 1] ?? name;
}

/** One string field out of a tool's JSON arguments; `undefined` when it is not one. */
function argText(args: string, key: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Calls that observe state someone else advances — polls, waits, subagent reads. Repeating
 * them is how they work, so they never take part in repeated-call counting.
 */
function isPollingCall(name: string, args: string): boolean {
  if (POLLING.test(name)) return true;
  if (baseName(name) !== 'agent') return false;
  const operation = argText(args, 'operation');
  return operation === 'await' || operation === 'join' || operation === 'read' || operation === 'list';
}

function isWritingCall(name: string): boolean {
  const base = baseName(name);
  return WRITE_TOOLS.has(base) || /_(?:write|update|delete|add)$/.test(base);
}

/** End index of a here-document body starting at the first `<` of `<<`. */
function heredocEnd(text: string, index: number): number | null {
  let cursor = index + 2;
  let strip = false;
  if (text[cursor] === '-') {
    strip = true;
    cursor++;
  }
  while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) cursor++;
  const quote = text[cursor] === '"' || text[cursor] === "'" ? text[cursor] : '';
  if (quote) cursor++;
  const start = cursor;
  while (cursor < text.length && /[A-Za-z0-9_.-]/.test(text[cursor])) cursor++;
  const delimiter = text.slice(start, cursor);
  if (!delimiter) return null;
  if (quote) {
    if (text[cursor] !== quote) return null;
    cursor++;
  }
  const newline = text.indexOf('\n', cursor);
  if (newline < 0) return text.length;
  let lineStart = newline + 1;
  while (lineStart < text.length) {
    const lineEnd = text.indexOf('\n', lineStart);
    const line = lineEnd < 0 ? text.slice(lineStart) : text.slice(lineStart, lineEnd);
    if ((strip ? line.replace(/^\t+/, '') : line).trimEnd() === delimiter)
      return lineEnd < 0 ? text.length : lineEnd + 1;
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
  // Unterminated here-document: its body cannot contribute the program anyway.
  return text.length;
}

/**
 * Split a shell line at top-level command separators. Quoting, escapes and here-documents
 * are tracked so their contents never split the line; an unterminated quote means the
 * command cannot be parsed confidently.
 */
function commandSegments(text: string): string[] | null {
  const segments: string[] = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      current += char;
      if (char === '\\' && quote === '"' && index + 1 < text.length) current += text[++index];
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '\\' && index + 1 < text.length) {
      current += char + text[++index];
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '<' && text[index + 1] === '<' && text[index + 2] !== '<') {
      const end = heredocEnd(text, index);
      if (end === null) return null;
      current += text.slice(index, end);
      index = end - 1;
      continue;
    }
    if (char === '\n' || char === ';') {
      segments.push(current);
      current = '';
      continue;
    }
    if (char === '&') {
      // `&&` separates commands; `>&` and `&>` are redirections; a lone `&` backgrounds.
      if (text[index + 1] === '&') {
        segments.push(current);
        current = '';
        index++;
      }
      continue;
    }
    if (char === '|') {
      segments.push(current);
      current = '';
      if (text[index + 1] === '|') index++;
      continue;
    }
    current += char;
  }
  if (quote) return null;
  segments.push(current);
  return segments;
}

/** The first whitespace-delimited token of `text`. */
function firstWord(text: string): string {
  return /^\S+/.exec(text)?.[0] ?? '';
}

function programOf(segment: string): string {
  let rest = segment.trim().replace(/^[({]+/, '');
  for (let guard = 0; guard < 12 && rest; guard++) {
    const token = firstWord(rest);
    const word = token.replace(/^["'`()]+|["'`]+$/g, '');
    if (!word) return '';
    if (ENV_ASSIGNMENT.test(word)) {
      rest = rest.slice(token.length).trimStart();
      continue;
    }
    if (!SHELL_WRAPPERS.has(word)) break;
    rest = rest.slice(token.length).trimStart();
    // Wrapper flags: `sudo -E rg`, `time -p bun test`, `env -i rg`.
    for (let option = firstWord(rest); option.startsWith('-'); option = firstWord(rest))
      rest = rest.slice(option.length).trimStart();
  }
  const word = firstWord(rest).replace(/^["'`()]+|["'`)}\];]+$/g, '');
  if (!word || /^[<>&\d]+$/.test(word)) return '';
  return (word.split('/').pop() ?? word).replace(/\.exe$/i, '');
}

/**
 * The program whose status decides `$?`: last command of the line, after wrappers and
 * environment assignments. Empty when the command cannot be parsed confidently.
 */
export function terminalProgram(command: string): string {
  if (typeof command !== 'string') return '';
  if (!command.trim()) return '';
  const segments = commandSegments(command.trim());
  if (!segments) return '';
  for (let index = segments.length - 1; index >= 0; index--) {
    const program = programOf(segments[index]);
    if (program) return program;
  }
  return '';
}

/**
 * Nonzero status the command itself documents as normal: `rg` exits 1 when nothing
 * matched, `diff` exits 1 when files differ. Everything else is a real failure — `rg`
 * exit 2 means it could not even search.
 */
export function expectedExit(program: string, code: number, command: string): boolean {
  if (!program || !Number.isInteger(code) || code !== 1) return false;
  if (NO_MATCH_EXIT.has(program) || MISSING_EXIT.has(program) || DIFF_EXIT.has(program)) return true;
  return program === 'git' && /(?:^|\s)--(?:quiet|exit-code)\b/.test(command);
}

function isExpectedExit(call: Call | undefined, name: string, category: string | null): boolean {
  if (!category || !/^exit-\d+$/.test(category) || !SHELL_TOOL.test(name)) return false;
  const command = call?.command ?? '';
  return expectedExit(terminalProgram(command), Number(category.slice(5)), command);
}

/**
 * Jaccard similarity of character bigrams after normalisation. Input is bounded so a huge
 * pasted prompt cannot slow the observation path.
 */
export function similarity(a: string, b: string): number {
  const normalize = (text: string): string => text.slice(0, 2000).toLowerCase().replace(/\s+/g, ' ').trim();
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const grams = (text: string): Set<string> => {
    const set = new Set<string>();
    for (let index = 0; index + 1 < text.length; index++) set.add(text.slice(index, index + 2));
    return set;
  };
  const leftGrams = grams(left);
  const rightGrams = grams(right);
  if (!leftGrams.size || !rightGrams.size) return 0;
  let shared = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) shared++;
  return shared / (leftGrams.size + rightGrams.size - shared);
}

function attribute(attrs: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return (match?.[1] ?? match?.[2] ?? '').trim();
}

function sectionLabel(tag: string, attrs: string): string {
  if (tag === 'document') {
    const source = attribute(attrs, 'source');
    return source ? `document:${source}` : 'document';
  }
  if (tag === 'injection') {
    const plugin = attribute(attrs, 'plugin');
    const section = attribute(attrs, 'section');
    return plugin && section ? `injection:${plugin}/${section}` : `injection:${plugin || section || 'unknown'}`;
  }
  if (tag === 'role') {
    const name = attribute(attrs, 'name');
    return name ? `role:${name}` : 'role';
  }
  return tag;
}

/**
 * Split the resolved prompt into its top-level blocks. Only labels, digests and sizes are
 * kept: enough to see which block changed between two prompts, never its text. Malformed
 * markup degrades to fewer or coarser blocks instead of throwing.
 */
export function splitPromptSections(prompt: string): PromptSection[] {
  if (typeof prompt !== 'string' || !prompt) return [];
  const sections: PromptSection[] = [];
  const push = (label: string, text: string): void => {
    if (sections.length >= MAX_PROMPT_SECTIONS || !text.trim()) return;
    sections.push({ label: label.slice(0, 120), sha256: digest(text), chars: text.length });
  };
  const tagPattern = /<(\/?)([A-Za-z][A-Za-z0-9_:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  const stack: string[] = [];
  let elementStart = 0;
  let textStart = 0;
  let root: { tag: string; attrs: string } | null = null;
  for (const match of prompt.matchAll(tagPattern)) {
    const index = match.index ?? 0;
    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();
    const attrs = match[3] ?? '';
    const selfClosing = match[4] === '/';
    if (closing) {
      const position = stack.lastIndexOf(tag);
      if (position < 0) continue;
      stack.length = position;
      if (stack.length === 0 && root) {
        push(sectionLabel(root.tag, root.attrs), prompt.slice(elementStart, index + match[0].length));
        textStart = index + match[0].length;
        root = null;
      }
      continue;
    }
    if (stack.length === 0) {
      push('text', prompt.slice(textStart, index));
      elementStart = index;
      if (selfClosing) {
        push(sectionLabel(tag, attrs), match[0]);
        textStart = index + match[0].length;
        continue;
      }
      root = { tag, attrs };
    }
    if (!selfClosing) stack.push(tag);
  }
  if (stack.length > 0 && root) push(sectionLabel(root.tag, root.attrs), prompt.slice(elementStart));
  else push('text', prompt.slice(textStart));
  return sections;
}

/** `process.kill(pid, 0)` is the portable liveness probe; EPERM means it still exists. */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

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
  return payloadText(textOf(value), options);
}
function payloadText(text: string, options: CaptureOptions): object {
  return {
    sha256: digest(text),
    chars: text.length,
    ...(options.captureContent
      ? { content: text.slice(0, options.maxEventChars), truncated: text.length > options.maxEventChars }
      : {}),
  };
}

/**
 * Input text available to a replay: the stored content, or the summary excerpt when the
 * capture was metadata-only. Empty means "no body", and retry detection is skipped rather
 * than inferred from a digest.
 */
function replayedInputText(event: StoredEvent, summary: RunSummary): string {
  const input = event.input;
  if (input && typeof input === 'object') {
    const content = (input as Record<string, unknown>).content;
    if (typeof content === 'string' && content) return content;
  }
  return summary.input?.excerpt ?? '';
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
    if (SHELL_TOOL.test(name)) {
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
  if (SHELL_TOOL.test(name)) {
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
  const exit = SHELL_TOOL.test(name)
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
  /** Last input per session, so a retry after a failed run can be recognised. */
  private readonly lastInputs: InputMemory = new Map();

  constructor(
    root: string,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly context: { mode?: string; host?: string } = {},
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
    if (line === undefined) {
      batch.checkpoint = true;
      // Stamped at the moment the checkpoint is requested: the queued write may drain later.
      state.summary.updatedAt = new Date().toISOString();
    }
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
    // The command decides whether a nonzero exit is expected, and replay only has the
    // stored event — so it travels with the pending call instead of being re-derived.
    const command = SHELL_TOOL.test(name) ? argText(args, 'command') : undefined;
    state.pending.set(pendingKey, {
      name,
      argsHash,
      ...(command === undefined ? {} : { command: boundedText(command, 1000) }),
    });
    // Polls (and subagent reads) repeat by design; they are not repetition candidates.
    if (isPollingCall(name, args)) return argsHash;
    const key = `${name}\n${argsHash}`;
    let call = state.calls.get(key);
    if (!call) {
      if (state.calls.size >= MAX_KEYS) return argsHash;
      call = { count: 0, first: seq, name, prevSeq: 0, resultHashes: new Set(), emitted: false };
      state.calls.set(key, call);
    }
    const record: CallRecord = call;
    // Restarting a server or re-running a suite after an edit is a fresh attempt, not an
    // unchanged loop: any other writing call in between resets the streak.
    const progressed = state.writeMarks.some((mark) => mark.seq > record.prevSeq && mark.seq < seq && mark.key !== key);
    if (record.prevSeq > 0 && progressed) {
      record.count = 1;
      record.resultHashes.clear();
    } else record.count++;
    record.prevSeq = seq;
    if (isWritingCall(name)) {
      if (state.writeMarks.length >= MAX_WRITE_MARKS) state.writeMarks.shift();
      state.writeMarks.push({ seq, key });
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
    recordedExpected?: boolean,
  ): { category: string | null; expectedExit: boolean } {
    const pendingKey = correlation ?? `name:${name}`;
    const call = state.pending.get(pendingKey);
    state.pending.delete(pendingKey);
    // Only a result that is byte-identical to the previous ones counts as "no progress",
    // so the digest is recorded before any classification decision.
    this.noteResultHash(state, seq, call, result);
    const category = recordedCategory === undefined ? errorCategory(result, name) : recordedCategory;
    const expected = recordedExpected ?? isExpectedExit(call, name, category);
    if (expected) {
      // `rg` with no match and `diff` with differences are not tool errors.
      state.summary.expectedExits++;
      return { category: null, expectedExit: true };
    }
    if (!category) return { category: null, expectedExit: false };
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
    return { category, expectedExit: false };
  }

  /**
   * A call only counts as a repeated call once its results stop changing. Three identical
   * `typecheck` runs after three different edits are progress; three identical runs against
   * an untouched workspace are not.
   */
  private noteResultHash(state: RunState, seq: number, call: Call | undefined, result: string): void {
    if (!call) return;
    const key = `${call.name}\n${call.argsHash}`;
    const record = state.calls.get(key);
    if (!record) return;
    if (record.resultHashes.size < MAX_RESULT_HASHES) record.resultHashes.add(digest(result));
    if (record.count < 3 || record.emitted || record.resultHashes.size !== 1) return;
    record.emitted = true;
    this.addFinding(
      state,
      'repeated-call',
      key,
      seq,
      `Repeated call to ${call.name}`,
      call.name,
      '同一工具用完全相同的参数被连续调用多次，且中间没有任何改动、返回结果也一直没变。确认这种重复是否真的在推进（轮询、分页、外部状态在变），否则补一次进度判断或改用能一次拿到结果的方式。',
      '重放同类任务，对比调用次数与实际推进量。轮询、分页、外部状态变化或改完代码后的重跑都可以正当地重复调用。',
      `Identical redacted arguments and unchanged results across ${record.count} calls; repetition alone does not establish lack of progress.`,
    );
  }

  /**
   * A retry of the same task after a failed run is the clearest signal that the previous
   * answer was rejected. Only the fingerprint is stored, never the prompt text.
   */
  private noteRunInput(state: RunState, seq: number, text: string, memory: InputMemory): void {
    const session = state.summary.sessionId;
    if (!session) return;
    const bounded = text.slice(0, 2000);
    const previous = memory.get(session);
    if (previous && RETRY_OUTCOMES.has(previous.outcome) && previous.text.length >= 40 && bounded.length >= 40) {
      const score = similarity(previous.text, bounded);
      if (score >= 0.82)
        this.addFinding(
          state,
          'user-retry',
          `${session}\n${digest(bounded)}`,
          seq,
          '上次运行未成功后重试了同一任务',
          'session',
          '同一会话里上一次运行以失败/中断结束，而这次的输入与上次高度相似，说明用户在重试同一件事。对比两次的运行记录，确认失败点是环境或工具问题（同一工具反复失败、依赖缺失、命令用错）还是指令本身不清——前者修 harness，后者修提示词或工具的用法说明。',
          '准备一个可复现的对照任务：在同一 harness 下重跑两次，确认第二次的失败点与第一次相同；只有修掉那个失败点后重跑一次即成功，才算验证。',
          `Previous outcome: ${previous.outcome} (${previous.sha256.slice(0, 12)}); retry ${digest(bounded).slice(0, 12)}; similarity ${score.toFixed(2)}.`,
        );
    }
    if (!memory.has(session) && memory.size >= MAX_INPUT_MEMORY) memory.delete(memory.keys().next().value!);
    memory.set(session, { runSummaryId: state.summary.id, sha256: digest(bounded), text: bounded, outcome: 'running' });
  }

  private noteRunOutcome(summary: RunSummary, outcome: Outcome, memory: InputMemory): void {
    const session = summary.sessionId;
    if (!session) return;
    const entry = memory.get(session);
    if (entry && entry.runSummaryId === summary.id) entry.outcome = outcome;
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
          expectedExits: 0,
          retries: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          droppedEvents: 0,
          eventCount: 0,
          traceFile: join(this.root, 'runs', id, 'events.jsonl'),
          promptHashes: [],
          ...(this.context.mode ? { mode: boundedText(this.context.mode, 40) } : {}),
          ...(this.context.host ? { host: boundedText(this.context.host, 40) } : {}),
          hostPid: process.pid,
          findings: [],
        },
        options: optionsOf(options),
        seq: 0,
        written: 0,
        calls: new Map(),
        writeMarks: [],
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
      case 'run:start': {
        stored.config = copy(state.summary.config);
        const inputText = textOf(event.input);
        if (captureTrace) stored.input = payloadText(inputText, state.options);
        state.summary.input = {
          sha256: digest(inputText),
          chars: inputText.length,
          ...(state.options.captureContent ? { excerpt: inputText.slice(0, 300) } : {}),
        };
        this.noteRunInput(state, seq, inputText, this.lastInputs);
        break;
      }
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
        // Which block drifted, not what it said: 266 prompt versions in 493 runs were
        // indistinguishable while only the whole-prompt digest was kept.
        const sections = splitPromptSections(event.prompt);
        state.summary.promptSections = sections;
        stored.prompt = fingerprint;
        stored.promptSections = sections;
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
        const outcome = this.noteToolResult(state, seq, name, event.result, event.id ? digest(event.id) : undefined);
        stored.name = name;
        if (captureTrace)
          stored.result = payload(
            event.result,
            /(?:^|[.:/])harness_review$/.test(name) ? { ...state.options, captureContent: false } : state.options,
          );
        stored.errorCategory = outcome.category;
        // Recorded so a metadata-only replay reaches the same conclusion.
        if (outcome.expectedExit) stored.expectedExit = true;
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
        this.noteRunOutcome(state.summary, event.outcome, this.lastInputs);
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
        this.noteRunOutcome(state.summary, 'interrupted', this.lastInputs);
        this.save(state);
      }
      this.active.clear();
    }
    await this.tail;
  }

  /**
   * A host that is killed (or a container that is torn down) never runs `dispose`, so its
   * runs stay `running` forever and inflate the report's active-run warnings. Reclaim those
   * whose capturing process is gone; a run owned by this process is always left alone.
   */
  async reclaim(): Promise<number> {
    await this.flush();
    let entries: string[] = [];
    try {
      entries = (await readdir(join(this.root, 'runs'), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .slice(0, MAX_SCANNED_RUNS)
        .map((entry) => entry.name);
    } catch {
      // Best-effort cleanup: an unreadable root must never fail the review itself.
      return 0;
    }
    let reclaimed = 0;
    for (const id of entries) {
      const file = join(this.root, 'runs', id, 'summary.json');
      let summary: RunSummary;
      let writtenAt = 0;
      try {
        const info = await stat(file);
        if (info.size > 4_000_000) continue;
        writtenAt = info.mtimeMs;
        summary = JSON.parse(await readFile(file, 'utf8')) as RunSummary;
        if (!validSummary(summary, id)) continue;
      } catch {
        continue;
      }
      if (summary.outcome !== 'running') continue;
      if (summary.hostPid === process.pid) continue;
      // 有 pid 就认进程是否还活着；早期记录没有 pid，只能用「多久没写过了」判断——
      // 每一轮工具迭代都会写 checkpoint，长时间不动说明宿主已经不在了。
      if (summary.hostPid === undefined) {
        if (Date.now() - writtenAt < STALE_RUN_MS) continue;
      } else if (processAlive(summary.hostPid)) continue;
      const at = new Date().toISOString();
      summary.outcome = 'interrupted';
      summary.reclaimedAt = at;
      summary.updatedAt = at;
      try {
        await this.atomic(file, JSON.stringify(summary, null, 2));
        reclaimed++;
      } catch (error) {
        this.onError(error);
      }
    }
    return reclaimed;
  }

  async review(cwd?: string): Promise<ReviewReport> {
    await this.flush();
    const reclaimed = await this.reclaim();
    const filter = cwd ? canonicalCwd(cwd) : undefined;
    const warnings = [...this.writeWarnings];
    if (reclaimed > 0) warnings.push(`已回收 ${reclaimed} 个宿主已退出的未完成运行，标记为 interrupted。`);
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
        if (!validSummary(summary, entry.id) || !tracesOwnRun(summary.traceFile, entry.id))
          throw new Error('invalid summary schema');
        if (summary.cwd) summary.cwd = canonicalCwd(summary.cwd);
        // Summaries written before this counter existed report it as absent.
        if (!Number.isFinite(summary.expectedExits)) summary.expectedExits = 0;
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
    reclaimed: number;
  }> {
    await this.flush();
    const reclaimed = await this.reclaim();
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
        return { rebuilt, findings, skippedRunning, skippedUnreadable, reclaimed };
      throw error;
    }
    // Cross-run derivation (a retry is only visible against its predecessor) needs the
    // runs in the order they happened, not in directory order.
    const loaded: { id: string; summary: RunSummary }[] = [];
    for (const id of entries) {
      const directory = join(this.root, 'runs', id);
      try {
        const file = join(directory, 'summary.json');
        if ((await stat(file)).size > 4_000_000) throw new Error('summary exceeds size limit');
        const summary = JSON.parse(await readFile(file, 'utf8')) as RunSummary;
        if (!validSummary(summary, id) || !tracesOwnRun(summary.traceFile, id))
          throw new Error('invalid summary schema');
        loaded.push({ id, summary });
      } catch {
        skippedUnreadable++;
      }
    }
    loaded.sort((a, b) => a.summary.startedAt.localeCompare(b.summary.startedAt) || a.id.localeCompare(b.id));
    const memory: InputMemory = new Map();
    for (const { id, summary } of loaded) {
      const directory = join(this.root, 'runs', id);
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
        summary: { ...summary, expectedExits: finiteCount(summary.expectedExits), findings: [] },
        options: { captureContent: false, maxEventChars: 4000, maxEventsPerRun: 2000 },
        seq: 0,
        written: lines.length,
        calls: new Map(),
        writeMarks: [],
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
        this.replay(state, event, memory);
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
        // findings 与 expectedExits 都是派生值：这条运行能重放（droppedEvents === 0），
        // 重算出来的「预期非零退出」才是准的，沿用旧值会把它算成 0。
        await this.atomic(
          join(directory, 'summary.json'),
          JSON.stringify({ ...summary, expectedExits: state.summary.expectedExits, findings: replaced }, null, 2),
        );
        rebuilt++;
        findings += replaced.length;
      } catch (error) {
        this.onError(error);
        skippedUnreadable++;
      }
    }
    return { rebuilt, findings, skippedRunning, skippedUnreadable, reclaimed };
  }

  /** Replay one stored event through the same derivation the live writer uses. */
  private replay(state: RunState, event: StoredEvent, memory: InputMemory): void {
    const seq = event.seq;
    // The persisted idHash is what correlates a call with its result on replay.
    const correlation = typeof event.idHash === 'string' ? event.idHash : undefined;
    const name = boundedText(String(event.name ?? ''), 200);
    if (event.type === 'run:start') {
      this.noteRunInput(state, seq, replayedInputText(event, state.summary), memory);
      return;
    }
    if (event.type === 'run:finish') {
      const outcome = OUTCOMES.has(event.outcome as Outcome) ? (event.outcome as Outcome) : 'completed';
      this.noteRunOutcome(state.summary, outcome, memory);
    }
    if (event.type === 'tool:call') {
      const argsHash =
        typeof event.argsHash === 'string' && /^[a-f0-9]{64}$/.test(event.argsHash) ? event.argsHash : undefined;
      this.noteToolCall(state, seq, name, storedText(event.args), correlation, argsHash);
    } else if (event.type === 'tool:result') {
      const category =
        !hasCompleteContent(event.result) && (typeof event.errorCategory === 'string' || event.errorCategory === null)
          ? event.errorCategory
          : undefined;
      this.noteToolResult(
        state,
        seq,
        name,
        storedText(event.result),
        correlation,
        category,
        event.expectedExit === true ? true : undefined,
      );
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

/**
 * 轨迹文件必须指向这条运行自己的 `events.jsonl`。
 *
 * 只比后缀而不比绝对路径：整个数据目录搬过家（换 `MICA_HOME`、从备份恢复）时
 * 记下的绝对路径必然对不上，那种情况下把全部历史判成损坏没有意义。
 */
function tracesOwnRun(traceFile: string, id: string): boolean {
  return traceFile.endsWith(join('runs', id, 'events.jsonl'));
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
  // 早期版本没有 hostPid：那时记下的运行不能被判成损坏，也不能按 pid 回收。
  if (value.hostPid !== undefined && (!Number.isInteger(value.hostPid) || value.hostPid <= 0)) return false;
  if (value.mode !== undefined && typeof value.mode !== 'string') return false;
  if (value.host !== undefined && typeof value.host !== 'string') return false;
  const optionalTime = (item: string | undefined): boolean =>
    item === undefined || (typeof item === 'string' && Number.isFinite(Date.parse(item)));
  if (!optionalTime(value.updatedAt) || !optionalTime(value.reclaimedAt)) return false;
  if (value.input !== undefined) {
    const input = value.input;
    if (
      !input ||
      !/^[a-f0-9]{64}$/.test(input.sha256) ||
      !Number.isInteger(input.chars) ||
      input.chars < 0 ||
      (input.excerpt !== undefined && typeof input.excerpt !== 'string')
    )
      return false;
  }
  if (value.promptSections !== undefined) {
    if (!Array.isArray(value.promptSections) || value.promptSections.length > MAX_PROMPT_SECTIONS) return false;
    if (
      !value.promptSections.every(
        (section) =>
          section &&
          typeof section.label === 'string' &&
          section.label.length <= 120 &&
          /^[a-f0-9]{64}$/.test(section.sha256) &&
          Number.isInteger(section.chars) &&
          section.chars >= 0,
      )
    )
      return false;
  }
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
  // Added after the first runs were recorded: absent means zero, anything else must be a count.
  if (value.expectedExits !== undefined && (!Number.isInteger(value.expectedExits) || value.expectedExits < 0))
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
      ['tool-error', 'repeated-call', 'run-error', 'retry', 'user-retry'].includes(finding.kind) &&
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
