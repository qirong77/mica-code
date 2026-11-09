import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { acquireProcessLock } from '@packages/mica-common/processLock.js';
import type { AgentObservationEvent, PluginObservationEvent, PluginStatusFile } from '@packages/mica-plugin/index.js';
import {
  readAssessments,
  writeAssessment,
  type AssessmentBaseline,
  type FindingAssessment,
  type FindingStatus,
} from './assessments.js';
import { CorrectionQueue, type StoredCorrection } from './corrections.js';

export type { FindingStatus } from './assessments.js';

export type CaptureOptions = { captureContent: boolean; maxEventChars: number; maxEventsPerRun: number };
/**
 * 问题推导规则的版本。改了 classify / 退出码白名单 / 重复调用判定就加一：
 * 宿主据此重算 findings 与派生错误计数，不动用量、耗时和人工结论。
 */
export const CLASSIFIER_VERSION = 8;
type Config = { providerId: string; protocol: string; model: string; effort: string; role: string };
/**
 * `paused` 是宿主在迭代边界主动停下（开发构建重载），历史完整、随后续跑；
 * 它既不是失败也不是用户中止，单独的取值好让复盘区分「这一轮被打断」的原因。
 */
type Outcome = 'running' | 'completed' | 'aborted' | 'error' | 'interrupted' | 'paused';
export type Evidence = { runId: string; seq: number; traceFile: string; available: boolean; detail?: string };
/** One top-level block of the resolved prompt: what it is, not what it says. */
export type PromptSection = { label: string; sha256: string; chars: number };
/** Fingerprint of the run's user input. `excerpt` is stored only with content capture. */
export type RunInput = { sha256: string; chars: number; excerpt?: string };
export type DerivationCoverage = {
  limitedRuns: number;
  callObservationsNotTracked: number;
  findingSignalsNotRecorded: number;
  unknownRuns: number;
};
export type ReviewFinding = {
  id: string;
  kind: 'tool-error' | 'repeated-call' | 'run-error' | 'retry' | 'user-retry' | 'user-correction' | 'plugin-background';
  title: string;
  module: string;
  suggestion: string;
  evaluation: string;
  status: FindingStatus;
  note?: string;
  updatedAt?: string;
  assessments?: Pick<FindingAssessment, 'status' | 'note' | 'updatedAt'>[];
  reviewNeeded?: { reason: 'new-evidence' | 'baseline-unavailable'; occurrences: number; runs: number };
  occurrences: number;
  /** Workspace this aggregation belongs to. Findings are keyed per workspace, so
   *  a global review shows the same cause once per project — without this the
   *  rows are indistinguishable. */
  cwd?: string;
  evidence: Evidence[];
};
/** 一次运行里的压缩次数，按动手的那一类机制分组：压缩是正常机制，只计数、不生成问题条目。 */
export type CompactionCounts = { local: number; llm: number; idle: number };
export type CompactionStrategy = keyof CompactionCounts;
/** 最近一次真正改了历史的压缩：用来解释「压完之后那一轮为什么变差」。 */
export type RecordedCompaction = {
  strategy: CompactionStrategy;
  reason: string;
  beforeMessages: number;
  afterMessages: number;
};
/** 用户纠正的三种形态，与 `RuntimeEvent` 的 `input:corrected` 一致。 */
export type CorrectionKind = 'edit' | 'recall' | 'retry';
export type CorrectionCounts = Record<CorrectionKind, number>;
/** 这条运行由委派产生时记下的来源：哪一类子代理、被哪个会话派生。 */
export type RunDelegation = { type: string; parentSessionId?: string };
/**
 * 这条运行不是会话里的一轮，而是宿主内部工作：压缩摘要、旁问线程、插件自己问模型。
 *
 * 它们同样花钱、同样会失败，但按「用户的一轮」统计会把一次 turn 的成本与成败算错——
 * 一次 turn 配一条标题生成，运行数直接翻倍。
 */
export type RunHelper = { kind: string; pluginId?: string; purpose?: string };
/**
 * 采集那一刻的插件装配结论（当前宿主的内存快照）。
 *
 * `hash` 只覆盖这份内容：两次运行之间 hash 变了就说明插件集合变了，排查「这一轮变差
 * 是不是插件没装上」不用再翻日志。
 */
