import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks, ToolInput } from './MicaTool.js';
import { describeCondition, probeCondition } from './waitFor/conditions.js';
import {
  createWaitRecord,
  getWaitRecord,
  isResumableWaitStatus,
  settleWaitRecord,
  type WaitRecord,
} from './waitFor/registry.js';
import { WAIT_KINDS, type NormalizedWaitCondition, type WaitKind } from './waitFor/types.js';
import { truncateDisplayText } from './utils/display.js';

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 1_800_000;
const MIN_POLL_INTERVAL_MS = 50;

const DEFAULT_TIMEOUT_LABEL = `${DEFAULT_TIMEOUT_MS / 1000}s`;
const MAX_TIMEOUT_LABEL = `${MAX_TIMEOUT_MS / 1000}s`;

const DEFAULT_POLL_INTERVAL_MS: Record<WaitKind, number> = {
  task: 250,
  process: 250,
  file: 500,
  command: 1000,
  http: 1000,
  port: 1000,
  duration: 250,
};

const DESCRIPTION = [
  '等一个外部条件成立后返回。它只观察、不启动任何东西，也不产生副作用。',
  '',
  '用它：等后台任务跑完、等文件出现或内容变化、等服务端口可连、等某个命令输出匹配。',
  '别用它启动进程——真正执行命令的是 `run_shell`（前台等它跑完）或 `background_tasks_start`（后台，先拿 task_id）。',
  '别用它代替 `sleep` 轮询：`duration` 只用于确实需要等固定时长、且没有更好观察条件的场合。',
  '',
  '等待不会占住整条消息：同一条消息里的其他工具调用会与它并发执行，结果最后一起返回。因此正确用法是把「要等的事」和「等待期间能做的其他调用」放进同一条消息——不要先单独空等一轮再动手。',
  '',
  'kind 决定等什么：',
  '- task：等一个 `background_tasks_start` 启动的后台任务结束（task_id）。dev server、watch 这类不会自己退出的进程不要用 task 等它结束——它不会结束，只会在这里耗到超时；改用 `port` / `http` 等它「起来了」，或直接 `background_tasks_read` 看输出。',
  '- process：等某个 pid 退出。',
  '- file：等文件出现 / 消失 / 内容变化 / 内容匹配正则（until 取 exists|missing|changed|matches）。',
  '- command：反复执行一条命令，等它满足退出码或输出条件（until 取 exit_zero|exit_nonzero|expected_exit_code|stdout_matches|stdout_changed）。例如 until=exit_zero + command="curl -sf http://127.0.0.1:3000/health"。',
  '- http：反复请求一个 URL，等它可访问 / 状态码符合 / 响应体匹配或变化（until 取 reachable|status|body_matches|body_changed）。',
  '- port：等某个 host:port 能建立 TCP 连接（例如 dev server 就绪）。',
  '- duration：单纯等待 seconds 秒。',
  '',
  `超时不算失败：timeout_ms（默认 ${DEFAULT_TIMEOUT_LABEL}，最大 ${MAX_TIMEOUT_LABEL}）内条件没成立就返回 status=timeout 与一个 wait_id，带上同一个 wait_id 再调用一次即可继续等待——观察基线保留、不重新计时。条件何时成立无法预估时可以放心用默认预算 + 续等，而不是一次把 timeout_ms 开到上限。`,
  '轮询本身失败（连不上、命令起不来）只记进 last error，不代表条件不成立。',
  'reason：一句话说明为什么要等（人读），会显示在客户端的「等待中」列表上。可选，但建议每次都写——尤其 duration 这种「等一段时间」的等待，条件标签本身说不清在等什么。',
].join('\n');

