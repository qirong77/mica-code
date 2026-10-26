import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
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
      return probeProcess(condition, baseline);
    case 'file':
      // 只读探测，不做 owned_paths 租约校验：租约约束的是「能写、能执行」，
      // 而 read_file / grep_search 对读本身不设限，这里加限制只会让
      // 「等 /tmp 产物出现」在 subagent 里莫名其妙失败。
      return probeFile(condition, baseline);
    case 'command': {
      const access = assertCommandCwd(condition.cwd);
      // cwd 不存在/不是目录：换多少个轮询周期也都是这个结果。
      if (!access.ok) return { satisfied: false, error: access.message, fatal: true };
      try {
        assertShellPathAccess(condition.cwd ?? process.cwd(), pathContext);
      } catch (error) {
        return { satisfied: false, error: error instanceof Error ? error.message : String(error), fatal: true };
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
  } catch {
    // `assertSafeTaskId` 在这里拒掉的是「这个 id 永远不可能是后台任务」，
    // 与未知 id 同属参数错误，同样必须立刻失败。
    return { satisfied: false, error: unknownTaskMessage(condition.taskId), fatal: true };
  }
  // 未知 id 是参数错误而非「还没好」：多轮询一万次也不会注册出来，必须
  // 立刻失败，否则模型会以为只是在等一个慢任务而白白耗到超时。
  if (!meta) return { satisfied: false, error: unknownTaskMessage(condition.taskId), fatal: true };

  const running = meta.status === 'starting' || meta.status === 'running';
  const detail = `task ${meta.id}: ${meta.status}${
    running ? '' : ` exit_code=${meta.exit_code ?? 'null'} signal=${meta.signal ?? 'null'}`
  }`;
  if (running) return { satisfied: false, detail };

  const tail = readTaskTail(meta);
  return { satisfied: true, detail: tail ? `${detail}\n输出尾部：\n${tail}` : detail };
}

/**
 * `wait_for(kind=task)` 只认 `background_tasks_start` 启动的 shell 任务。
 * 模型很容易把 subagent 的 `agent-task-*` 传进来（「等三个实现子任务完成」
 * 读起来就是在等 task），所以这里点名它、并给出真正能等它的入口——
 * 只说「未知 task_id」模型只会换个写法再猜一次。
 */
function unknownTaskMessage(taskId: string): string {
  if (taskId.startsWith('agent-task-')) {
    return [
      `${taskId} 是 subagent 任务，wait_for 只能等 background_tasks_start 启动的 shell 任务。`,
      `等子代理改用 agent({ operation: "await", task_ids: ["${taskId}"] })（只看结果用 "read"，需要合并改动时用 "join"）。`,
    ].join('');
  }
  return `未知 task_id: ${taskId}。它必须是 background_tasks_start 返回的那个 id，不确定时先用 background_tasks_list 查。`;
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

function probeProcess(
  condition: Extract<NormalizedWaitCondition, { kind: 'process' }>,
  baseline: WaitBaseline,
): WaitProbeResult {
  const alive = isProcessAlive(condition.pid);
  if (alive) {
    baseline.processSeenAlive = true;
    return { satisfied: false, detail: `pid ${condition.pid}: 仍在运行` };
  }
  // 从未见它活过：pid 写错和「在我开始等之前就退出了」在这里无法区分，
  // 但报成 satisfied 会让模型以为进程刚结束并据此继续下一步。宁可让它
  // 立刻拿到一条说明去核对 pid。
  if (!baseline.processSeenAlive) {
    return {
      satisfied: false,
      error: [
        `pid ${condition.pid} 在第一次探测时就不存在，等不到它退出。`,
        '确认 pid 是否正确（pid 写错时永远等不到）；如果它确实已经结束，直接继续下一步即可。',
        '等 background_tasks_start 启动的任务请改用 kind="task"。',
      ].join(''),
      fatal: true,
    };
  }
  return { satisfied: true, detail: `pid ${condition.pid}: 已退出` };
}

function fileSignature(filePath: string): string {
  try {
    const stat = statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

/**
 * `matches` 只读尾部窗口：要等的日志通常是边跑边增长的，整读会把大文件直接
 * 拒掉，让「等日志里出现某一行」这个最正当的用法永远失败。
 */
function readTextTail(filePath: string): string {
  const stat = statSync(filePath);
  if (stat.size <= MAX_INSPECT_BYTES) return readFileSync(filePath, 'utf-8');
  const fd = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(MAX_INSPECT_BYTES);
    readSync(fd, buffer, 0, MAX_INSPECT_BYTES, stat.size - MAX_INSPECT_BYTES);
    return buffer.toString('utf-8');
  } finally {
    closeSync(fd);
  }
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

  if (!condition.pattern) return { satisfied: false, error: 'until=matches 需要提供 pattern', fatal: true };
  if (!exists) return { satisfied: false, detail: `${target}: 尚不存在` };
  try {
    const result = matchRegex(condition.pattern, readTextTail(target));
    // 非法正则是静态属性，等下去不会变。
    if (!result.ok) return { satisfied: false, error: result.message, fatal: true };
    return {
      satisfied: result.matched,
      detail: `${target}: ${result.matched ? '匹配' : '未匹配'} /${condition.pattern}/`,
    };
  } catch (error) {
    return { satisfied: false, error: error instanceof Error ? error.message : String(error), fatal: true };
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
      // 「单次轮询超时」和「整条等待被中止」都会走到这里，但前者必须报给
      // 模型（它的命令被杀了），后者交给主循环结算 aborted。
      const reason = link.signal.reason;
      const pollTimedOut = (reason as Error | undefined)?.name === 'TimeoutError';
      const aborted = link.signal.aborted && !pollTimedOut;
      finish({
        code,
        signal,
        stdout: stdout.text,
        stderr: stderr.text,
        aborted,
        ...(link.signal.aborted ? { error: (reason as Error | undefined)?.message ?? '轮询被中止' } : {}),
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
      if (!condition.pattern) {
        return { satisfied: false, error: 'until=stdout_matches 需要提供 pattern', fatal: true };
      }
      const result = matchRegex(condition.pattern, haystack);
      if (!result.ok) return { satisfied: false, error: result.message, fatal: true };
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
      if (!condition.pattern) {
        return { satisfied: false, error: 'until=body_matches 需要提供 pattern', fatal: true };
      }
      const result = matchRegex(condition.pattern, body);
      if (!result.ok) return { satisfied: false, error: result.message, fatal: true };
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
