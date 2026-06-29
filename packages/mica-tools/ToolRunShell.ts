import { spawn, type ChildProcess } from 'child_process';
import { appendFileSync, closeSync, openSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks } from './MicaTool.js';
import { truncateDisplayText } from './utils/display.js';
import { clampNumber, formatSize } from './utils/outputLimits.js';
import {
  backgroundHeader,
  createBackgroundTaskMeta,
  getTaskOutputPath,
  killChildProcess,
  markBackgroundTaskExited,
  markBackgroundTaskRunning,
  markBackgroundTaskSpawnFailed,
  MAX_BACKGROUND_OUTPUT_BYTES,
  startBackgroundOutputWatchdog,
  taskId,
  waitForBackgroundSpawn,
} from './ToolRunShellBackground.js';
import {
  appendStreamChunk,
  BoundedTextAccumulator,
  buildCommandResult,
  largeOutputHint,
  MAX_STREAM_CHARS,
} from './ToolRunShellOutput.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 120_000;

type RunShellInput = {
  command: string;
  timeout?: number;
  cwd?: string;
  run_in_background?: boolean;
};

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  return '/bin/sh';
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

function isInsideOrSame(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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
    const outputPath = getTaskOutputPath(id);
    const shell = defaultShell();

    createBackgroundTaskMeta({
      id,
      command: input.command,
      cwd: cwdResult.cwd,
      shell,
      outputPath,
      outputLimit: MAX_BACKGROUND_OUTPUT_BYTES,
    });

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
      markBackgroundTaskSpawnFailed(id, message);
      appendFileSync(outputPath, `\n[mica background task error]\nmessage: ${message}\n`, 'utf-8');
      return [`命令后台启动失败 (id: ${id})`, `cwd: ${cwdResult.cwd}`, `错误: ${message}`].join('\n');
    } finally {
      closeSync(fd);
    }

    markBackgroundTaskRunning(id, child.pid);
    appendFileSync(outputPath, `[mica background task spawned]\npid: ${child.pid ?? 'unknown'}\n\n`, 'utf-8');

    child.on('error', (error) => {
      markBackgroundTaskSpawnFailed(id, error.message);
      appendFileSync(outputPath, `\n[mica background task error]\nmessage: ${error.message}\n`, 'utf-8');
    });

    const watchdog = startBackgroundOutputWatchdog(child, outputPath, id);
    child.on('exit', (code, signal) => {
      clearInterval(watchdog);
      markBackgroundTaskExited(id, code, signal);
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
      markBackgroundTaskSpawnFailed(id, spawnResult.message);
      return [`命令后台启动失败 (id: ${id})`, `cwd: ${cwdResult.cwd}`, `错误: ${spawnResult.message}`].join('\n');
    }

    child.unref();

    return [
      `命令已在后台启动 (id: ${id})`,
      `pid: ${child.pid ?? 'unknown'}`,
      `cwd: ${cwdResult.cwd}`,
      `输出文件: ${outputPath}`,
      `输出上限: ${formatSize(MAX_BACKGROUND_OUTPUT_BYTES)}，超过后会自动终止进程。`,
      `查看输出: read_task_output(task_id="${id}")`,
      `终止任务: kill_task(task_id="${id}")`,
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