export class ToolWaitFor extends MicaTool {
  constructor() {
    super(
      'wait_for',
      DESCRIPTION,
      {
        type: 'object' as const,
        properties: {
          kind: {
            type: 'string',
            description: `等待条件类型，取 ${WAIT_KINDS.join('|')}。用 wait_id 续等时可以省略。`,
          },
          wait_id: { type: 'string', description: '续等/查询同一条等待时传入它上次返回的 id（保留原来的观察基线）。' },
          timeout_ms: {
            type: 'number',
            description: `本次调用的等待预算，默认 ${DEFAULT_TIMEOUT_LABEL}，最大 ${MAX_TIMEOUT_LABEL}。传 0 表示只做一次立即检查。`,
          },
          poll_interval_ms: { type: 'number', description: '轮询间隔毫秒；默认按 kind 取值，最小 50。' },
          reason: {
            type: 'string',
            description:
              '为什么等：一句话人读的说明（例如「等 dev server 起来」），客户端「等待中」列表会优先显示它。可选，但建议提供——duration 等待尤其需要，否则用户只看到一串秒数、不知道在等什么。',
          },
          task_id: { type: 'string', description: 'kind=task：run_shell 后台任务 ID。' },
          pid: { type: 'number', description: 'kind=process：要等待退出的进程 pid。' },
          file_path: { type: 'string', description: 'kind=file：文件路径（相对路径按当前工作目录解析）。' },
          until: {
            type: 'string',
            description:
              '条件谓词，按 kind 取值：file→exists|missing|changed|matches（默认 exists）；command→exit_zero|exit_nonzero|expected_exit_code|stdout_matches|stdout_changed（默认 exit_zero）；http→reachable|status|body_matches|body_changed（默认 reachable）。',
          },
          pattern: {
            type: 'string',
            description: 'until 为 matches 系列时的正则（作用于文件内容 / 响应体 / 命令输出）。',
          },
          command: { type: 'string', description: 'kind=command：反复执行的命令。' },
          cwd: { type: 'string', description: 'kind=command：命令的工作目录。' },
          expected_exit_code: {
            type: 'number',
            description: 'kind=command 且 until=expected_exit_code 时期望的退出码。',
          },
          url: { type: 'string', description: 'kind=http：请求的 URL。' },
          method: { type: 'string', description: 'kind=http：HTTP 方法，默认 GET。' },
          headers: { type: 'object', description: 'kind=http：请求头。' },
          body: { type: 'string', description: 'kind=http：请求体。' },
          expect_status: { type: 'number', description: 'kind=http 且 until=status 时期望的状态码，默认 200。' },
          host: { type: 'string', description: 'kind=port：主机，默认 127.0.0.1。' },
          port: { type: 'number', description: 'kind=port：端口。' },
          seconds: { type: 'number', description: 'kind=duration：等待多少秒。' },
        },
      },
      { readOnly: false, overlappable: true },
    );
  }

  async execute(input: ToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const parsed = this.parseInput(input);
    if (!parsed.ok) return `wait_for 输入校验失败：${parsed.message}`;

    if (parsed.mode === 'resume') {
      const record = parsed.record;
      if (!isResumableWaitStatus(record.status)) return formatResult(record, { settledByEarlierCall: true });
      if (parsed.pollIntervalMs !== undefined) record.pollIntervalMs = parsed.pollIntervalMs;
      if (parsed.reason !== undefined) record.reason = parsed.reason;
      record.status = 'waiting';
      return this.runWaitLoop(record, callbacks, parsed.timeoutMs);
    }

    const record = createWaitRecord({
      kind: parsed.condition.kind,
      label: describeCondition(parsed.condition),
      reason: parsed.reason,
      condition: parsed.condition,
      pollIntervalMs: parsed.pollIntervalMs,
      timeoutMs: parsed.timeoutMs,
      status: 'waiting',
    });

    return this.runWaitLoop(record, callbacks, parsed.timeoutMs);
  }

