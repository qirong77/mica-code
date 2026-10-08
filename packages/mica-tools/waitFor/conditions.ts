import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  cleanBackgroundTaskOutput,
  killChildProcess,
  loadBackgroundTask,
  readBackgroundTaskOutput,
  type BackgroundTaskMeta,
} from '../ToolRunShellBackground.js';
import { BoundedTextAccumulator } from '../ToolRunShellOutput.js';
import { assertShellPathAccess } from '../utils/pathOwnership.js';
import type { NormalizedWaitCondition, WaitBaseline, WaitProbeResult } from './types.js';

/** 单次轮询自身的上限：命令/请求挂住时也不能把整条等待卡死。 */
const POLL_TIMEOUT_MS = 10_000;
/** `matches` / `body_matches` 读取文件与响应体的上限，避免把大文件塞进内存。 */
const MAX_INSPECT_BYTES = 2 * 1024 * 1024;
const TASK_OUTPUT_TAIL_BYTES = 2_000;
const COMMAND_OUTPUT_CHARS = 20_000;

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  return '/bin/sh';
}

function firstLine(text: string, max = 60): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function matchRegex(pattern: string, text: string): { ok: true; matched: boolean } | { ok: false; message: string } {
  try {
    return { ok: true, matched: new RegExp(pattern, 's').test(text) };
  } catch (error) {
    return { ok: false, message: `pattern 不是合法正则：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** 等待条件的一句话描述（工具展示文案与 dock 行共用）。 */
export function describeCondition(condition: NormalizedWaitCondition): string {
  switch (condition.kind) {
    case 'task':
      return `task ${condition.taskId} 结束`;
    case 'process':
      return `pid ${condition.pid} 退出`;
    case 'file':
      return condition.until === 'matches'
        ? `${condition.filePath} 匹配 /${condition.pattern ?? ''}/`
        : `${condition.filePath} ${condition.until}`;
    case 'command':
      return condition.until === 'stdout_matches'
        ? `命令输出匹配 /${condition.pattern ?? ''}/：${firstLine(condition.command)}`
        : `命令 ${condition.until}：${firstLine(condition.command)}`;
    case 'http':
      return `${condition.method} ${condition.url} ${condition.until}`;
    case 'port':
      return `${condition.host}:${condition.port} 可连接`;
    case 'duration':
      return `等待 ${condition.seconds}s`;
  }
}

/**
 * 判定一次条件。返回 `satisfied: false` + `error` 表示本次轮询本身失败，
 * 调用方只把它记进 lastError 继续轮询——「等 service 起来」正是连不上才
 * 是常态的场景，不能因此判定条件不成立。
 */
export async function probeCondition(params: {
  condition: NormalizedWaitCondition;
  baseline: WaitBaseline;
  /** 记录创建时间，只有 duration 条件用得到。 */
  startedAt: number;
  signal?: AbortSignal;
  /** 工具调用的 context，用于 subagent 的 owned_paths 租约校验。 */
  pathContext?: unknown;
}): Promise<WaitProbeResult> {
  const { condition, baseline, startedAt, signal, pathContext } = params;
  switch (condition.kind) {
    case 'task':
      return probeTask(condition);
    case 'process':
      return probeProcess(condition);
    case 'file':
      return probeFile(condition, baseline);
    case 'command': {
      const access = assertCommandCwd(condition.cwd);
      if (!access.ok) return { satisfied: false, error: access.message };
      try {
        assertShellPathAccess(condition.cwd ?? process.cwd(), pathContext);
      } catch (error) {
        return { satisfied: false, error: error instanceof Error ? error.message : String(error) };
      }
      return probeCommand(condition, baseline, signal);
    }
    case 'http':
      return probeHttp(condition, baseline, signal);
    case 'port':
      return probePort(condition, signal);
    case 'duration':
      return probeDuration(condition, startedAt);
  }
}

function probeTask(condition: Extract<NormalizedWaitCondition, { kind: 'task' }>): WaitProbeResult {
  let meta: BackgroundTaskMeta | undefined;
  try {
    meta = loadBackgroundTask(condition.taskId);
  } catch (error) {
    return { satisfied: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (!meta) return { satisfied: false, error: `未知后台任务: ${condition.taskId}` };

  const running = meta.status === 'starting' || meta.status === 'running';
  const detail = `task ${meta.id}: ${meta.status}${
    running ? '' : ` exit_code=${meta.exit_code ?? 'null'} signal=${meta.signal ?? 'null'}`
  }`;
  if (running) return { satisfied: false, detail };

  const tail = readTaskTail(meta);
  return { satisfied: true, detail: tail ? `${detail}\n输出尾部：\n${tail}` : detail };
}

function readTaskTail(meta: BackgroundTaskMeta): string {
  try {
    const range = readBackgroundTaskOutput(meta, {
      maxBytes: TASK_OUTPUT_TAIL_BYTES,
      tailBytes: TASK_OUTPUT_TAIL_BYTES,
    });
    return cleanBackgroundTaskOutput(range.content);
  } catch {
    return '';
  }
}

/**
 * 存活判定与 `mica-session` 的 turn lock 回收同源：`process.kill(pid, 0)`
 * 抛 ESRCH 才算死，EPERM 说明进程存在但没有信号权限——仍然算活着。
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function probeProcess(condition: Extract<NormalizedWaitCondition, { kind: 'process' }>): WaitProbeResult {
  const alive = isProcessAlive(condition.pid);
  return {
    satisfied: !alive,
    detail: alive ? `pid ${condition.pid}: 仍在运行` : `pid ${condition.pid}: 已退出`,
  };
}

function fileSignature(filePath: string): string {
  try {
    const stat = statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

function readTextCapped(filePath: string): string {
  const stat = statSync(filePath);
  if (stat.size > MAX_INSPECT_BYTES) {
    throw new Error(`文件过大（${stat.size} 字节），wait_for 只检查前 ${MAX_INSPECT_BYTES} 字节`);
  }
  return readFileSync(filePath, 'utf-8');
}

function probeFile(
  condition: Extract<NormalizedWaitCondition, { kind: 'file' }>,
  baseline: WaitBaseline,
): WaitProbeResult {
  const target = path.resolve(process.cwd(), condition.filePath);
  const exists = existsSync(target);

  if (condition.until === 'exists') {
    return { satisfied: exists, detail: `${target}: ${exists ? '已存在' : '尚不存在'}` };
  }
  if (condition.until === 'missing') {
    return { satisfied: !exists, detail: `${target}: ${exists ? '仍存在' : '已消失'}` };
  }
  if (condition.until === 'changed') {
    if (baseline.signature === undefined) baseline.signature = fileSignature(target);
    const current = fileSignature(target);
    return {
      satisfied: current !== baseline.signature,
      detail: `${target}: ${String(baseline.signature)} -> ${current}`,
    };
  }

  if (!condition.pattern) return { satisfied: false, error: 'until=matches 需要提供 pattern' };
  if (!exists) return { satisfied: false, detail: `${target}: 尚不存在` };
  try {
    const result = matchRegex(condition.pattern, readTextCapped(target));
    if (!result.ok) return { satisfied: false, error: result.message };
    return {
      satisfied: result.matched,
      detail: `${target}: ${result.matched ? '匹配' : '未匹配'} /${condition.pattern}/`,
    };
  } catch (error) {
    return { satisfied: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function assertCommandCwd(cwd: string | undefined): { ok: true } | { ok: false; message: string } {
  if (!cwd?.trim()) return { ok: true };
  const resolved = path.resolve(process.cwd(), cwd);
  try {
    if (!statSync(resolved).isDirectory()) return { ok: false, message: `cwd is not a directory: ${cwd}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `cwd is not accessible: ${cwd} (${message})` };
  }
  return { ok: true };
}

