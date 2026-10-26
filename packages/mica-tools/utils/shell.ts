import { statSync } from 'fs';
import path from 'path';

/** `run_shell` 的严格超时（前台命令不该无限等）；超时提示要引用同一个上限。 */
export const RUN_SHELL_TIMEOUT_MS = { default: 30_000, min: 250, max: 120_000 } as const;

/** 前台与后台 shell 共用同一个 shell 解析，避免两处各写一份平台判断。 */
export function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe';
  return '/bin/sh';
}

export function resolveCwd(cwd: string | undefined): { ok: true; cwd: string } | { ok: false; message: string } {
  const resolved = cwd?.trim() ? path.resolve(process.cwd(), cwd) : process.cwd();
  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) return { ok: false, message: `cwd is not a directory: ${cwd}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `cwd is not accessible: ${cwd} (${message})` };
  }
  return { ok: true, cwd: resolved };
}

/** 后台任务按 agent 归属过滤；只有 subagent 上下文里才有 `taskOwnerId`。 */
export function readAgentTaskOwnerId(context: unknown): string | undefined {
  if (!context || typeof context !== 'object' || !('agent' in context)) return undefined;
  const agent = (context as { agent?: unknown }).agent;
  if (!agent || typeof agent !== 'object' || !('taskOwnerId' in agent)) return undefined;
  const ownerId = (agent as { taskOwnerId?: unknown }).taskOwnerId;
  return typeof ownerId === 'string' && ownerId.trim() ? ownerId : undefined;
}