  private async runWaitLoop(
    record: WaitRecord,
    callbacks: ToolExecuteCallbacks | undefined,
    timeoutMs: number,
  ): Promise<string> {
    const signal = callbacks?.signal;
    // timeout_ms=0 就是「只做一次立即检查」：截止时间落在当下，循环轮询一次后
    // 走 timeout 分支返回。
    record.deadline = Date.now() + timeoutMs;

    for (;;) {
      if (signal?.aborted) {
        settleWaitRecord(record, 'aborted');
        return formatResult(record, { hint: '等待被中断（turn 被中止），记录已清理。' });
      }

      let satisfied = false;
      try {
        const probe = await probeCondition({
          condition: record.condition,
          baseline: record.baseline,
          startedAt: record.createdAt,
          signal,
          pathContext: callbacks?.context,
        });
        record.polls += 1;
        if (probe.detail) record.detail = probe.detail;
        if (probe.error) record.error = probe.error;
        satisfied = probe.satisfied;
      } catch (error) {
        record.polls += 1;
        record.error = error instanceof Error ? error.message : String(error);
      }

      if (signal?.aborted) {
        settleWaitRecord(record, 'aborted');
        return formatResult(record, { hint: '等待被中断（turn 被中止），记录已清理。' });
      }

      if (satisfied) {
        record.error = undefined;
        settleWaitRecord(record, 'satisfied');
        return formatResult(record);
      }

      const remaining = record.deadline - Date.now();
      if (remaining <= 0) {
        settleWaitRecord(record, 'timeout');
        return formatResult(record, {
          hint: `条件尚未成立。用 wait_for({ wait_id: "${record.id}" }) 继续等待（保留观察基线，不重新计时），或增大 timeout_ms。`,
        });
      }

      await sleepAbortable(Math.min(record.pollIntervalMs, remaining), signal);
    }
  }

  private parseInput(input: ToolInput): ParsedWaitInput {
    const waitId = readString(input.wait_id);
    const timeoutMs =
      input.timeout_ms === undefined || input.timeout_ms === null
        ? DEFAULT_TIMEOUT_MS
        : clamp(readNumber(input.timeout_ms) ?? DEFAULT_TIMEOUT_MS, 0, MAX_TIMEOUT_MS);
    const kindHint = readString(input.kind)?.toLowerCase();
    if (kindHint && !WAIT_KINDS.includes(kindHint as WaitKind)) {
      return { ok: false, message: `未知的 kind：${kindHint}（可用 ${WAIT_KINDS.join('|')}）` };
    }

    if (waitId) {
      const record = getWaitRecord(waitId);
      if (!record) return { ok: false, message: `未知或已过期的 wait_id：${waitId}` };
      if (kindHint && kindHint !== record.kind) {
        return { ok: false, message: `wait_id ${waitId} 的 kind 是 ${record.kind}，与传入的 ${kindHint} 不一致` };
      }
      const pollIntervalMs =
        input.poll_interval_ms === undefined ? undefined : normalizePollInterval(input.poll_interval_ms, record.kind);
      return { ok: true, mode: 'resume', record, timeoutMs, pollIntervalMs, reason: normalizeReason(input.reason) };
    }

    if (!kindHint) return { ok: false, message: '需要提供 kind，或提供上次返回的 wait_id 续等' };
    const normalized = normalizeCondition(kindHint as WaitKind, input);
    if (!normalized.ok) return { ok: false, message: normalized.message };
    return {
      ok: true,
      mode: 'create',
      condition: normalized.condition,
      timeoutMs,
      pollIntervalMs: normalizePollInterval(input.poll_interval_ms, normalized.condition.kind),
      reason: normalizeReason(input.reason),
    };
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    const waitId = readString(input.wait_id);
    if (waitId) return `wait_for ${truncateDisplayText(waitId, 12)} (续等)`;
    const kind = readString(input.kind)?.toLowerCase() ?? '?';
    const target = readString(input.url) ?? readString(input.file_path) ?? readString(input.command) ?? '';
    const detail = target ? ` ${truncateDisplayText(target, 48)}` : '';
    const reason = normalizeReason(input.reason);
    const why = reason ? ` — ${truncateDisplayText(reason, 40)}` : '';
    return `wait_for ${kind}${detail}${why}`;
  }
}