/** 把外部 signal 与单次轮询超时合成一个 signal，dispose 时清理定时器与监听。 */
function linkAbort(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error(`单次轮询超过 ${timeoutMs}ms`);
    error.name = 'TimeoutError';
    controller.abort(error);
  }, timeoutMs);
  timer.unref?.();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

type CommandOutcome = {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  error?: string;
};

async function runCommandOnce(params: {
  command: string;
  cwd?: string;
  signal?: AbortSignal;
}): Promise<CommandOutcome> {
  const cwd = params.cwd?.trim() ? path.resolve(process.cwd(), params.cwd) : process.cwd();
  const stdout = new BoundedTextAccumulator(COMMAND_OUTPUT_CHARS);
  const stderr = new BoundedTextAccumulator(COMMAND_OUTPUT_CHARS);
  const link = linkAbort(params.signal, POLL_TIMEOUT_MS);

  return new Promise<CommandOutcome>((resolve) => {
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const finish = (result: CommandOutcome) => {
      if (settled) return;
      settled = true;
      link.dispose();
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(params.command, {
        cwd,
        shell: defaultShell(),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        aborted: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    link.signal.addEventListener('abort', () => {
      killChildProcess(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => killChildProcess(child, 'SIGKILL'), 5000);
      forceKillTimer.unref?.();
    });

    child.stdout?.on('data', (data: Buffer) => stdout.append(data.toString()));
    child.stderr?.on('data', (data: Buffer) => stderr.append(data.toString()));
    child.on('error', (error) =>
      finish({
        code: null,
        signal: null,
        stdout: stdout.text,
        stderr: stderr.text,
        aborted: false,
        error: error.message,
      }),
    );
    child.on('close', (code, signal) => {
      const aborted = link.signal.aborted;
      finish({
        code,
        signal,
        stdout: stdout.text,
        stderr: stderr.text,
        aborted,
        ...(aborted ? { error: (link.signal.reason as Error | undefined)?.message ?? '轮询被中止' } : {}),
      });
    });
  });
}

async function probeCommand(
  condition: Extract<NormalizedWaitCondition, { kind: 'command' }>,
  baseline: WaitBaseline,
  signal?: AbortSignal,
): Promise<WaitProbeResult> {
  const run = await runCommandOnce({ command: condition.command, cwd: condition.cwd, signal });
  const exit = run.code === null ? 'null' : String(run.code);
  const withPollError = <T extends WaitProbeResult>(result: T): T =>
    run.error && !run.aborted ? { ...result, error: run.error } : result;

  if (condition.until === 'stdout_matches' || condition.until === 'stdout_changed') {
    const haystack = `${run.stdout}${run.stderr ? `\n${run.stderr}` : ''}`;
    if (condition.until === 'stdout_matches') {
      if (!condition.pattern) return { satisfied: false, error: 'until=stdout_matches 需要提供 pattern' };
      const result = matchRegex(condition.pattern, haystack);
      if (!result.ok) return { satisfied: false, error: result.message };
      return withPollError({
        satisfied: result.matched,
        detail: `exit_code=${exit} ${result.matched ? '匹配' : '未匹配'} /${condition.pattern}/`,
      });
    }
    if (baseline.stdout === undefined) baseline.stdout = run.stdout;
    const changed = run.stdout !== baseline.stdout;
    return withPollError({
      satisfied: changed,
      detail: `exit_code=${exit} 输出${changed ? '已变化' : '未变化'}（首次 ${String(baseline.stdout).length} 字节）`,
    });
  }

  if (run.code === null) {
    return { satisfied: false, error: run.error ?? '命令未产生退出码' };
  }
  if (condition.until === 'exit_zero') {
    return { satisfied: run.code === 0, detail: `exit_code=${exit}` };
  }
  if (condition.until === 'exit_nonzero') {
    return { satisfied: run.code !== 0, detail: `exit_code=${exit}` };
  }
  return {
    satisfied: run.code === condition.expectedExitCode,
    detail: `exit_code=${exit}（期望 ${condition.expectedExitCode}）`,
  };
}

async function probeHttp(
  condition: Extract<NormalizedWaitCondition, { kind: 'http' }>,
  baseline: WaitBaseline,
  signal?: AbortSignal,
): Promise<WaitProbeResult> {
  const link = linkAbort(signal, POLL_TIMEOUT_MS);
  try {
    const response = await fetch(condition.url, {
      method: condition.method,
      ...(condition.headers ? { headers: condition.headers } : {}),
      ...(condition.body !== undefined ? { body: condition.body } : {}),
      signal: link.signal,
      redirect: 'follow',
    });
    const status = response.status;

    if (condition.until === 'reachable') {
      return { satisfied: true, detail: `HTTP ${status}` };
    }
    if (condition.until === 'status') {
      const expected = condition.expectStatus ?? 200;
      return { satisfied: status === expected, detail: `HTTP ${status}（期望 ${expected}）` };
    }

    const body = (await response.text()).slice(0, MAX_INSPECT_BYTES);
    if (condition.until === 'body_matches') {
      if (!condition.pattern) return { satisfied: false, error: 'until=body_matches 需要提供 pattern' };
      const result = matchRegex(condition.pattern, body);
      if (!result.ok) return { satisfied: false, error: result.message };
      return {
        satisfied: result.matched,
        detail: `HTTP ${status} ${result.matched ? '匹配' : '未匹配'} /${condition.pattern}/`,
      };
    }
    if (baseline.body === undefined) baseline.body = body;
    const changed = body !== baseline.body;
    return {
      satisfied: changed,
      detail: `HTTP ${status} 响应体${changed ? '已变化' : '未变化'}（首次 ${String(baseline.body).length} 字节）`,
    };
  } catch (error) {
    return { satisfied: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    link.dispose();
  }
}

function probePort(
  condition: Extract<NormalizedWaitCondition, { kind: 'port' }>,
  signal?: AbortSignal,
): Promise<WaitProbeResult> {
  return new Promise<WaitProbeResult>((resolve) => {
    const socket = net.connect({ host: condition.host, port: condition.port });
    let settled = false;
    const link = linkAbort(signal, POLL_TIMEOUT_MS);
    const onAbort = () => {
      const reason = (link.signal.reason as Error | undefined)?.message ?? '轮询被中止';
      finish({ satisfied: false, error: reason });
    };
    const finish = (result: WaitProbeResult) => {
      if (settled) return;
      settled = true;
      link.dispose();
      socket.destroy();
      resolve(result);
    };
    link.signal.addEventListener('abort', onAbort);
    if (link.signal.aborted) onAbort();
    socket.once('connect', () => finish({ satisfied: true, detail: `${condition.host}:${condition.port} 可连接` }));
    socket.once('error', (error) =>
      finish({ satisfied: false, error: `${condition.host}:${condition.port} ${error.message}` }),
    );
  });
}

function probeDuration(
  condition: Extract<NormalizedWaitCondition, { kind: 'duration' }>,
  startedAt: number,
): WaitProbeResult {
  const elapsedMs = Date.now() - startedAt;
  const targetMs = condition.seconds * 1000;
  return {
    satisfied: elapsedMs >= targetMs,
    detail: `已等待 ${(elapsedMs / 1000).toFixed(1)}s / ${condition.seconds}s`,
  };
}
