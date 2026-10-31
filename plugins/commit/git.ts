import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
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

export async function gitAsync(args: string[], cwd: string, timeout = 30_000, maxBuffer = MAX_BUFFER): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
    timeout,
    maxBuffer,
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

/** Read-only previews retain a bounded prefix even when Git exceeds the output budget. */
export async function gitPreview(args: string[], cwd: string, maxBytes = 32_000): Promise<string> {
  try {
    return await gitAsync(args, cwd, 30_000, maxBytes);
  } catch (error) {
    const failure = error as { code?: string; stdout?: string };
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && typeof failure.stdout === 'string')
      return `${failure.stdout}\n[git output truncated]`;
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
  if (branch === 'HEAD' || !safeGit(['remote', 'get-url', 'origin'], cwd).trim()) return false;
  const remoteBranch = (await gitAsync(['ls-remote', '--heads', 'origin', branch], cwd)).trim();
  if (!remoteBranch) return false;
  await gitAsync(['push', '--set-upstream', 'origin', branch], cwd, 120_000);
  return true;
}

/**
 * 未解决的冲突码（`git status --porcelain=v1` 的前两列）。
 *
 * 有冲突时 `git add -A` 会把冲突标记当成改动提交进去，必须先拒绝。
 */
export function hasUnmergedFiles(status: string): boolean {
  return parsePorcelainStatus(status).some((file) => ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(file.status));
}

/** `-z` 模式保留路径原值；重命名记录紧跟的新旧路径只取新路径。 */
export function parsePorcelainStatus(status: string): Array<{ status: string; path: string }> {
  const records = status.split('\0');
  const files: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) continue;
    const code = record.slice(0, 2);
    files.push({ status: code, path: record.slice(3) });
    if (/[RC]/.test(code)) index += 1;
  }
  return files;
}

/** 模型请求期间文件仍可能被 agent 或用户改写；提交前核对内容与索引，避免提交未分析过的变化。 */
export async function worktreeFingerprint(cwd: string, status: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(status);
  hash.update(safeGit(['rev-parse', '--verify', 'HEAD'], cwd));
  hash.update(safeGit(['symbolic-ref', '-q', 'HEAD'], cwd));
  hash.update(git(['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-renames'], cwd));
  for (const file of parsePorcelainStatus(status)) {
    hash.update(`\0${file.path}\0`);
    const path = join(cwd, file.path);
    try {
      const info = lstatSync(path);
      hash.update(String(info.mode));
      if (info.isSymbolicLink()) hash.update(readlinkSync(path));
      else if (info.isFile()) {
        for await (const chunk of createReadStream(path)) hash.update(chunk);
      } else if (info.isDirectory()) hash.update(safeGit(['-C', path, 'rev-parse', 'HEAD'], cwd));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update('[deleted]');
    }
  }
  return hash.digest('hex');
}

function execFileSyncText(args: string[], cwd: string, timeout: number): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    encoding: 'utf8',
    timeout,
    maxBuffer: MAX_BUFFER,
  });
}
