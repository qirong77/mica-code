import { spawn, type ChildProcess } from 'child_process';
import { appendFileSync, closeSync, openSync, statSync, writeFileSync } from 'fs';
import { mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import crypto from 'crypto';
import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks } from './MicaTool.js';
import { truncateDisplayText } from './utils/display.js';
import { clampNumber, finalizeTextOutput, formatSize } from './utils/outputLimits.js';

const MAX_SHELL_OUTPUT_CHARS = 60_000;
const MAX_STREAM_CHARS = 120_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 120_000;
const MAX_BACKGROUND_OUTPUT_BYTES = 64 * 1024 * 1024;
const BACKGROUND_OUTPUT_WATCH_INTERVAL_MS = 5_000;

type RunShellInput = {
  command: string;
  timeout?: number;
  cwd?: string;
  run_in_background?: boolean;
};

function largeOutputHint(command: string): string | null {
  const trimmed = command.trim();
  if (/\bcat\s+/.test(trimmed)) return '检测到 cat 命令。读取大文件时建议改用 read_file 的 offset/limit。';
  if (/\bls\s+(-[^\n]*R|[^\n]*-[^\n]*R)/.test(trimmed)) return '检测到递归 ls。建议用 list_files 并缩小 pattern/path。';
  if (/\bfind\s+\.?(\s|$)/.test(trimmed) && !/\|\s*(head|grep|rg|sed)\b/.test(trimmed)) {
    return '检测到可能产生大量输出的 find。建议加更具体条件或 pipe 到 head/grep。';
  }
  if (/\b(grep|rg)\b/.test(trimmed) && /\s(-R|--recursive)\b/.test(trimmed) && !/\|\s*head\b/.test(trimmed)) {
    return '检测到递归搜索命令。建议使用 grep_search 工具或限制输出。';
  }
  return null;
}

function taskId(): string {
  return crypto.randomBytes(6).toString('hex');
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  return '/bin/sh';
}

