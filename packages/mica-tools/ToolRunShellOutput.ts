import type { ToolExecuteCallbacks } from './MicaTool.js';
import { finalizeTextOutput } from './utils/outputLimits.js';

export const MAX_SHELL_OUTPUT_CHARS = 60_000;
export const MAX_STREAM_CHARS = 120_000;

export function largeOutputHint(command: string): string | null {
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

export class BoundedTextAccumulator {
  private readonly headBudget: number;
  private readonly tailBudget: number;
  private head = '';
  private tail = '';
  private totalChars = 0;

  constructor(maxChars: number) {
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

export function appendStreamChunk({
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

export function buildCommandResult({
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
