import { spawn } from 'child_process';
import { MicaTool } from './MicaTool.js';
import type { ToolExecuteCallbacks } from './MicaTool.js';
import { truncateDisplayText } from './utils/display.js';
import { clampNumber } from './utils/outputLimits.js';
import { killChildProcess } from './ToolRunShellBackground.js';
import {
  appendStreamChunk,
  BoundedTextAccumulator,
  buildCommandResult,
  largeOutputHint,
  MAX_STREAM_CHARS,
} from './ToolRunShellOutput.js';
import { assertShellPathAccess } from './utils/pathOwnership.js';
import { defaultShell, resolveCwd, RUN_SHELL_TIMEOUT_MS } from './utils/shell.js';

const { default: DEFAULT_TIMEOUT_MS, min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS } = RUN_SHELL_TIMEOUT_MS;

type RunShellInput = {
  command: string;
  timeout_ms?: number;
  cwd?: string;
};

const DESCRIPTION = [
  '在前台执行 shell 命令并等它结束，返回合并后的输出与退出码。',
  '',
  `用于：构建、单测、typecheck、git、grep 这类通常几十秒内结束的命令。严格超时：默认 ${DEFAULT_TIMEOUT_MS / 1000}s、最长 ${MAX_TIMEOUT_MS / 1000}s（\`timeout_ms\`），到点会终止进程，不会无限等。`,
  '不要用于：dev server、watch 模式，或预计超过 2 分钟的构建/测试——那样只会白跑一趟再被超时杀掉。这类命令用 `background_tasks_start` 启动，再用 `wait_for` / `background_tasks_read` 取结果。',
].join('\n');

export class ToolRunShell extends MicaTool {
  constructor() {
    super('run_shell', DESCRIPTION, {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        timeout_ms: {
          type: 'number',
          description: `超时毫秒，默认 ${DEFAULT_TIMEOUT_MS}，有效范围 ${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}。命令会在这个时间点被终止。`,
        },
        cwd: {
          type: 'string',
          description: '命令工作目录。默认当前进程目录；相对路径会基于当前进程目录解析。',
        },
      },
      required: ['command'],
    });
  }

  async execute(input: RunShellInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    try {
      assertShellPathAccess(input.cwd, callbacks?.context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `工具 run_shell 输入校验失败：${message}`;
    }
    const cwdResult = resolveCwd(input.cwd);
    if (!cwdResult.ok) return `工具 run_shell 输入校验失败：${cwdResult.message}`;

    const timeout = clampNumber(input.timeout_ms, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
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

      // 已经中止的 signal 不会再触发事件：不在这里补一次，命令会一路跑到超时。
      if (callbacks?.signal?.aborted) abortHandler();
      else callbacks?.signal?.addEventListener('abort', abortHandler, { once: true });

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

  onToolUseDisplayText(input: Record<string, unknown>): string {
    const cmd = (input.command ?? '') as string;
    return `$ ${truncateDisplayText(cmd.trim(), 12)}`;
  }
}