export type RunPlugins = {
  host?: string;
  loaded: number;
  failed: string[];
  skipped: string[];
  hash: string;
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
  /** 模型请求的累计耗时（`request:end`）：整轮里有多少时间是在等模型。 */
  requestMsTotal?: number;
  /** 单次请求最长耗时：卡顿那次是哪一个。 */
  requestMsMax?: number;
  /** 首字延迟合计与次数（没有输出的请求不计入），报告里取平均。 */
  firstTokenMsTotal?: number;
  firstTokenMsCount?: number;
  toolCalls: number;
  toolErrors: number;
  /** Nonzero exits that the command itself documents as normal (`rg` no match, …). */
  expectedExits: number;
  retries: number;
  /** 压缩次数（本地清理 / 模型摘要 / 空闲维护）。老摘要没有它，读时按 0。 */
  compactions: CompactionCounts;
  /** 最近一次真正改了历史的压缩。 */
  lastCompaction?: RecordedCompaction;
  /** 本轮运行开始前攒下的用户纠正：用户推翻上一轮输入的唯一确凿记录。 */
  corrections?: CorrectionCounts;
  correctionIds?: string[];
  /** 委派来源。有它才能按父会话拼出委派树。 */
  delegation?: RunDelegation;
  /** 有它说明这条运行是宿主内部工作，不是用户的一轮。 */
  helper?: RunHelper;
  /** 采集这一刻的插件装配结论。缺文件或损坏时整块省略。 */
  plugins?: RunPlugins;
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
  derivationDrops?: { callObservations: number; findingSignals: number };
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
/**
 * 一种子代理类型的委派结果。平均请求数 / 平均输出 token 在该类型全部运行都缺这个
 * 字段时**不出现**——写 0 会被读成「一次请求都没花」。
 */
export type DelegationTypeSummary = {
  type: string;
  runs: number;
  completed: number;
  failed: number;
  aborted: number;
  avgRequests?: number;
  avgOutputTokens?: number;
};
/** 一个父会话下面的委派结果。`parentSessionId` 为 null 表示事件里没记父会话。 */
export type DelegationParentSummary = {
  parentSessionId: string | null;
  runs: number;
  types: DelegationTypeSummary[];
};
export type DelegationSummary = { parents: DelegationParentSummary[] };
/**
 * 一类 helper 运行的结果与开销，按 `kind`（插件发起的再按 `pluginId`）归并。
 *
 * 平均请求耗时 / 输出 token 算不出来时**不出现**——写 0 会被读成「零耗时」。
 */
export type HelperKindSummary = {
  kind: string;
  pluginId?: string;
  runs: number;
  completed: number;
  failed: number;
  aborted: number;
  requests: number;
  avgRequestMs?: number;
  avgOutputTokens?: number;
};
export type HelperSummary = { total: number; kinds: HelperKindSummary[] };
/**
 * 某个插件的某个常驻任务（或某个钩子，任务名前缀 `hook:`）失败过多少次。
 *
 * 这些失败发生在任何一轮之外，所以没有 `cwd`、也没有 `runId`：它们属于这台机器，
 * 不受 `review(cwd)` 的范围过滤。
 *
 * `count` 是下界：落盘被限流，跨进程重启也接不上累计数。
 */
export type PluginFailureSummary = {
  pluginId: string;
  taskId: string;
  count: number;
  lastAt: string;
  lastError: string;
};
/**
 * 一个工具在这个范围里的调用量、失败率与主要错误类别。
 *
 * 单看「某个工具报错 300 次」没法判断该不该修：`run_shell` 两万次里错 400 次是 2%，
 * `memory` 一百多次里错 80 次是 50%——后者才是缺陷。失败率把两边拉到同一个刻度上。
 */
export type ToolHealthRow = {
  name: string;
  calls: number;
  errors: number;
  errorRate: number;
  categories: { category: string; count: number }[];
};
export type ReviewReport = {
  version: 1;
  generatedAt: string;
  root: string;
  cwd?: string;
  runs: RunSummary[];
  findings: ReviewFinding[];
  /** 委派树：按父会话归拢后、再按子代理类型聚合成败与成本。 */
  delegation: DelegationSummary;
  /** helper 运行（压缩摘要、旁问、插件问模型）按来源归并的结果。 */
  helpers: HelperSummary;
  /** 插件常驻任务失败；机器级事实，不受工作区过滤。 */
  pluginFailures: PluginFailureSummary[];
  /** 每个工具的调用量与失败率：这张表才看得出「哪个工具的失败率高到该修」。 */
  toolHealth: ToolHealthRow[];
  toolHealthCoverage: { includedRuns: number; excludedRuns: number; unknownResults: number };
  derivationCoverage: DerivationCoverage;
  warnings: string[];
  scannedRuns: number;
  limits: { runs: number; findingsPerRun: number; distinctCallKeysPerRun: number; evidencePerFinding: number };
  interpretation: string;
};
type StoredEvent = { seq: number; type: string; timestamp: string; [key: string]: unknown };
type Call = { name: string; argsHash: string; command?: string; argsComplete?: boolean };
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
  toolTally?: ToolTally;
  unknownResults?: number;
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
const MAX_PLUGIN_IDS = 50;
const PLUGIN_HASH_CHARS = 12;
const MAX_DELEGATION_PARENTS = 50;
const MAX_HELPER_KINDS = 50;
/** 报告里最多列这么多个工具：真实用到的工具 30 个上下，留一倍余量。 */
const MAX_TOOL_HEALTH_ROWS = 60;
const MAX_PLUGIN_FAILURES = 100;
/** 同一任务失败到第三次才值得看一眼：前两次多半是外部服务抖了一下。 */
const PLUGIN_FAILURE_FINDING_COUNT = 3;
/** 同一个常驻任务在本进程内最多每 5 分钟落一条失败记录（每个任务的第一条一定落盘）。 */
const PLUGIN_EVENT_INTERVAL_MS = 5 * 60 * 1000;
const MAX_PLUGIN_EVENT_KEYS = 500;
/** 单个事件文件的上限：滚成 `.1` 之后重新写，坏掉的任务写不满磁盘。 */
const MAX_PLUGIN_EVENTS_BYTES = 4 * 1024 * 1024;
/**
 * 读的上限比滚动的阈值大：滚出来的 `.1` 一定比阈值多一行，同用一个数会让它永远被跳过。
 */
const MAX_PLUGIN_EVENTS_READ_BYTES = 8 * 1024 * 1024;
const PLUGIN_EVENTS_FILE = 'plugin-events.jsonl';
const PLUGIN_EVENTS_ROTATED = 'plugin-events.1.jsonl';
const STATUSES = new Set<FindingStatus>(['open', 'accepted', 'dismissed', 'validated', 'regressed']);
const OUTCOMES = new Set<Outcome>(['running', 'completed', 'aborted', 'error', 'interrupted', 'paused']);
const COMPACTION_STRATEGIES = new Set<CompactionStrategy>(['local', 'llm', 'idle']);
const CORRECTION_ORDER: CorrectionKind[] = ['edit', 'recall', 'retry'];
const CORRECTION_KINDS = new Set<CorrectionKind>(CORRECTION_ORDER);
const SENSITIVE_KEY = /api.?key|access.?key|token|password|passwd|authorization|cookie|secret|credential|private.?key/i;
const POLLING =
  /(?:^|[._:/-])(?:wait_for|background_tasks_read|background_tasks_list|pty_read|read_terminal|terminal_read|wait|sleep|poll)(?:$|[._:/-])/i;
const SHELL_TOOL = /(?:^|[.:/])run_shell$/;
const RETRY_OUTCOMES = new Set<Outcome>(['aborted', 'error', 'interrupted']);
const NO_MATCH_EXIT = new Set(['rg', 'ripgrep', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'ugrep']);
const MISSING_EXIT = new Set(['test', '[', 'which', 'type']);
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

function truncatedToolCategory(value: unknown, name: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (item.truncated !== true || typeof item.content !== 'string') return undefined;
  const lines = item.content.split(/\r?\n/);
  const first = lines[0]?.trim() ?? '';
  const wrapped = /^(?:Tool (?:execution )?(?:error|failed)|工具[^\n]*(?:失败|错误))[:：]/i.test(first);
  // A complete, explicit failure line can be reclassified even when the appended
  // examples or previous entries were truncated. Incomplete lines keep the saved category.
  if (
    wrapped ? !/^Error:/i.test(lines[1]?.trim() ?? '') || lines.length < 3 : !/^Error:/i.test(first) || lines.length < 2
  )
    return undefined;
  const category = errorCategory(item.content, name);
  return category && category !== 'tool-error' ? category : undefined;
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

function failureText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const item = value as Record<string, unknown>;
  if (typeof item.error === 'string') return item.error;
  if (item.error && typeof item.error === 'object') return failureText(item.error);
  if (typeof item.message === 'string') return item.message;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) {
    const text = item.content.find((part) => part && typeof part === 'object' && typeof part.text === 'string') as
      | { text: string }
      | undefined;
    return text?.text ?? '';
  }
  return '';
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
      return classifyError(failureText(item), name);
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
    return classifyError(raw, name);
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
  if (category === 'patch-ambiguous-context')
    return {
      suggestion: 'hunk 的上下文在文件中匹配到多处。重读目标文件，补足能唯一定位的相邻行或 @@ 锚点后再提交。',
      evaluation: '确认 patch 只命中预期位置，且同一处编辑重放后不再报匹配不唯一。',
    };
  if (category === 'capacity-limit')
    return {
      suggestion: '记忆容量已满。先检查适用范围与现有条目，合并或缩短冗余内容；删除已有记忆前先征得用户同意。',
      evaluation: '在容量内重放同一条记忆写入，确认内容被保存且已有条目未意外丢失。',
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
      suggestion: SHELL_TOOL.test(name)
        ? '命令超时。耗时命令改用 background_tasks_start 启动，再用 wait_for / background_tasks_read 取结果，不要靠调大前台超时。'
        : '工具等待超时。确认等待条件、目标服务和连接是否仍能推进，再按该工具的超时设置重试。',
      evaluation: SHELL_TOOL.test(name)
        ? '把同一命令改为后台启动，确认它能正常结束且输出可取回。'
        : '在相同条件下重放该工具调用，确认目标状态可达且不再超时。',
    };
  if (category === 'connection-closed')
    return {
      suggestion:
        '连接被远端或中间层关闭。检查目标服务、代理和连接生命周期，再看请求边界的错误日志；不要按参数错误修改输入。',
      evaluation: '在相同服务与网络条件下重放请求，确认连接不再提前关闭。',
    };
  if (category === 'connection-error')
    return {
      suggestion: '连接失败。核对目标服务和本地网关的可达性与同时间段日志，无法仅凭报错判断故障在哪一端。',
      evaluation: '在同一接口上重放少量请求，确认成功率和重试次数恢复正常。',
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

function classifyError(text: string, name = ''): string {
  // A tool may append previous entries, usage text or a sample patch after its
  // failure. Only its explicit failure line (or the first line) identifies the cause.
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines[0] ?? '';
  const wrapper = /^(?:Tool (?:execution )?(?:error|failed)|工具[^\n]*(?:失败|错误))[:：]\s*/i;
  const wrapped = wrapper.test(first) ? first.replace(wrapper, '') : first;
  const cause = (wrapped || (wrapper.test(first) ? (lines[1] ?? '') : '')).replace(/^Error:\s*/i, '');
  const patch = baseName(name) === 'apply_patch';
  if (patch) {
    if (/hunk (?:没有任何增删内容|只有上下文行)|hunk (?:has|contains) no (?:changes|additions|removals)/i.test(cause))
      return 'empty-hunk';
    if (
      /hunk[^\n]*(?:匹配不唯一|匹配到多处|not unique|multiple matches|(?:found|matches?) (?:multiple|more than one))|(?:匹配不唯一|匹配到多处)[^\n]*hunk/i.test(
        cause,
      )
    )
      return 'patch-ambiguous-context';
    if (
      /必须以\s*\*\*\* Begin Patch\s*开始|must (?:start|begin) with\s*\*\* Begin Patch|(?:invalid|missing|malformed) (?:patch )?header/i.test(
        cause,
      )
    )
      return 'invalid-patch-header';
    if (
      /context not found|old_string[^\n]*not found|invalid context|hunk failed|patch (?:does not apply|failed)|找不到 ?hunk|找不到要替换的内容/i.test(
        cause,
      )
    )
      return 'patch-context-mismatch';
  }
  if (baseName(name) === 'memory' && /(?:capacity|容量|上限|超限|空间不足|存储已满|safety limit)/i.test(cause))
    return 'capacity-limit';
  if (
    /(?:socket|connection|transport|stream)[^\n]{0,80}(?:closed|reset|terminated)|\b(?:ECONNRESET|EPIPE)\b/i.test(cause)
  )
    return 'connection-closed';
  if (/^(?:APIConnectionError:\s*)?Connection error\.?$/i.test(cause)) return 'connection-error';
  if (/ENOENT|not found|no such file/i.test(cause)) return 'not-found';
  if (/EACCES|EPERM|permission denied|unauthorized|forbidden/i.test(cause)) return 'permission';
  if (/\b(?:timeout|timed out|ETIMEDOUT)\b|超时/i.test(cause)) return 'timeout';
  if (
    /\b(?:invalid|validation|schema)\b|(?:unknown|unexpected|unrecognized|unsupported|missing|required) (?:parameter|argument|field|key)|(?:未知|不支持|未识别|非法)(?:的)?(?:参数|字段)|不认识这些参数/i.test(
      cause,
    )
  )
    return 'invalid-input';
  if (/rate.?limit|\b429\b/i.test(cause)) return 'rate-limit';
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
function isCount(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) >= 0;
}
function isPluginIdList(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_PLUGIN_IDS) return false;
  return value.every((id) => typeof id === 'string' && !!id);
}
/** 缺失 / 损坏的压缩计数按 0 读：老摘要里没有这块，不能因此判成损坏。 */
function compactionCounts(value: Partial<CompactionCounts> | undefined): CompactionCounts {
  const pick = (count: unknown): number => (isCount(count) ? Number(count) : 0);
  return { local: pick(value?.local), llm: pick(value?.llm), idle: pick(value?.idle) };
}
function messageCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}
/**
 * `run:start.helper` → 摘要里那一块。
 *
 * 格式不对时整块丢掉而不是判整份摘要损坏：这一块是后加的，缺省就是「不是 helper」，
 * 一条脏字段不该让一整次运行的历史作废。
 */
function helperOf(value: unknown): RunHelper | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as { kind?: unknown; pluginId?: unknown; purpose?: unknown };
  const kind = typeof item.kind === 'string' ? boundedText(item.kind, 80).trim() : '';
  if (!kind) return undefined;
  const pluginId = typeof item.pluginId === 'string' ? boundedText(item.pluginId, 200).trim() : '';
  const purpose = typeof item.purpose === 'string' ? boundedText(item.purpose, 200).trim() : '';
  return { kind, ...(pluginId ? { pluginId } : {}), ...(purpose ? { purpose } : {}) };
}

