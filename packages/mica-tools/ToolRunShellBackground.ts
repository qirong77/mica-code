import { type ChildProcess } from 'child_process';
import { appendFileSync, statSync } from 'fs';
import crypto from 'crypto';
import { formatSize } from './utils/outputLimits.js';

export const MAX_BACKGROUND_OUTPUT_BYTES = 64 * 1024 * 1024;
const BACKGROUND_OUTPUT_WATCH_INTERVAL_MS = 5_000;

export function taskId(): string {
  return crypto.randomBytes(6).toString('hex');
}

export function backgroundHeader({
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

export function startBackgroundOutputWatchdog(child: ChildProcess, outputPath: string): NodeJS.Timeout {
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

export function waitForBackgroundSpawn(child: ChildProcess): Promise<{ ok: true } | { ok: false; message: string }> {
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

export function killChildProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