type ParsedWaitInput =
  | {
      ok: true;
      mode: 'create';
      condition: NormalizedWaitCondition;
      timeoutMs: number;
      pollIntervalMs: number;
      reason?: string;
    }
  | { ok: true; mode: 'resume'; record: WaitRecord; timeoutMs: number; pollIntervalMs?: number; reason?: string }
  | { ok: false; message: string };

const MAX_REASON_CHARS = 200;

/** `reason` 只用于展示，所以这里只做去空白与长度裁剪。 */
function normalizeReason(value: unknown): string | undefined {
  const text = readString(value);
  if (!text) return undefined;
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizePollInterval(value: unknown, kind: WaitKind): number {
  const fallback = DEFAULT_POLL_INTERVAL_MS[kind];
  const parsed = readNumber(value);
  if (parsed === undefined) return fallback;
  return clamp(parsed, MIN_POLL_INTERVAL_MS, 60_000);
}

function normalizeCondition(
  kind: WaitKind,
  input: ToolInput,
): { ok: true; condition: NormalizedWaitCondition } | { ok: false; message: string } {
  const until = readString(input.until)?.toLowerCase();
  const pattern = readString(input.pattern);

  if (kind === 'task') {
    const taskId = readString(input.task_id);
    if (!taskId) return { ok: false, message: 'kind=task 需要提供 task_id' };
    return { ok: true, condition: { kind: 'task', taskId, until: 'finished' } };
  }

  if (kind === 'process') {
    const pid = readNumber(input.pid);
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
      return { ok: false, message: 'kind=process 需要提供正整数 pid' };
    }
    return { ok: true, condition: { kind: 'process', pid, until: 'exited' } };
  }

  if (kind === 'duration') {
    const seconds = readNumber(input.seconds);
    if (seconds === undefined || seconds < 0) return { ok: false, message: 'kind=duration 需要提供非负的 seconds' };
    return { ok: true, condition: { kind: 'duration', seconds: clamp(seconds, 0, 86_400) } };
  }

  if (kind === 'port') {
    const port = readNumber(input.port);
    if (port === undefined || !Number.isInteger(port) || port <= 0 || port > 65_535) {
      return { ok: false, message: 'kind=port 需要提供 1-65535 的 port' };
    }
    return { ok: true, condition: { kind: 'port', host: readString(input.host) ?? '127.0.0.1', port, until: 'open' } };
  }

  if (kind === 'file') {
    const filePath = readString(input.file_path);
    if (!filePath) return { ok: false, message: 'kind=file 需要提供 file_path' };
    const resolvedUntil = (until ?? 'exists') as Extract<NormalizedWaitCondition, { kind: 'file' }>['until'];
    if (!FILE_UNTILS.includes(resolvedUntil)) {
      return { ok: false, message: `kind=file 的 until 只能是 ${FILE_UNTILS.join('|')}` };
    }
    if (resolvedUntil === 'matches' && !pattern)
      return { ok: false, message: 'kind=file 且 until=matches 需要提供 pattern' };
    return { ok: true, condition: { kind: 'file', filePath, until: resolvedUntil, pattern } };
  }

  if (kind === 'command') {
    const command = readString(input.command);
    if (!command) return { ok: false, message: 'kind=command 需要提供 command' };
    const resolvedUntil = (until ?? 'exit_zero') as Extract<NormalizedWaitCondition, { kind: 'command' }>['until'];
    if (!COMMAND_UNTILS.includes(resolvedUntil)) {
      return { ok: false, message: `kind=command 的 until 只能是 ${COMMAND_UNTILS.join('|')}` };
    }
    if (resolvedUntil === 'stdout_matches' && !pattern) {
      return { ok: false, message: 'kind=command 且 until=stdout_matches 需要提供 pattern' };
    }
    const expectedExitCode = readNumber(input.expected_exit_code);
    if (resolvedUntil === 'expected_exit_code' && expectedExitCode === undefined) {
      return { ok: false, message: 'kind=command 且 until=expected_exit_code 需要提供 expected_exit_code' };
    }
    const cwd = readString(input.cwd);
    return {
      ok: true,
      condition: {
        kind: 'command',
        command,
        ...(cwd ? { cwd } : {}),
        until: resolvedUntil,
        ...(expectedExitCode !== undefined ? { expectedExitCode } : {}),
        pattern,
      },
    };
  }

  const url = readString(input.url);
  if (!url) return { ok: false, message: 'kind=http 需要提供 url' };
  const resolvedUntil = (until ?? 'reachable') as Extract<NormalizedWaitCondition, { kind: 'http' }>['until'];
  if (!HTTP_UNTILS.includes(resolvedUntil)) {
    return { ok: false, message: `kind=http 的 until 只能是 ${HTTP_UNTILS.join('|')}` };
  }
  if (resolvedUntil === 'body_matches' && !pattern) {
    return { ok: false, message: 'kind=http 且 until=body_matches 需要提供 pattern' };
  }
  const expectStatus = readNumber(input.expect_status);
  const headers = normalizeHeaders(input.headers);
  if (!headers.ok) return { ok: false, message: headers.message };
  const body = readString(input.body);
  return {
    ok: true,
    condition: {
      kind: 'http',
      url,
      method: (readString(input.method) ?? 'GET').toUpperCase(),
      until: resolvedUntil,
      ...(expectStatus !== undefined ? { expectStatus } : {}),
      ...(headers.value ? { headers: headers.value } : {}),
      ...(body ? { body } : {}),
      pattern,
    },
  };
}