/** helper 来源的短名：标题、模块与报告用同一份写法，两处不一致就认不出是同一件事。 */
function helperSource(helper: RunHelper): string {
  return helper.pluginId ? `${helper.pluginId} · ${helper.kind}` : helper.kind;
}

/**
 * 插件失败条目的 id：既看得出是哪个插件的哪个任务，又足够稳定（文件名由
 * 评估存储模块决定：带 `:` 的 id 会先哈希，Windows 上 `:` 不是合法文件名字符）。
 *
 * 任务名由插件自己定，可能带 `/`、`:` 这类路径或协议字符——原样拼进文件名会写进别的目录。
 */
function pluginFailureId(pluginId: string, taskId: string): string {
  const safe = (value: string, max: number): string =>
    value
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .replace(/^[_.-]+|[_.-]+$/g, '')
      .slice(0, max) || 'unnamed';
  const safePlugin = safe(pluginId, 80);
  const safeTask = safe(taskId, 120);
  // 任务名里带 `:`（旁问线程就是 `plugin:<id>:thread:<uuid>`）会被换成 `_`：两个不同的
  // 任务可能撞到同一个 id，后一条 finding 直接覆盖前一条、判断记录也串到别人身上。
  // 只有真的改写过才补一段摘要，干净的 id 保持可读。
  const rewritten = safePlugin !== pluginId || safeTask !== taskId;
  const task = rewritten ? `${safe(taskId, 111)}-${digest(`${pluginId}\n${taskId}`).slice(0, 8)}` : safeTask;
  return `plugin-background:${safePlugin}:${task}`;
}

/**
 * 用户纠正只证明用户动作发生过，是否源于回答质量仍需复盘。
 */
const CORRECTION_GUIDANCE: Record<CorrectionKind, { title: string; suggestion: string; evaluation: string }> = {
  edit: {
    title: '用户改写了上一轮的输入并重跑',
    suggestion:
      '回看被改写的那一轮：对比原始输入与改写后的输入，确认是指令没被理解（改 prompt 段落 / 工具描述 / 记忆条目）还是结果不对（改实现或验证方式），再改对应的那一处。',
    evaluation: '用改写后的说法重跑同类任务，确认同一处不再被用户改写。',
  },
  recall: {
    title: '用户撤回了还没发出的排队输入',
    suggestion:
      '回看被撤回的那一句：它是在上一轮还没跑完时写的。确认是这一轮拖太久、还是队列把话带到了错误的状态，再决定改 prompt 里的等待约定、工具耗时还是队列时机。',
    evaluation: '在同一时机（上一轮还在跑）再发一句，确认它被正确排队并在预期时机发出。',
  },
  retry: {
    title: '用户原样重发了同一句话',
    suggestion:
      '回看被重发的那一轮：同一句输入没有换说法却被重发，通常说明回答没被接受或那一轮没跑完。确认是指令没被理解（改 prompt 段落 / 工具描述 / 记忆条目）还是结果不对（改实现或验证方式）。',
    evaluation: '重跑同一句话，确认一次就得到用户接受的结果、无需再发。',
  },
};

/**
 * 宿主回调 → 这次运行看到的插件装配结论，不读取其他宿主共享的状态文件。
 *
 * 回调缺失或失败一律返回 undefined（整块省略），不抛错、不生成问题条目：插件没装上
 * 有很多正常原因，采集侧不该把它变成一条待复盘的问题。
 */
function readPluginSnapshot(pluginStatus: (() => PluginStatusFile) | undefined): RunPlugins | undefined {
  if (!pluginStatus) return undefined;
  try {
    const parsed: unknown = pluginStatus();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const file = parsed as { host?: unknown; plugins?: unknown };
    if (!Array.isArray(file.plugins)) return undefined;
    const statuses = new Map<string, 'loaded' | 'failed' | 'skipped'>();
    for (const item of file.plugins) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as { id?: unknown; status?: unknown };
      if (typeof entry.id !== 'string' || !entry.id) continue;
      if (entry.status !== 'loaded' && entry.status !== 'failed' && entry.status !== 'skipped') continue;
      statuses.set(boundedText(entry.id, 200), entry.status);
    }
    const ids = (status: 'failed' | 'skipped'): string[] =>
      [...statuses]
        .filter(([, value]) => value === status)
        .map(([id]) => id)
        .sort()
        .slice(0, MAX_PLUGIN_IDS);
    const snapshot: RunPlugins = {
      ...(typeof file.host === 'string' && file.host ? { host: boundedText(file.host, 40) } : {}),
      loaded: [...statuses.values()].filter((value) => value === 'loaded').length,
      failed: ids('failed'),
      skipped: ids('skipped'),
      hash: '',
    };
    // 同一份状态必须得到同一个 hash：只喂排好序的数组与快照自己的字段。
    snapshot.hash = digest(
      JSON.stringify([snapshot.host ?? null, snapshot.loaded, snapshot.failed, snapshot.skipped]),
    ).slice(0, PLUGIN_HASH_CHARS);
    return snapshot;
  } catch {
    return undefined;
  }
}

/** 某一项指标的均值；缺字段或非法值的运行不参与，全都缺时不出现（0 会被读成真实值）。 */
function meanOf(runs: RunSummary[], pick: (run: RunSummary) => number | undefined): number | undefined {
  let total = 0;
  let count = 0;
  for (const run of runs) {
    const value = pick(run);
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      total += value;
      count++;
    }
  }
  return count > 0 ? Math.round((total / count) * 10) / 10 : undefined;
}

/** 一种子代理的成败与成本；缺字段的指标不出现在返回值里。 */
function delegationTypeSummary(type: string, runs: RunSummary[]): DelegationTypeSummary {
  const row: DelegationTypeSummary = {
    type,
    runs: runs.length,
    completed: runs.filter((run) => run.outcome === 'completed').length,
    // 宿主被杀（interrupted）同样是一次没跑成的委派，归到 failed 里。
    failed: runs.filter((run) => run.outcome === 'error' || run.outcome === 'interrupted').length,
    aborted: runs.filter((run) => run.outcome === 'aborted').length,
  };
  const requests = meanOf(runs, (run) => run.requestCount);
  if (requests !== undefined) row.avgRequests = requests;
  const output = meanOf(runs, (run) => run.outputTokens);
  if (output !== undefined) row.avgOutputTokens = output;
  return row;
}

/**
 * 把委派产生的运行按「父会话 × 子代理类型」聚合。
 *
 * 只认 `delegation.type` 齐全的运行：没有类型的委派事件拼不出「哪种类型最差」，
 * 补一行 0 只会把结论冲淡。
 */
export function summarizeDelegation(runs: RunSummary[], warnings: string[] = []): DelegationSummary {
  const parents = new Map<string | null, Map<string, RunSummary[]>>();
  for (const run of runs) {
    const type = typeof run.delegation?.type === 'string' ? run.delegation.type.trim() : '';
    if (!type) continue;
    const parent = typeof run.delegation?.parentSessionId === 'string' ? run.delegation.parentSessionId : null;
    const types = parents.get(parent) ?? new Map<string, RunSummary[]>();
    const list = types.get(type) ?? [];
    list.push(run);
    types.set(type, list);
    parents.set(parent, types);
  }
  const groups = [...parents]
    .map(([parentSessionId, types]) => ({
      parentSessionId,
      runs: [...types.values()].reduce((total, list) => total + list.length, 0),
      types: [...types]
        .map(([type, list]) => delegationTypeSummary(type, list))
        .sort((a, b) => b.runs - a.runs || a.type.localeCompare(b.type)),
    }))
    .sort((a, b) => b.runs - a.runs || (a.parentSessionId ?? '').localeCompare(b.parentSessionId ?? ''));
  if (groups.length > MAX_DELEGATION_PARENTS) {
    warnings.push(
      `Delegation summary limited to the ${MAX_DELEGATION_PARENTS} parent sessions with the most delegated runs.`,
    );
    return { parents: groups.slice(0, MAX_DELEGATION_PARENTS) };
  }
  return { parents: groups };
}

/**
 * 把 helper 运行按「来源」聚合：`kind`，插件发起的再按 `pluginId` 分开。
 *
 * 分开的理由和委派一样：压缩摘要一次几十秒，与某个插件的起标题请求变慢，
 * 混成一行就只能看到「helper 平均 40 秒」，改哪一处全靠猜。
 *
 * `interrupted`（宿主半路退出）不计入 failed：它说明的是宿主怎么了，不是这条机制怎么了。
 */