function isInsideOrSame(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveCwd(cwd: string | undefined): { ok: true; cwd: string } | { ok: false; message: string } {
  const root = process.cwd();
  const resolved = cwd?.trim() ? path.resolve(root, cwd) : root;
  if (!isInsideOrSame(root, resolved)) {
    return { ok: false, message: `cwd must stay inside workspace: ${cwd}` };
  }
  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) return { ok: false, message: `cwd is not a directory: ${cwd}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `cwd is not accessible: ${cwd} (${message})` };
  }
  return { ok: true, cwd: resolved };
}

class BoundedTextAccumulator {
  private readonly headBudget: number;
  private readonly tailBudget: number;
  private head = '';
  private tail = '';
  private totalChars = 0;

  constructor(private readonly maxChars: number) {
    this.headBudget = Math.ceil(maxChars * 0.65);
    this.tailBudget = Math.max(0, maxChars - this.headBudget);
  }

  append(chunk: string): void {
    if (!chunk) return;
    this.totalChars += chunk.length;

    if (this.head.length < this.headBudget) {
      const remainingHead = this.headBudget - this.head.length;
      this.head += chunk.slice(0, remainingHead);
      chunk = chunk.slice(remainingHead);
      if (!chunk) return;
    }

    if (this.tailBudget <= 0) return;
    this.tail = (this.tail + chunk).slice(-this.tailBudget);
  }

  get truncated(): boolean {
    return this.totalChars > this.head.length + this.tail.length;
  }

  get text(): string {
    if (!this.truncated) return this.head;
    const omitted = Math.max(0, this.totalChars - this.head.length - this.tail.length);
    return `${this.head}\n\n[命令输出过长，已保留开头和结尾，省略 ${omitted} 字符]\n\n${this.tail}`;
  }
}

function appendStreamChunk({
  chunk,
  callbacks,
  streamState,
}: {
  chunk: string;
  callbacks?: ToolExecuteCallbacks;
  streamState: { totalChars: number; capReached: boolean };
}): void {
  if (streamState.capReached) return;

  const remaining = MAX_STREAM_CHARS - streamState.totalChars;
  if (remaining > 0) callbacks?.onChunk?.(chunk.slice(0, remaining));

  streamState.totalChars += chunk.length;
  if (streamState.totalChars > MAX_STREAM_CHARS) {
    streamState.capReached = true;
    callbacks?.onChunk?.('\n[命令输出过长，后续实时输出已停止展示；最终结果会保留开头和结尾]\n');
  }
}

function killChildProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function buildCommandResult({
  command,
  cwd,
  shell,
  timeout,
  durationMs,
  exitCode,
  signal,
  timedOut,
  aborted,
  streamCapReached,
  stdout,
  stderr,
}: {
  command: string;
  cwd: string;
  shell: string;
  timeout: number;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  streamCapReached: boolean;
  stdout: BoundedTextAccumulator;
  stderr: BoundedTextAccumulator;
}): string {
  const output = [
    '[command]',
    `command: ${JSON.stringify(command)}`,
    `cwd: ${cwd}`,
    `shell: ${shell}`,
    `timeout_ms: ${timeout}`,
    `duration_ms: ${durationMs}`,
    `exit_code: ${exitCode ?? 'null'}`,
    `signal: ${signal ?? 'null'}`,
    `timed_out: ${timedOut}`,
    `aborted: ${aborted}`,
    `stream_output_truncated: ${streamCapReached}`,
    `stdout_truncated: ${stdout.truncated}`,
    `stderr_truncated: ${stderr.truncated}`,
    '',
    '[stdout]',
    stdout.text || '(empty)',
    '',
    '[stderr]',
    stderr.text || '(empty)',
  ].join('\n');

  return finalizeTextOutput(output, { maxChars: MAX_SHELL_OUTPUT_CHARS, label: '命令输出' });
}

function backgroundHeader({
  id,
  command,
  cwd,
  shell,
  pid,
  outputLimit,
}: {
  id: string;
  command: string;
  cwd: string;
  shell: string;
  pid: number | undefined;
  outputLimit: number;
}): string {
  return [
    '[mica background task]',
    `id: ${id}`,
    `pid: ${pid ?? 'unknown'}`,
    `cwd: ${cwd}`,
    `shell: ${shell}`,
    `command: ${JSON.stringify(command)}`,
    `started_at: ${new Date().toISOString()}`,
    `output_limit: ${formatSize(outputLimit)}`,
    '',
  ].join('\n');
}

function startBackgroundOutputWatchdog(child: ChildProcess, outputPath: string): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      const size = statSync(outputPath).size;
      if (size <= MAX_BACKGROUND_OUTPUT_BYTES) return;
      appendFileSync(
        outputPath,
        `\n[mica background task stopped]\nreason: output exceeded ${formatSize(MAX_BACKGROUND_OUTPUT_BYTES)}\n`,
        'utf-8',
      );
      killChildProcess(child, 'SIGTERM');
      setTimeout(() => killChildProcess(child, 'SIGKILL'), 5_000).unref?.();
      clearInterval(timer);
    } catch {
      clearInterval(timer);
    }
  }, BACKGROUND_OUTPUT_WATCH_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

function waitForBackgroundSpawn(child: ChildProcess): Promise<{ ok: true } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: true } | { ok: false; message: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: true }), 50);
    timer.unref?.();
    child.once('spawn', () => finish({ ok: true }));
    child.once('error', (error) => finish({ ok: false, message: error.message }));
  });
}

export class ToolRunShell extends MicaTool {
  constructor() {
    super('run_shell', '执行 shell 命令并返回输出。', {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        timeout: { type: 'number', description: '超时毫秒，默认 30000，有效范围 250-120000' },
        cwd: {
          type: 'string',
          description: '命令工作目录。默认当前 workspace 根目录；相对路径会基于当前 workspace 解析。',
        },
        run_in_background: {
          type: 'boolean',
          description:
            '设为 true 在后台运行命令，不等待结果。适用于 dev server、watch 模式等长时间运行的命令。输出写入临时文件，后续用 read_file 查看。',
        },
      },
      required: ['command'],
    });
  }

  async execute(input: RunShellInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    if (input.run_in_background) {
      return this.executeBackground(input);
    }
    return this.executeForeground(input, callbacks);
  }

  private async executeForeground(input: RunShellInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const cwdResult = resolveCwd(input.cwd);
    if (!cwdResult.ok) return `工具 run_shell 输入校验失败：${cwdResult.message}`;

    const timeout = clampNumber(input.timeout, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const shell = defaultShell();
    const startTime = Date.now();

    return new Promise((resolve) => {
      const stdout = new BoundedTextAccumulator(MAX_STREAM_CHARS);
      const stderr = new BoundedTextAccumulator(MAX_STREAM_CHARS);
      const streamState = { totalChars: 0, capReached: false };
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const child = spawn(input.command, {
        cwd: cwdResult.cwd,
        shell,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const abortHandler = () => {
        aborted = true;
        killChildProcess(child, 'SIGTERM');
        forceKillTimer = setTimeout(() => {
          killChildProcess(child, 'SIGKILL');
        }, 5000);
      };

      callbacks?.signal?.addEventListener('abort', abortHandler, { once: true });

      const timer = setTimeout(() => {
        timedOut = true;
        callbacks?.onChunk?.(`\n[命令超时（${timeout}ms），正在终止进程]\n`);
        killChildProcess(child, 'SIGTERM');
        forceKillTimer = setTimeout(() => {
          killChildProcess(child, 'SIGKILL');
        }, 5000);
      }, timeout);

      const hint = largeOutputHint(input.command);
      if (hint) callbacks?.onChunk?.(`[提示] ${hint}\n`);

      child.stdout.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout.append(chunk);
        appendStreamChunk({ chunk, callbacks, streamState });
      });

      child.stderr.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr.append(chunk);
        appendStreamChunk({ chunk, callbacks, streamState });
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        callbacks?.signal?.removeEventListener('abort', abortHandler);
        resolve(
          buildCommandResult({
            command: input.command,
            cwd: cwdResult.cwd,
            shell,
            timeout,
            durationMs: Date.now() - startTime,
            exitCode: code,
            signal,
            timedOut,
            aborted,
            streamCapReached: streamState.capReached,
            stdout,
            stderr,
          }),
        );
      });

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        callbacks?.signal?.removeEventListener('abort', abortHandler);
        stderr.append(error.message);
        resolve(
          buildCommandResult({
            command: input.command,
            cwd: cwdResult.cwd,
            shell,
            timeout,
            durationMs: Date.now() - startTime,
            exitCode: null,
            signal: null,
            timedOut,
            aborted,
            streamCapReached: streamState.capReached,
            stdout,
            stderr,
          }),
        );
      });
    });
  }

  private async executeBackground(input: RunShellInput): Promise<string> {
    const cwdResult = resolveCwd(input.cwd);
    if (!cwdResult.ok) return `工具 run_shell 输入校验失败：${cwdResult.message}`;

    const id = taskId();
    const outputDir = path.join(tmpdir(), 'mica-tasks');
    const outputPath = path.join(outputDir, `${id}.out`);
    const shell = defaultShell();

    await mkdir(outputDir, { recursive: true });

    writeFileSync(
      outputPath,
      backgroundHeader({
        id,
        command: input.command,
        cwd: cwdResult.cwd,
        shell,
        pid: undefined,
        outputLimit: MAX_BACKGROUND_OUTPUT_BYTES,
      }),
      'utf-8',
    );
    const fd = openSync(outputPath, 'a');
    let child: ChildProcess;
    try {
      child = spawn(input.command, {
        cwd: cwdResult.cwd,
        shell,
        detached: true,
        stdio: ['ignore', fd, fd],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendFileSync(outputPath, `\n[mica background task error]\nmessage: ${message}\n`, 'utf-8');
      return [`命令后台启动失败 (id: ${id})`, `cwd: ${cwdResult.cwd}`, `错误: ${message}`].join('\n');
    } finally {
      closeSync(fd);
    }

    appendFileSync(outputPath, `[mica background task spawned]\npid: ${child.pid ?? 'unknown'}\n\n`, 'utf-8');

    child.on('error', (error) => {
      appendFileSync(outputPath, `\n[mica background task error]\nmessage: ${error.message}\n`, 'utf-8');
    });

    const watchdog = startBackgroundOutputWatchdog(child, outputPath);
    child.on('exit', (code, signal) => {
      clearInterval(watchdog);
      appendFileSync(
        outputPath,
        [
          '',
          '[mica background task exited]',
          `finished_at: ${new Date().toISOString()}`,
          `exit_code: ${code ?? 'null'}`,
          `signal: ${signal ?? 'null'}`,
          '',
        ].join('\n'),
        'utf-8',
      );
    });

    const spawnResult = await waitForBackgroundSpawn(child);
    if (!spawnResult.ok) {
      clearInterval(watchdog);
      return [`命令后台启动失败 (id: ${id})`, `cwd: ${cwdResult.cwd}`, `错误: ${spawnResult.message}`].join('\n');
    }

    child.unref();

    return [
      `命令已在后台启动 (id: ${id})`,
      `pid: ${child.pid ?? 'unknown'}`,
      `cwd: ${cwdResult.cwd}`,
      `输出文件: ${outputPath}`,
      `输出上限: ${formatSize(MAX_BACKGROUND_OUTPUT_BYTES)}，超过后会自动终止进程。`,
      `如需查看结果，用 read_file 读取输出文件。命令完成后再读一次获取最终输出。`,
    ].join('\n');
  }

  onToolUseDisplayText(input: Record<string, unknown>): string {
    const cmd = (input.command ?? '') as string;
    // "$ " prefix + " [后台]" suffix 大约占 10 个额外字符
    const truncated = truncateDisplayText(cmd.trim(), 10);
    if (input.run_in_background) {
      return `$ ${truncated} [后台]`;
    }
    return `$ ${truncated}`;
  }
}
