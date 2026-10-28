import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * git 执行。
 *
 * 一律显式传 `cwd`：插件的 cwd 是会话的工作目录（`/cd`、resume 到别的项目都会变），
 * 不能指望进程的当前目录一直对得上。读命令失败返回空串（没有 git 仓库、路径刚被删、
 * 分支不存在都是常态），写命令失败才抛错。
 */
export function git(args: string[], cwd: string, timeout = 30_000): string {
  return execFileSyncText(args, cwd, timeout);
}

export async function gitAsync(args: string[], cwd: string, timeout = 30_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

export function safeGit(args: string[], cwd: string, timeout = 30_000): string {
  try {
    return git(args, cwd, timeout);
  } catch {
    return '';
  }
}

export async function safeGitAsync(args: string[], cwd: string, timeout = 30_000): Promise<string> {
  try {
    return await gitAsync(args, cwd, timeout);
  } catch {
    return '';
  }
}

/**
 * 把 message 交给 `git commit -F`：多行 message 走文件比 `-m` 更安全（引号、`#`、
 * 空行都不会被 shell 或 git 的注释清理规则改写）。
 */
export function commitWithMessage(message: string, cwd: string): void {
  const directory = mkdtempSync(join(tmpdir(), 'mica-commit-'));
  const messagePath = join(directory, 'message.txt');
  try {
    writeFileSync(messagePath, `${message.trim()}\n`, 'utf-8');
    git(['commit', '-F', messagePath], cwd, 120_000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * 推送当前分支。
 *
 * 有上游就 `git push`；没有上游但 origin 上有同名分支就补一个 upstream。两样都没有
 * （本地仓库、从没推过的分支）返回 false —— 这不是失败，只是没有远程可推。
 */
export async function pushCurrentBranch(cwd: string): Promise<boolean> {
  const upstream = safeGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd).trim();
  if (upstream) {
    await gitAsync(['push'], cwd, 120_000);
    return true;
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim();
  const remoteBranch = safeGit(['ls-remote', '--heads', 'origin', branch], cwd).trim();
  if (!remoteBranch) return false;
  await gitAsync(['push', 'origin', branch], cwd, 120_000);
  return true;
}

/**
 * 未解决的冲突码（`git status --porcelain=v1` 的前两列）。
 *
 * 有冲突时 `git add -A` 会把冲突标记当成改动提交进去，必须先拒绝。
 */
export function hasUnmergedFiles(status: string): boolean {
  return status
    .split('\n')
    .filter(Boolean)
    .some((line) => ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(line.slice(0, 2)));
}

function execFileSyncText(args: string[], cwd: string, timeout: number): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: MAX_BUFFER,
  });
}
