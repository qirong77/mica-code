import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type RunPluginActionInput = {
  id: string;
  action: string;
  values?: Record<string, string>;
};

export type RunPluginActionResult = {
  message: string;
  link?: string;
};

export type RunPluginActionOptions = {
  cliPath?: string;
  timeoutMs?: number;
};

/**
 * 配置页的插件动作由一次性插件进程执行：插件代码只在 CLI 里能跑（配置页宿主没有插件运行时），
 * 而注册这类动作不需要会话。`mica plugin-action` 就是那个入口。
 */
export function resolveMicaCli(): string {
  const fromEnv = process.env.MICA_CLI_PATH?.trim();
  if (fromEnv) return fromEnv;
  const installed = join(homedir(), '.local', 'bin', 'mica');
  if (existsSync(installed)) return installed;
  return 'mica';
}

export function runPluginAction(
  input: RunPluginActionInput,
  options: RunPluginActionOptions = {},
): Promise<RunPluginActionResult> {
  const cliPath = options.cliPath ?? resolveMicaCli();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const args = ['plugin-action', '--plugin', input.id, '--action', input.action];
  if (input.values && Object.keys(input.values).length > 0) {
    args.push('--values', JSON.stringify(input.values));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`插件动作超时（${Math.round(timeoutMs / 1000)} 秒没有返回）`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`跑不起来插件动作：${error.message}（${cliPath}）`));
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const parsed = readLastJsonLine(stdout);
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        if (record.ok === true && typeof record.message === 'string') {
          resolve({ message: record.message, link: typeof record.link === 'string' ? record.link : undefined });
          return;
        }
        if (typeof record.error === 'string') {
          reject(new Error(record.error));
          return;
        }
      }
      reject(new Error(tailOf(stderr) || tailOf(stdout) || '插件动作没有返回结果'));
    });
  });
}

function readLastJsonLine(text: string): unknown {
  const lines = text.trim().split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line || line[0] !== '{') continue;
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

function tailOf(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const lines = trimmed.split('\n').filter(Boolean);
  return lines.slice(-3).join('\n');
}