export function summarizeHelpers(runs: RunSummary[], warnings: string[] = []): HelperSummary {
  const groups = new Map<string, { kind: string; pluginId?: string; runs: RunSummary[] }>();
  let total = 0;
  for (const run of runs) {
    const helper = run.helper;
    if (!helper) continue;
    total++;
    const key = `${helper.kind}\n${helper.pluginId ?? ''}`;
    const group = groups.get(key) ?? {
      kind: helper.kind,
      ...(helper.pluginId ? { pluginId: helper.pluginId } : {}),
      runs: [],
    };
    group.runs.push(run);
    groups.set(key, group);
  }
  const kinds = [...groups.values()]
    .map((group) => {
      const requests = group.runs.reduce((sum, run) => sum + finiteCount(run.requestCount), 0);
      const row: HelperKindSummary = {
        kind: group.kind,
        ...(group.pluginId ? { pluginId: group.pluginId } : {}),
        runs: group.runs.length,
        completed: group.runs.filter((run) => run.outcome === 'completed').length,
        failed: group.runs.filter((run) => run.outcome === 'error').length,
        aborted: group.runs.filter((run) => run.outcome === 'aborted').length,
        requests,
      };
      // 平均请求耗时按「一次请求」算：一轮里发了几次请求，整轮耗时平摊到每次才有意义。
      const requestMs = group.runs.reduce((sum, run) => sum + finiteCount(run.requestMsTotal ?? 0), 0);
      if (requests > 0) row.avgRequestMs = Math.round((requestMs / requests) * 10) / 10;
      const output = meanOf(group.runs, (run) => run.outputTokens);
      if (output !== undefined) row.avgOutputTokens = output;
      return row;
    })
    .sort(
      (a, b) => b.runs - a.runs || a.kind.localeCompare(b.kind) || (a.pluginId ?? '').localeCompare(b.pluginId ?? ''),
    );
  if (kinds.length > MAX_HELPER_KINDS) {
    warnings.push(`Helper summary limited to the ${MAX_HELPER_KINDS} sources with the most runs.`);
    return { total, kinds: kinds.slice(0, MAX_HELPER_KINDS) };
  }
  return { total, kinds };
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
  private readonly correctionQueue: CorrectionQueue;
  /** 归属不明被丢弃的纠正次数，进 review 的 warnings。 */
  private droppedCorrections = 0;
  /** `pluginId/taskId` → 上次写插件失败记录的时间，只用于限流。 */
  private readonly pluginEventWrites = new Map<string, number>();

  constructor(
    root: string,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly context: { mode?: string; host?: string; pluginStatus?: () => PluginStatusFile } = {},
  ) {
    this.root = resolve(root);
    this.correctionQueue = new CorrectionQueue(this.root, (error) => this.persistenceError(error));
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
  private async withSummaryLock(directory: string, work: () => Promise<void>): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const release = acquireProcessLock(join(directory, 'summary.lock'));
      if (release) {
        try {
          await work();
          return;
        } finally {
          release();
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Run summary is busy; write was not applied.');
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
              await this.withSummaryLock(directory, () =>
                this.atomic(join(directory, 'summary.json'), JSON.stringify(current.summary, null, 2)),
              );
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
    if (state.pending.has(pendingKey)) state.unknownResults = (state.unknownResults ?? 0) + 1;
    if (state.pending.size >= 200) {
      state.pending.delete(state.pending.keys().next().value!);
      state.unknownResults = (state.unknownResults ?? 0) + 1;
    }
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
      if (state.calls.size >= MAX_KEYS) {
        state.summary.derivationDrops ??= { callObservations: 0, findingSignals: 0 };
        state.summary.derivationDrops.callObservations++;
        return argsHash;
      }
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
    recordedResultHash?: string | null,
  ): { category: string | null; expectedExit: boolean } {
    const pendingKey = correlation ?? `name:${name}`;
    const call = state.pending.get(pendingKey);
    state.pending.delete(pendingKey);
    // Only a result that is byte-identical to the previous ones counts as "no progress",
    // so the digest is recorded before any classification decision.
    this.noteResultHash(
      state,
      seq,
      call,
      recordedResultHash === undefined ? digest(textOf(result)) : recordedResultHash,
    );
    const category = recordedCategory === undefined ? errorCategory(result, name) : recordedCategory;
    const expected = recordedExpected ?? isExpectedExit(call, name, category);
    if (state.toolTally) {
      const entry = state.toolTally.get(name) ?? { calls: 0, errors: new Map<string, number>() };
      if (category && !expected) entry.errors.set(category, (entry.errors.get(category) ?? 0) + 1);
      state.toolTally.set(name, entry);
    }
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
  private noteResultHash(state: RunState, seq: number, call: Call | undefined, resultHash: string | null): void {
    if (!call) return;
    const key = `${call.name}\n${call.argsHash}`;
    const record = state.calls.get(key);
    if (!record) return;
    if (!resultHash) {
      record.count = 0;
      record.resultHashes.clear();
      return;
    }
    if (record.resultHashes.size < MAX_RESULT_HASHES) record.resultHashes.add(resultHash);
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
    // helper 运行与委派子代理都不是用户的一轮：压缩摘要每轮喂的是同一段 transcript，
    // 子代理的输入是父代理派给它的任务。拿它们跟上一轮用户输入比相似度，既会误报
    // 「用户重试」，也会把「上一轮用户说了什么」这个槽位挤掉。
    if (state.summary.helper || state.summary.delegation) return;
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
    // 与 noteRunInput 成对：不写记忆的运行也不该改写它的终态。
    if (summary.helper || summary.delegation) return;
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
    // helper 的失败按来源分开记：压缩摘要一直失败与「某一轮失败」是两件事，
    // 合并成一条只会让人觉得是那轮任务本身的问题。
    const helper = state.summary.helper;
    const source = helper ? helperSource(helper) : '';
    // purpose 也进 key 与标题：同一个插件可能既起标题又写提交说明，合并成一条就看不出
    // 是哪条链路在超时，而修法完全不同。
    const purpose = helper?.purpose ? ` · ${helper.purpose}` : '';
    this.addFinding(
      state,
      kind,
      helper
        ? `helper\n${helper.kind}\n${helper.pluginId ?? ''}\n${helper.purpose ?? ''}\n${category}`
        : `${state.summary.config.providerId}\n${state.summary.config.model}\n${category}`,
      seq,
      helper
        ? `${retry ? 'Helper request retry' : 'Helper run failed'}: ${source}${purpose} (${category})`
        : retry
          ? `Request retry: ${category}`
          : `Run ended with an error: ${category}`,
      helper ? (helper.pluginId ? `plugin:${helper.pluginId}` : `helper:${helper.kind}`) : 'runtime',
      retry
        ? 'Inspect provider availability, limits, and retry configuration before proposing a runtime change.'
        : 'Inspect the final error and preceding trace before identifying a runtime or guidance change.',
      retry
        ? 'Run comparable requests and compare retry rate, latency, and completion without masking persistent errors.'
        : 'Replay the original acceptance criteria and confirm both task completion and an independent user or test check.',
      retry ? `Attempt ${attempt}; category ${category}.` : `Runtime reported error: ${category}.`,
    );
  }

  noteCorrection(correction: { sessionId?: string; kind: CorrectionKind; chars?: number }): void {
    if (this.disposed) return;
    try {
      if (!correction || !CORRECTION_KINDS.has(correction.kind)) return;
      const sessionId = this.correctionSession(correction.sessionId);
      if (!sessionId) {
        this.droppedCorrections++;
        return;
      }
      const item = {
        sessionId,
        kind: correction.kind,
        ...(typeof correction.chars === 'number' && Number.isFinite(correction.chars) && correction.chars >= 0
          ? { chars: Math.floor(correction.chars) }
          : {}),
      };
      this.enqueue(() => this.correctionQueue.append(item));
    } catch (error) {
      try {
        this.onError(error);
      } catch {
        /* reporting must not break the host task */
      }
    }
  }

  /** 显式 sessionId 优先；否则只有「恰好一条会话在跑」时才敢归属。 */
  private correctionSession(sessionId: string | undefined): string | null {
    const explicit = typeof sessionId === 'string' ? boundedText(sessionId, 300).trim() : '';
    if (explicit) return explicit;
    const active = new Set<string>();
    for (const { summary } of this.active)
      if (summary.sessionId && !summary.helper && !summary.delegation) active.add(summary.sessionId);
    return active.size === 1 ? [...active][0]! : null;
  }

  /**
   * 把攒下的纠正挂到这次运行上：计数进 `summary.corrections`，并生成 `user-correction`
   * 问题条目（同会话同 kind 合并成一条，`occurrences` 就是纠正次数）。
   */
  private takeCorrections(state: RunState, seq: number, taken: StoredCorrection[]): void {
    const sessionId = state.summary.sessionId;
    if (!sessionId || taken.length === 0 || state.summary.helper || state.summary.delegation) return;
    const counts: CorrectionCounts = { edit: 0, recall: 0, retry: 0 };
    const chars: CorrectionCounts = { edit: 0, recall: 0, retry: 0 };
    for (const item of taken) {
      counts[item.kind]++;
      chars[item.kind] += item.chars ?? 0;
    }
    state.summary.corrections = counts;
    state.summary.correctionIds = taken.map((item) => item.id);
    for (const kind of CORRECTION_ORDER) {
      const count = counts[kind];
      if (count === 0) continue;
      const guidance = CORRECTION_GUIDANCE[kind];
      const charsPart = chars[kind] ? `; ${chars[kind]} chars` : '';
      const detail = `kind: ${kind}; ${count} correction(s) before this run${charsPart}; session ${sessionId}.`;
      for (let index = 0; index < count; index++)
        this.addFinding(
          state,
          'user-correction',
          `${sessionId}\n${kind}`,
          seq,
          guidance.title,
          'session',
          guidance.suggestion,
          guidance.evaluation,
          detail,
        );
    }
  }

  /**
   * 记一条插件自身的失败：常驻任务抛错（`background:failed`）或钩子处理函数抛错
   * （`hook:failed`，按 `hook:<名字>` 当任务名）。
   *
   * 它不挂在任何一条 run 上（两者都不在轮次里），所以单独落 `plugin-events.jsonl`：
   * 硬塞进某次运行的轨迹，会让那条运行的失败原因与耗时都变成假的。
   *
   * 限流只影响写盘频率、不丢「曾经失败」这个事实：每个任务在本进程内的第一条一定写
   * （一次失败立刻可见），之后同一任务每 5 分钟最多一条，`tick` / `failures` 随事件
   * 一起写进去，聚合时仍能看出「它一直在坏」。
   */
  notePluginEvent(event: PluginObservationEvent): void {
    if (this.disposed) return;
    try {
      if (!event) return;
      // 钩子失败没有 taskId：把钩子名当成任务名，报告里才能按「哪个钩子在炸」归组。
      const taskId =
        event.type === 'background:failed'
          ? boundedText(event.taskId, 200).trim()
          : event.type === 'hook:failed'
            ? boundedText(`hook:${event.hook}`, 200).trim()
            : '';
      if (!taskId) return;
      const pluginId = boundedText(event.pluginId, 200).trim();
      if (!pluginId) return;
      const key = `${pluginId}\n${taskId}`;
      const now = Date.now();
      const last = this.pluginEventWrites.get(key);
      if (last !== undefined && now - last < PLUGIN_EVENT_INTERVAL_MS) return;
      if (!this.pluginEventWrites.has(key) && this.pluginEventWrites.size >= MAX_PLUGIN_EVENT_KEYS)
        this.pluginEventWrites.delete(this.pluginEventWrites.keys().next().value!);
      this.pluginEventWrites.set(key, now);
      const record = {
        at: timestamp(event.timestamp),
        pluginId,
        taskId,
        tick: finiteCount(event.type === 'background:failed' ? event.tick : 0),
        failures: finiteCount(event.failures),
        error: boundedText(event.error, 500),
      };
      const line = `${JSON.stringify(record)}\n`;
      this.enqueue(async () => {
        await this.directory(this.root);
        await this.rotatePluginEvents();
        await appendFile(join(this.root, PLUGIN_EVENTS_FILE), line, { mode: 0o600 });
      });
    } catch (error) {
      try {
        this.onError(error);
      } catch {
        /* reporting must not break the plugin task */
      }
    }
  }

  /** 单个事件文件有上限：超了就滚成 `.1`（覆盖旧的），一个坏掉的任务写不满磁盘。 */
  private async rotatePluginEvents(): Promise<void> {
    try {
      const info = await stat(join(this.root, PLUGIN_EVENTS_FILE));
      if (info.size <= MAX_PLUGIN_EVENTS_BYTES) return;
      await rename(join(this.root, PLUGIN_EVENTS_FILE), join(this.root, PLUGIN_EVENTS_ROTATED));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /**
   * 读当前与轮转后的插件事件文件，按 `pluginId + taskId` 聚合。
   *
   * 坏行、缺文件、超限都是「读不到那一部分」，记 warning 后继续：一份写坏的日志
   * 不该让整次复盘失败。
   */
  private async readPluginFailures(warnings: string[]): Promise<PluginFailureSummary[]> {
    const groups = new Map<string, PluginFailureSummary>();
    // 写盘被限流：一个每 30 秒失败一次的任务，一小时只留 12 行，真实失败 120 次。
    // 事件自带累计数，最后取「行数」与「累计数最大值」中大的那个，才不会低估。
    const reported = new Map<string, number>();
    for (const name of [PLUGIN_EVENTS_FILE, PLUGIN_EVENTS_ROTATED]) {
      let text: string;
      try {
        const info = await stat(join(this.root, name));
        if (info.size > MAX_PLUGIN_EVENTS_READ_BYTES) {
          warnings.push(`${name} exceeds the plugin event size limit; its failures were not counted.`);
          continue;
        }
        text = await readFile(join(this.root, name), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          warnings.push(`Unreadable ${name}: ${boundedText(String(error))}`);
        continue;
      }
      let corrupt = 0;
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let item: { at?: unknown; pluginId?: unknown; taskId?: unknown; error?: unknown; failures?: unknown };
        try {
          item = JSON.parse(line) as typeof item;
        } catch {
          corrupt++;
          continue;
        }
        const pluginId = typeof item?.pluginId === 'string' ? boundedText(item.pluginId, 200).trim() : '';
        const taskId = typeof item?.taskId === 'string' ? boundedText(item.taskId, 200).trim() : '';
        const at = typeof item?.at === 'string' && Number.isFinite(Date.parse(item.at)) ? item.at : '';
        if (!pluginId || !taskId || !at) {
          corrupt++;
          continue;
        }
        const error = typeof item.error === 'string' ? boundedText(item.error, 500) : '';
        const key = `${pluginId}\n${taskId}`;
        const failures = typeof item.failures === 'number' ? finiteCount(item.failures) : 0;
        if (failures > (reported.get(key) ?? 0)) reported.set(key, failures);
        const existing = groups.get(key);
        if (!existing) {
          groups.set(key, { pluginId, taskId, count: 1, lastAt: at, lastError: error });
          continue;
        }
        existing.count++;
        if (at >= existing.lastAt) {
          existing.lastAt = at;
          existing.lastError = error;
        }
      }
      if (corrupt > 0) warnings.push(`${name} has ${corrupt} unreadable line(s); they were ignored.`);
    }
    for (const [key, failures] of reported) {
      const group = groups.get(key);
      // 进程重启会让累计数从 1 重新数；取最大值，所以这是「至少失败了这么多次」。
      if (group && failures > group.count) group.count = failures;
    }
    const rows = [...groups.values()].sort(
      (a, b) =>
        b.count - a.count ||
        b.lastAt.localeCompare(a.lastAt) ||
        a.pluginId.localeCompare(b.pluginId) ||
        a.taskId.localeCompare(b.taskId),
    );
    if (rows.length > MAX_PLUGIN_FAILURES) {
      warnings.push(`Plugin failures limited to the ${MAX_PLUGIN_FAILURES} tasks with the most recorded failures.`);
      return rows.slice(0, MAX_PLUGIN_FAILURES);
    }
    return rows;
  }

  /**
   * 压缩计数。实时写入与 `rebuild` 共用这一份，所以两边的次数与「最后一次」完全一致。
   *
   * `applied: false` 表示这次检查后决定不压（历史一个字没改），那不是一次压缩：算进去
   * 会让「反复压缩后出错」的排查指向根本没发生的动作。
   */
  private noteCompaction(
    state: RunState,
    event: {
      strategy: unknown;
      reason: unknown;
      beforeMessages: unknown;
      afterMessages: unknown;
      applied: unknown;
    },
  ): void {
    if (event.applied === false) return;
    const strategy = COMPACTION_STRATEGIES.has(event.strategy as CompactionStrategy)
      ? (event.strategy as CompactionStrategy)
      : undefined;
    if (!strategy) return;
    const counts = compactionCounts(state.summary.compactions as Partial<CompactionCounts> | undefined);
    counts[strategy]++;
    state.summary.compactions = counts;
    state.summary.lastCompaction = {
      strategy,
      reason: boundedText(event.reason ?? '', 120),
      beforeMessages: messageCount(event.beforeMessages),
      afterMessages: messageCount(event.afterMessages),
    };
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
      if (state.candidates.size >= MAX_FINDINGS) {
        state.summary.derivationDrops ??= { callObservations: 0, findingSignals: 0 };
        state.summary.derivationDrops.findingSignals++;
        return;
      }
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
          compactions: { local: 0, llm: 0, idle: 0 },
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
          derivationDrops: { callObservations: 0, findingSignals: 0 },
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
        // 先认 helper 再记输入指纹：压缩摘要每轮喂的是同一段 transcript，当成「用户重试
        // 同一任务」只是把正常机制读成用户的否定。
        const helper = helperOf(event.helper);
        if (helper) {
          state.summary.helper = helper;
          stored.helper = helper;
        }
        // 委派来源：有了它才能把子代理的运行挂回父会话，并按类型比成败。
        if (event.delegation) {
          const type = boundedText(event.delegation.type, 80).trim();
          const parent =
            typeof event.delegation.parentSessionId === 'string'
              ? boundedText(event.delegation.parentSessionId, 300).trim()
              : '';
          if (type) {
            state.summary.delegation = { type, ...(parent ? { parentSessionId: parent } : {}) };
            stored.delegation = state.summary.delegation;
          }
        }
        this.noteRunInput(state, seq, inputText, this.lastInputs);
        // run:start 时宿主已完成装配；每次运行只取一次内存快照。
        const plugins = readPluginSnapshot(this.context.pluginStatus);
        if (plugins) state.summary.plugins = plugins;
        if (!state.summary.helper && !state.summary.delegation && state.summary.sessionId) {
          const current = state;
          this.enqueue(async () => {
            const taken = await this.correctionQueue.take(current.summary.sessionId!, current.summary.id);
            if (taken.length === 0) return;
            this.takeCorrections(current, seq, taken);
            const directory = await this.runDirectory(current);
            await this.withSummaryLock(directory, () =>
              this.atomic(join(directory, 'summary.json'), JSON.stringify(current.summary, null, 2)),
            );
            await this.correctionQueue.ack(current.summary.id);
          });
        }
        this.save(state);
        break;
      }
      case 'request:start': {
        state.summary.requestCount++;
        stored.messageCount = event.messageCount;
        const tools = (event as unknown as { tools?: unknown }).tools;
        if (captureTrace && tools !== undefined) stored.tools = payload(tools, state.options);
        break;
      }
      case 'request:end': {
        // 请求级耗时：整轮里「等模型」占了多少、首字多慢、重试了几次。没有它，
        // 一次 4 分钟的 turn 只能看出总时长，分不清是模型慢还是工具慢。
        const durationMs = finiteCount(event.durationMs);
        state.summary.requestMsTotal = (state.summary.requestMsTotal ?? 0) + durationMs;
        state.summary.requestMsMax = Math.max(state.summary.requestMsMax ?? 0, durationMs);
        if (typeof event.firstTokenMs === 'number' && event.firstTokenMs >= 0) {
          state.summary.firstTokenMsTotal = (state.summary.firstTokenMsTotal ?? 0) + event.firstTokenMs;
          state.summary.firstTokenMsCount = (state.summary.firstTokenMsCount ?? 0) + 1;
        }
        stored.ms = durationMs;
        stored.attempts = finiteCount(event.attempts);
        stored.requestOutcome = event.outcome;
        if (typeof event.firstTokenMs === 'number') stored.firstTokenMs = finiteCount(event.firstTokenMs);
        if (event.error && captureTrace) stored.error = payload(event.error, state.options);
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
      case 'compaction': {
        // 压缩是正常机制：只计数 + 记最后一次，绝不生成问题条目。字段一并落进轨迹，
        // 这样 rebuild 重放能得出同样的次数。
        const strategy = typeof event.strategy === 'string' ? event.strategy : '';
        const reason = boundedText(event.reason, 120);
        const beforeMessages = messageCount(event.beforeMessages);
        const afterMessages = messageCount(event.afterMessages);
        const applied = event.applied !== false;
        stored.strategy = strategy;
        stored.reason = reason;
        stored.beforeMessages = beforeMessages;
        stored.afterMessages = afterMessages;
        stored.applied = applied;
        if (event.beforeChars !== undefined) stored.beforeChars = messageCount(event.beforeChars);
        if (event.afterChars !== undefined) stored.afterChars = messageCount(event.afterChars);
        this.noteCompaction(state, { strategy, reason, beforeMessages, afterMessages, applied });
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
    let pending: Promise<void>;
    do {
      pending = this.tail;
      await pending;
    } while (pending !== this.tail);
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
    await this.flush();
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
    const warnings = [...this.writeWarnings, ...this.correctionQueue.warnings];
    if (reclaimed > 0) warnings.push(`已回收 ${reclaimed} 个宿主已退出的未完成运行，标记为 interrupted。`);
    // 归属不明的纠正没有落点：如实说出来，而不是悄悄丢掉。
    if (this.droppedCorrections > 0)
      warnings.push(`丢弃了 ${this.droppedCorrections} 次无法确定会话的用户纠正，未记入任何运行。`);
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
        // 压缩计数同样是后加的：老摘要按 0 报，不要凭空补一次压缩。
        summary.compactions = compactionCounts(summary.compactions as Partial<CompactionCounts> | undefined);
        // helper 分类也是后加的：归一化一次，格式不对就整块丢掉（不判整份摘要损坏）。
        const helper = helperOf(summary.helper);
        if (helper) summary.helper = helper;
        else delete summary.helper;
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
    const toolTally: ToolTally = new Map();
    const toolHealthCoverage = { includedRuns: 0, excludedRuns: 0, unknownResults: 0 };
    const memory: InputMemory = new Map();
    for (const summary of [...runs].sort(
      (a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
    )) {
      const events = await inspectTrace(summary, warnings);
      if (
        !events ||
        summary.outcome === 'running' ||
        summary.droppedEvents > 0 ||
        events.length !== summary.eventCount
      ) {
        toolHealthCoverage.excludedRuns++;
        continue;
      }
      const state = derivationState(summary, events.length);
      state.toolTally = new Map();
      for (const event of events)
        if (event.type === 'tool:call' || event.type === 'tool:result') this.replay(state, event, memory);
      const unknown = (state.unknownResults ?? 0) + state.pending.size;
      toolHealthCoverage.unknownResults += unknown;
      if (unknown > 0) {
        toolHealthCoverage.excludedRuns++;
        warnings.push(
          `Run ${summary.id} has ${unknown} unpaired or unclassifiable tool result(s); excluded from tool health.`,
        );
        continue;
      }
      toolHealthCoverage.includedRuns++;
      mergeToolTally(toolTally, state.toolTally);
      summary.toolErrors = state.summary.toolErrors;
      summary.expectedExits = state.summary.expectedExits;
      summary.derivationDrops = state.summary.derivationDrops;
      summary.findings = [
        ...state.candidates.values(),
        ...summary.findings.filter((finding) => finding.kind !== 'tool-error' && finding.kind !== 'repeated-call'),
      ];
      for (const finding of summary.findings)
        for (const evidence of finding.evidence)
          evidence.available = events.some((event) => event.seq === evidence.seq);
    }
    runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const delegation = summarizeDelegation(runs, warnings);
    const helpers = summarizeHelpers(runs, warnings);
    const pluginFailures = await this.readPluginFailures(warnings);
    const derivationCoverage: DerivationCoverage = {
      limitedRuns: 0,
      callObservationsNotTracked: 0,
      findingSignalsNotRecorded: 0,
      unknownRuns: 0,
    };
    for (const run of runs) {
      if (!run.derivationDrops) {
        derivationCoverage.unknownRuns++;
        continue;
      }
      derivationCoverage.callObservationsNotTracked += run.derivationDrops.callObservations;
      derivationCoverage.findingSignalsNotRecorded += run.derivationDrops.findingSignals;
      if (run.derivationDrops.callObservations > 0 || run.derivationDrops.findingSignals > 0)
        derivationCoverage.limitedRuns++;
    }
    if (derivationCoverage.limitedRuns > 0)
      warnings.push(
        `Derivation limits affected ${derivationCoverage.limitedRuns} run(s): ${derivationCoverage.callObservationsNotTracked} tool-call observation(s) were omitted from repeated-call analysis after ${MAX_KEYS} distinct call keys, and ${derivationCoverage.findingSignalsNotRecorded} finding signal(s) were not recorded after ${MAX_FINDINGS} findings per run. Analysis is incomplete; absence of a finding is not evidence that no issue occurred.`,
      );
    if (derivationCoverage.unknownRuns > 0)
      warnings.push(
        `${derivationCoverage.unknownRuns} run(s) lack derivation-limit counters, so previous overflow is unknown; run harness-review rebuild to recompute trace-backed findings before treating the absence of findings as evidence of none.`,
      );
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
    // 插件常驻任务的失败不属于任何一条 run（没有 runId、也没有 cwd），但同样要进
    // `merged`：人工判断按 id 落在 decisions/ 里，不经过合并的条目就永远点不动。
    for (const failure of pluginFailures) {
      if (failure.count < PLUGIN_FAILURE_FINDING_COUNT) continue;
      const id = pluginFailureId(failure.pluginId, failure.taskId);
      merged.set(id, {
        id,
        kind: 'plugin-background',
        title: `插件常驻任务反复失败：${failure.pluginId}/${failure.taskId}`,
        module: `plugin:${failure.pluginId}`,
        suggestion:
          '先看这个插件的设置与凭据（缺 Key、地址填错、权限不足都会让每次周期都失败），再看它依赖的外部服务是否可达；两者都正常仍然失败，说明是插件或宿主的缺陷，按最近一次错误去改代码。',
        evaluation: `最近一次记录（${failure.lastAt}）：${failure.lastError || '(没有错误文本)'}。等下一个周期（或手动触发一次）确认日志里不再出现同一个错误，并且插件的「运行状态」恢复上报。`,
        status: 'open',
        occurrences: failure.count,
        // 插件事件不属于任何一条 run：伪造一个 runId 只会让人点进去看不到东西。
        evidence: [],
      });
    }
    for (const finding of merged.values()) {
      const assessments = await readAssessments(this.root, finding.id, warnings);
      const decision = assessments.at(-1);
      if (!decision) continue;
      finding.status = decision.status;
      finding.note = boundedText(decision.note, 8000);
      finding.updatedAt = decision.updatedAt;
      finding.assessments = assessments.map(({ status, note, updatedAt }) => ({
        status,
        note: boundedText(note, 8000),
        updatedAt,
      }));
      if (decision.status !== 'validated' && decision.status !== 'dismissed') continue;
      if (!decision.baseline) {
        finding.reviewNeeded = { reason: 'baseline-unavailable', occurrences: 0, runs: 0 };
        continue;
      }
      const baseline = decision.baseline;
      if ('plugin' in baseline) {
        const failure = pluginFailures.find((item) => pluginFailureId(item.pluginId, item.taskId) === finding.id);
        if (failure && Date.parse(failure.lastAt) > Date.parse(baseline.plugin.lastAt))
          finding.reviewNeeded = {
            reason: 'new-evidence',
            occurrences: Math.max(1, failure.count - baseline.plugin.count),
            runs: 0,
          };
        continue;
      }
      let occurrences = 0;
      let affectedRuns = 0;
      for (const run of runs) {
        const candidate = run.findings.find((item) => item.id === finding.id);
        if (!candidate) continue;
        const previous = baseline.runs[run.id];
        if (previous === undefined && Date.parse(run.startedAt) < Date.parse(decision.updatedAt)) continue;
        const added = candidate.occurrences - (previous ?? 0);
        if (added > 0) {
          occurrences += added;
          affectedRuns++;
        }
      }
      if (occurrences > 0) finding.reviewNeeded = { reason: 'new-evidence', occurrences, runs: affectedRuns };
    }
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      root: this.root,
      ...(filter ? { cwd: filter } : {}),
      runs,
      findings: [...merged.values()].sort(
        (a, b) =>
          Number(Boolean(b.reviewNeeded) || b.status === 'regressed') -
            Number(Boolean(a.reviewNeeded) || a.status === 'regressed') ||
          b.occurrences - a.occurrences ||
          a.id.localeCompare(b.id),
      ),
      delegation,
      helpers,
      pluginFailures,
      toolHealth: toolHealthRows(toolTally),
      toolHealthCoverage,
      derivationCoverage,
      warnings,
      scannedRuns,
      limits: {
        runs: MAX_RUNS,
        findingsPerRun: MAX_FINDINGS,
        distinctCallKeysPerRun: MAX_KEYS,
        evidencePerFinding: MAX_EVIDENCE,
      },
      interpretation:
        'Findings are review candidates, not established causes. Tool errors do not imply task failure. Completed runs are not user validation. Decisions are manual and persist across runs; repeated calls may reflect legitimate polling or pagination.',
    };
  }

  async decide(id: string, status: FindingStatus, note: string, cwd?: string): Promise<void> {
    // 运行派生条目的 id 是内容摘要；插件失败条目的 id 是可读的 `plugin-background:<plugin>:<task>`。
    // 两者都必须能直接当文件名，所以只放行这一份白名单字符。
    if (!/^[a-f0-9]{64}$/.test(id) && !/^plugin-background:[A-Za-z0-9._-]{1,80}:[A-Za-z0-9._-]{1,120}$/.test(id))
      throw new Error('Invalid finding ID');
    if (!STATUSES.has(status)) throw new Error('Invalid finding status');
    if (typeof note !== 'string' || !note.trim()) throw new Error('Assessment note is required');
    const observedAt = new Date().toISOString();
    const report = await this.review(cwd);
    const plugin = report.pluginFailures.find((item) => pluginFailureId(item.pluginId, item.taskId) === id);
    const baseline: AssessmentBaseline = plugin
      ? { plugin: { count: plugin.count, lastAt: plugin.lastAt } }
      : {
          runs: Object.fromEntries(
            report.runs.map((run) => {
              const finding = run.findings.find((item) => item.id === id);
              return [run.id, finding?.occurrences ?? 0];
            }),
          ),
        };
    const assessment: FindingAssessment = {
      version: 1,
      id,
      status,
      note: boundedText(note, 8000),
      updatedAt: observedAt,
      baseline,
    };
    // Explicit user actions report write failures to the caller as well as onError.
    let failure: unknown;
    this.enqueue(async () => {
      try {
        await writeAssessment(this.root, assessment);
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
   *
   * 用户纠正（`input:corrected`）不在轨迹里——它发生在两轮之间，采集时直接写进
   * `summary.corrections`。所以重算必须**保留**已有 corrections 与由它产生的条目，
   * 否则每次 rebuild 都会把这条最确凿的信号抹掉。
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
      const state = derivationState(summary, lines.length);
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
      if (!usable || expected !== summary.eventCount || (state.unknownResults ?? 0) > 0 || state.pending.size > 0) {
        skippedUnreadable++;
        continue;
      }
      // Every replayed event exists on disk, so re-derived evidence is traceable.
      for (const finding of state.candidates.values())
        for (const evidence of finding.evidence) evidence.available = true;
      // 压缩次数是采集时记下的事实（和 requestCount 一样）：摘要有就照原样留下，只在
      // 老摘要没有这一块时，用同一条推导重放出来的结果补上。
      const recordedCompactions = (summary.compactions as Partial<CompactionCounts> | undefined)
        ? compactionCounts(summary.compactions as Partial<CompactionCounts>)
        : state.summary.compactions;
      const recordedLastCompaction = summary.lastCompaction ?? state.summary.lastCompaction;
      try {
        await this.withSummaryLock(directory, async () => {
          const latest = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')) as RunSummary;
          if (
            latest.outcome === 'running' ||
            latest.finishedAt !== summary.finishedAt ||
            latest.eventCount !== summary.eventCount
          ) {
            skippedRunning++;
            return;
          }
          const replaced = [
            ...state.candidates.values(),
            ...latest.findings.filter((finding) => finding.kind === 'user-correction'),
          ];
          await this.atomic(
            join(directory, 'summary.json'),
            JSON.stringify(
              {
                ...latest,
                toolErrors: state.summary.toolErrors,
                expectedExits: state.summary.expectedExits,
                derivationDrops: state.summary.derivationDrops,
                compactions: latest.compactions ?? recordedCompactions,
                ...((latest.lastCompaction ?? recordedLastCompaction)
                  ? { lastCompaction: latest.lastCompaction ?? recordedLastCompaction }
                  : {}),
                findings: replaced,
              },
              null,
              2,
            ),
          );
          rebuilt++;
          findings += replaced.length;
        });
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
      if (state.toolTally) {
        const entry = state.toolTally.get(name) ?? { calls: 0, errors: new Map<string, number>() };
        entry.calls++;
        state.toolTally.set(name, entry);
      }
      const argsHash =
        typeof event.argsHash === 'string' && /^[a-f0-9]{64}$/.test(event.argsHash) ? event.argsHash : undefined;
      this.noteToolCall(state, seq, name, storedText(event.args), correlation, argsHash);
      const call = state.pending.get(correlation ?? `name:${name}`);
      if (call) call.argsComplete = hasCompleteContent(event.args);
    } else if (event.type === 'tool:result') {
      const complete = hasCompleteContent(event.result);
      const category =
        truncatedToolCategory(event.result, name) ??
        (!complete && (typeof event.errorCategory === 'string' || event.errorCategory === null)
          ? event.errorCategory
          : undefined);
      if ((!complete && category === undefined) || state.pending.get(correlation ?? `name:${name}`)?.name !== name)
        state.unknownResults = (state.unknownResults ?? 0) + 1;
      const resultHash =
        event.result &&
        typeof event.result === 'object' &&
        typeof (event.result as Record<string, unknown>).sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test((event.result as Record<string, unknown>).sha256 as string)
          ? ((event.result as Record<string, unknown>).sha256 as string)
          : typeof event.result === 'string'
            ? digest(textOf(event.result))
            : null;
      this.noteToolResult(
        state,
        seq,
        name,
        storedText(event.result),
        correlation,
        category,
        (!complete || state.pending.get(correlation ?? `name:${name}`)?.argsComplete === false) &&
          event.expectedExit === true
          ? true
          : undefined,
        resultHash,
      );
    } else if (event.type === 'compaction') {
      // 与实时写入同一条推导：轨迹里有 strategy 的老事件才算得上一次压缩。
      this.noteCompaction(state, {
        strategy: typeof event.strategy === 'string' ? event.strategy : undefined,
        reason: typeof event.reason === 'string' ? event.reason : '',
        beforeMessages: event.beforeMessages,
        afterMessages: event.afterMessages,
        applied: event.applied !== false,
      });
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
  // 负数 runId 属于不在 turn loop 里的子运行（委派子代理与 helper）：它们是合法的
  // 运行记录，早期版本按「必须非负」判会把它们整份丢掉。
  if (!Number.isSafeInteger(value.sourceRunId)) return false;
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
  const derivationDrops = value.derivationDrops as { callObservations: number; findingSignals: number } | undefined;
  if (
    derivationDrops !== undefined &&
    (!derivationDrops || !isCount(derivationDrops.callObservations) || !isCount(derivationDrops.findingSignals))
  )
    return false;
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
  // 压缩计数、纠正、委派与插件快照都是后加的：缺失按「没有」处理，有就必须是合法形状。
  const compactions = value.compactions as Partial<CompactionCounts> | undefined;
  if (
    compactions !== undefined &&
    (!compactions || !['local', 'llm', 'idle'].every((key) => isCount(compactions[key as CompactionStrategy])))
  )
    return false;
  const lastCompaction = value.lastCompaction as Partial<RecordedCompaction> | undefined;
  if (
    lastCompaction !== undefined &&
    (!lastCompaction ||
      !COMPACTION_STRATEGIES.has(lastCompaction.strategy as CompactionStrategy) ||
      typeof lastCompaction.reason !== 'string' ||
      !isCount(lastCompaction.beforeMessages) ||
      !isCount(lastCompaction.afterMessages))
  )
    return false;
  const corrections = value.corrections as Partial<CorrectionCounts> | undefined;
  if (corrections !== undefined && (!corrections || !CORRECTION_ORDER.every((key) => isCount(corrections[key]))))
    return false;
  if (
    value.correctionIds !== undefined &&
    (!Array.isArray(value.correctionIds) ||
      value.correctionIds.length > 2000 ||
      !value.correctionIds.every(
        (id) =>
          typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id),
      ))
  )
    return false;
  const delegation = value.delegation as Partial<RunDelegation> | undefined;
  if (
    delegation !== undefined &&
    (!delegation ||
      typeof delegation.type !== 'string' ||
      !delegation.type.trim() ||
      (delegation.parentSessionId !== undefined && typeof delegation.parentSessionId !== 'string'))
  )
    return false;
  const plugins = value.plugins as Partial<RunPlugins> | undefined;
  if (
    plugins !== undefined &&
    (!plugins ||
      (plugins.host !== undefined && typeof plugins.host !== 'string') ||
      !isCount(plugins.loaded) ||
      typeof plugins.hash !== 'string' ||
      !/^[a-f0-9]{8,64}$/.test(plugins.hash) ||
      !isPluginIdList(plugins.failed) ||
      !isPluginIdList(plugins.skipped))
  )
    return false;
  // helper 分类是后加的：缺省合法，形状不对只丢掉这一块——它只影响报告怎么分组，
  // 判整份摘要损坏会把那次运行的计数与证据一起丢掉。
  if (value.helper !== undefined) {
    const helper = helperOf(value.helper);
    if (helper) value.helper = helper;
    else delete value.helper;
  }
  // 请求级耗时是后加的：老摘要没有它，有就必须是有限的非负数。
  for (const key of ['requestMsTotal', 'requestMsMax', 'firstTokenMsTotal', 'firstTokenMsCount'] as const) {
    const metric = value[key];
    if (metric !== undefined && (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0)) return false;
  }
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
      ['tool-error', 'repeated-call', 'run-error', 'retry', 'user-retry', 'user-correction'].includes(finding.kind) &&
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

/** 一次轨迹巡检的副产品：按工具统计的调用量、失败数与错误类别。 */
type ToolTally = Map<string, { calls: number; errors: Map<string, number> }>;

function derivationState(summary: RunSummary, written: number): RunState {
  return {
    summary: {
      ...summary,
      toolErrors: 0,
      expectedExits: 0,
      derivationDrops: { callObservations: 0, findingSignals: 0 },
      findings: [],
    },
    options: { captureContent: false, maxEventChars: 4000, maxEventsPerRun: 2000 },
    seq: 0,
    written,
    calls: new Map(),
    writeMarks: [],
    pending: new Map(),
    candidates: new Map(),
  };
}

async function inspectTrace(summary: RunSummary, warnings: string[]): Promise<StoredEvent[] | null> {
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
      return null;
    }
    const text = await readFile(summary.traceFile, 'utf8');
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    let previous = 0;
    const events: StoredEvent[] = [];
    for (let index = 0; index < lines.length; index++) {
      try {
        const event = JSON.parse(lines[index]) as StoredEvent;
        if (
          !event ||
          !Number.isInteger(event.seq) ||
          event.seq <= previous ||
          (summary.droppedEvents === 0 && event.seq !== previous + 1) ||
          typeof event.type !== 'string' ||
          typeof event.timestamp !== 'string' ||
          !Number.isFinite(Date.parse(event.timestamp))
        )
          throw new Error('invalid event');
        previous = event.seq;
        events.push(event);
        for (const item of bySeq.get(event.seq) ?? []) item.available = true;
      } catch {
        warnings.push(`Run ${summary.id} has a corrupt trace at line ${index + 1}.`);
        return null;
      }
    }
    // 摘要每 25 条事件才落一次盘：宿主被杀掉的那次运行，轨迹会比摘要多出几条。
    // 多出来是正常的（摘要滞后），少掉才是真的缺事件。
    if (lines.length < summary.eventCount - summary.droppedEvents) {
      warnings.push(`Run ${summary.id} trace has fewer events than its summary counts; the trace may be truncated.`);
      return null;
    }
    return events;
  } catch {
    warnings.push(`Run ${summary.id} has a missing or unreadable trace: ${summary.traceFile}`);
    return null;
  }
}

function mergeToolTally(target: ToolTally, source: ToolTally): void {
  for (const [name, row] of source) {
    const entry = target.get(name) ?? { calls: 0, errors: new Map<string, number>() };
    entry.calls += row.calls;
    for (const [category, count] of row.errors) entry.errors.set(category, (entry.errors.get(category) ?? 0) + count);
    target.set(name, entry);
  }
}

/** 把按工具累计的原始计数整理成报告行：失败率降序，没有调用的结果条目不计。 */
function toolHealthRows(tally: ToolTally): ToolHealthRow[] {
  const rows: ToolHealthRow[] = [];
  for (const [name, entry] of tally) {
    const errors = [...entry.errors.values()].reduce((sum, count) => sum + count, 0);
    if (entry.calls === 0) continue;
    rows.push({
      name,
      calls: entry.calls,
      errors,
      errorRate: Math.round((errors / entry.calls) * 1000) / 1000,
      categories: [...entry.errors.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([category, count]) => ({ category, count })),
    });
  }
  return rows
    .sort((a, b) => b.errorRate - a.errorRate || b.errors - a.errors || a.name.localeCompare(b.name))
    .slice(0, MAX_TOOL_HEALTH_ROWS);
}

function markdownText(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/([\\`*_{}\[\]()<>|#!])/g, '\\$1');
}

/**
 * 「等模型」那一列：累计等待时长 + 单次最长 + 平均首字。
 *
 * 老摘要没有请求级耗时（`request:end` 是后加的），那时如实画 `—`，
 * 不要用整轮时长冒充。
 */
function requestWaitSummary(run: RunSummary): string {
  if (run.requestMsTotal === undefined) return '—';
  const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
  const firstToken =
    run.firstTokenMsCount && run.firstTokenMsTotal !== undefined
      ? ` · first ${seconds(run.firstTokenMsTotal / run.firstTokenMsCount)}`
      : '';
  return `${seconds(run.requestMsTotal)} / ${seconds(run.requestMsMax ?? 0)}${firstToken}`;
}

/** 压缩次数按 local / llm / idle 三个数写出来；一次都没压就画 `—`。 */
function compactionSummary(run: RunSummary): string {
  const counts = compactionCounts(run.compactions as Partial<CompactionCounts> | undefined);
  if (counts.local + counts.llm + counts.idle === 0) return '—';
  return `${counts.local} / ${counts.llm} / ${counts.idle}`;
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
    '| Run | Outcome | Model | Requests | Tools / errors | Retries | Compactions (local / llm / idle) | Waiting / first token | Tokens in / out / cached | Dropped events |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  // helper 运行不进 Runs 表：一次 turn 配一条标题生成，表会翻倍而没人看；它们仍在
  // JSON 的 runs 里，由下面的 Helpers 小节按来源汇总。
  const userRuns = report.runs.filter((run) => !run.helper);
  for (const run of userRuns)
    lines.push(
      `| [${run.id}](<${link(run.traceFile)}>) | ${run.outcome} | ${markdownText(run.config.model)}${run.delegation ? ` · subagent ${markdownText(run.delegation.type)}` : ''} | ${run.requestCount} | ${run.toolCalls} / ${run.toolErrors} | ${run.retries} | ${compactionSummary(run)} | ${requestWaitSummary(run)} | ${run.inputTokens} / ${run.outputTokens} / ${run.cachedInputTokens} | ${run.droppedEvents} |`,
    );
  if (!userRuns.length) lines.push('', 'No runs in this scope.');
  lines.push('', '## Delegation', '');
  if (!report.delegation.parents.length) lines.push('No delegated runs in this scope.', '');
  else {
    lines.push(
      '| Parent session | Type | Runs | Completed | Failed | Aborted | Avg requests | Avg output tokens |',
      '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const parent of report.delegation.parents)
      for (const row of parent.types)
        lines.push(
          `| ${markdownText(parent.parentSessionId ?? '(unknown parent)')} | ${markdownText(row.type)} | ${row.runs} | ${row.completed} | ${row.failed} | ${row.aborted} | ${row.avgRequests ?? '—'} | ${row.avgOutputTokens ?? '—'} |`,
        );
    lines.push('');
  }
  lines.push('', '## Helpers', '');
  if (!report.helpers.kinds.length) lines.push('No helper runs in this scope.', '');
  else {
    lines.push(
      '| Source | Runs | Completed | Failed | Aborted | Requests | Avg request ms | Output tokens |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    );
    for (const row of report.helpers.kinds)
      lines.push(
        `| ${markdownText(helperSource(row))} | ${row.runs} | ${row.completed} | ${row.failed} | ${row.aborted} | ${row.requests} | ${row.avgRequestMs ?? '—'} | ${row.avgOutputTokens ?? '—'} |`,
      );
    lines.push('');
  }
  lines.push('', '## Tool health', '');
  lines.push(
    `Coverage: ${report.toolHealthCoverage.includedRuns} runs included; ${report.toolHealthCoverage.excludedRuns} excluded; ${report.toolHealthCoverage.unknownResults} unpaired or unclassifiable tool results. Excluded data is unknown, not zero failures.`,
    '',
  );
  if (!report.toolHealth.length) lines.push('No tool calls in this scope.', '');
  else {
    lines.push(
      'Error rate is what says whether a tool needs fixing: 400 failures out of 20,000 calls is noise, 80 out of 160 is a defect.',
      '',
      '| Tool | Calls | Errors | Error rate | Top categories |',
      '| --- | ---: | ---: | ---: | --- |',
    );
    for (const row of report.toolHealth)
      lines.push(
        `| ${markdownText(row.name)} | ${row.calls} | ${row.errors} | ${(row.errorRate * 100).toFixed(1)}% | ${row.categories.map((item) => `${markdownText(item.category)} ×${item.count}`).join(' · ') || '—'} |`,
      );
    lines.push('');
  }
  lines.push('', '## Derivation coverage', '');
  lines.push(
    `${report.derivationCoverage.limitedRuns} run(s) reached an analysis limit; ${report.derivationCoverage.callObservationsNotTracked} tool-call observation(s) were omitted from repeated-call analysis; ${report.derivationCoverage.findingSignalsNotRecorded} finding signal(s) were not recorded; ${report.derivationCoverage.unknownRuns} run(s) have unknown limit history.`,
    'A missing finding is not evidence that no issue occurred in limited or unknown runs.',
    '',
  );
  lines.push('', '## Plugin health', '');
  // 常驻任务失败是机器级事实：插件不在任何一轮里跑，也就没有 cwd 可过滤。
  lines.push(
    'Plugin failures (background tasks and throwing hooks) are per machine, not per workspace: these counts ignore the reviewed working directory.',
    '',
    'Counts are a lower bound: one task leaves at most one record per five minutes, and its cumulative counter restarts with the host.',
    '',
  );
  if (!report.pluginFailures.length) lines.push('No plugin background failures recorded.', '');
  else {
    lines.push('| Plugin | Task | Failures | Last failure | Last error |', '| --- | --- | ---: | --- | --- |');
    for (const failure of report.pluginFailures)
      lines.push(
        `| ${markdownText(failure.pluginId)} | ${markdownText(failure.taskId)} | ${failure.count} | ${markdownText(failure.lastAt)} | ${markdownText(failure.lastError)} |`,
      );
    lines.push('');
  }
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
    if (finding.reviewNeeded)
      lines.push(
        finding.reviewNeeded.reason === 'new-evidence'
          ? `Review needed: ${finding.reviewNeeded.occurrences} new occurrence(s) in ${finding.reviewNeeded.runs} run(s) since the assessment baseline. The manual status is unchanged; this is not an automatic regression verdict.`
          : 'Review needed: the historical assessment has no recorded baseline; later failures cannot be separated reliably. Reassess to establish a baseline.',
        '',
      );
    if (finding.assessments?.length) {
      lines.push('Assessment history (manual reports):', '');
      for (const assessment of finding.assessments)
        lines.push(`- ${markdownText(assessment.updatedAt)} · ${assessment.status}: ${markdownText(assessment.note)}`);
      lines.push('');
    }
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
    `Review limits: ${report.limits.runs} runs, ${report.limits.findingsPerRun} findings per run, ${report.limits.distinctCallKeysPerRun} distinct call keys per run, ${report.limits.evidencePerFinding} evidence items per finding.`,
    '',
  );
  return lines.join('\n');
}