function normalizeHeaders(
  value: unknown,
): { ok: true; value?: Record<string, string> } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'headers 应为 object' };
  }
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      return { ok: false, message: `headers.${key} 应为字符串` };
    }
    headers[key] = String(raw);
  }
  return { ok: true, value: Object.keys(headers).length > 0 ? headers : undefined };
}

const FILE_UNTILS = ['exists', 'missing', 'changed', 'matches'];
const COMMAND_UNTILS = ['exit_zero', 'exit_nonzero', 'expected_exit_code', 'stdout_matches', 'stdout_changed'];
const HTTP_UNTILS = ['reachable', 'status', 'body_matches', 'body_changed'];

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(ms, 1),
    );
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function formatElapsed(ms: number): string {
  const total = Math.max(ms, 0);
  if (total < 1000) return `${total}ms`;
  if (total < 60_000) return `${(total / 1000).toFixed(1)}s`;
  const minutes = Math.floor(total / 60_000);
  return `${minutes}m${Math.round((total % 60_000) / 1000)}s`;
}

function formatResult(record: WaitRecord, options: { hint?: string; settledByEarlierCall?: boolean } = {}): string {
  const lines = [
    `wait_id: ${record.id}`,
    `kind: ${record.kind}`,
    `condition: ${record.label}`,
    ...(record.reason ? [`reason: ${record.reason}`] : []),
    `status: ${record.status}`,
    `elapsed: ${formatElapsed(Date.now() - record.createdAt)} · polls: ${record.polls}`,
  ];
  if (record.detail) lines.push(`detail: ${record.detail}`);
  if (record.error) lines.push(`last error: ${record.error}`);
  if (options.settledByEarlierCall) {
    lines.push(`hint: 这条等待在此前的调用里已经结束（status=${record.status}），同一条记录不会重复等待。`);
  }
  if (options.hint) lines.push(`hint: ${options.hint}`);
  return lines.join('\n');
}

