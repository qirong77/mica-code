import { execFileSync } from 'node:child_process';

export type GitCommandOptions = {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
};

export function gitBuffer(args: string[], options: GitCommandOptions = {}): Buffer {
  return execFileSync('git', args, {
    cwd: options.cwd,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  }) as Buffer;
}

export function gitText(args: string[], options: GitCommandOptions = {}): string {
  return gitBuffer(args, options).toString('utf-8');
}

export function safeGitText(args: string[], options: GitCommandOptions = {}): string {
  try {
    return gitText(args, options);
  } catch {
    return '';
  }
}

export function formatExecError(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const err = error as {
    message?: string;
    stdout?: Buffer | string;
    stderr?: Buffer | string;
  };
  const stderr = bufferToString(err.stderr).trim();
  const stdout = bufferToString(err.stdout).trim();
  return stderr || stdout || err.message || String(error);
}

function bufferToString(value: Buffer | string | undefined): string {
  if (!value) return '';
  return Buffer.isBuffer(value) ? value.toString('utf-8') : value;
}
