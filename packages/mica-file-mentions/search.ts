/**
 * 工作区文件扫描：`git ls-files`（回退到目录遍历）+ fd 推送查询 + 结果缓存。
 *
 * CLI 的 `@` 补全插件与桌面端 host 都用这一份，所以两端候选与延迟完全一致。
 * 扫描结果只服务内联补全，不参与任何写盘判断，可以放心缓存。
 */
import { execFile } from 'node:child_process';
import { opendir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  IGNORED_DIRECTORIES,
  MAX_FILE_MENTION_RESULTS,
  MAX_WORKSPACE_FILES,
  compareRankedMentions,
  computeLabelHighlights,
  isWorkspaceFile,
  matchWorkspaceFiles,
  normalizePathQuery,
  scorePath,
  type FileMentionItem,
  type RankedFileMention,
} from './rank.js';

// A 3s TTL makes a short pause while typing `@doc` (or a slow keystroke) fall
// outside the cache window and re-trigger a full `git ls-files` scan (1.7s on
// a large repo), which is what users actually feel as "slow". Long enough to
// cover a whole `@`-mention typing burst, short enough that a stale working
// tree does not linger. Snapshot freshness is not critical here: results are
// only used for inline completion suggestions.
const CACHE_TTL_MS = 45_000;
const MAX_CACHED_ROOTS = 4;
const execFileAsync = promisify(execFile);

type CacheEntry = { expiresAt: number; files: Promise<string[]> };
const cache = new Map<string, CacheEntry>();

/** 补全候选：按查询排序后的前 20 条。 */
export async function findFileMentions(root: string, query: string): Promise<FileMentionItem[]> {
  const needle = normalizePathQuery(query);
  if (needle) {
    const fdPath = await getFdExecutable();
    if (fdPath) {
      try {
        return await findFileMentionsWithFd(root, fdPath, query);
      } catch {
        // fd failed (e.g. binary race, permission) — fall back to a full
        // workspace scan so `@` still resolves.
      }
    }
  }
  const files = await getWorkspaceFiles(root);
  return matchWorkspaceFiles(files, needle);
}

/**
 * 预热工作区文件列表：第一次 `@` 否则要冷启动一次完整 `git ls-files`（大仓库约 1.7s），
 * 正好落在用户敲下 `@` 的那一刻。启动/开始一轮对话时调用，失败静默忽略。
 */
export function prewarmFileMentions(root: string): void {
  void getWorkspaceFiles(root).catch(() => {});
}

let detectedFdExecutable: string | null | undefined;

/**
 * Resolve the `fd` (or Debian `fdfind`) executable, cached for the process.
 * `fd` pushes the query down to the filesystem (C implementation) instead of
 * enumerating the whole tree, which is what makes the `@` completion feel
 * instant. We only use it when present; the workspace scan remains the fallback.
 */
async function getFdExecutable(): Promise<string | null> {
  if (detectedFdExecutable !== undefined) return detectedFdExecutable;
  for (const candidate of ['fd', 'fdfind']) {
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 2_000 });
      detectedFdExecutable = candidate;
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  detectedFdExecutable = null;
  return null;
}

async function findFileMentionsWithFd(
  root: string,
  fdPath: string,
  query: string,
): Promise<FileMentionItem[]> {
  // `--full-path` keeps mica's path-level match semantics (e.g. `@node` must
  // surface `src/mynode/helper.ts`), which basename-only fd matching would drop.
  // `--ignore-case` aligns with the case-insensitive scoring below.
  const args = [
    '--base-directory',
    root,
    '--full-path',
    '--max-results',
    '100',
    '--type',
    'f',
    '--type',
    'd',
    '--ignore-case',
    '--hidden',
    '--exclude',
    '.git',
    '--exclude',
    '.git/*',
    '--exclude',
    '.git/**',
    query,
  ];
  const { stdout } = await execFileAsync(fdPath, args, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 10_000,
  });

  const ranked: RankedFileMention[] = [];
  for (const line of stdout.split('\n')) {
    const display = line.replace(/\\/gu, '/');
    if (!display) continue;
    const isDirectory = display.endsWith('/');
    const clean = isDirectory ? display.slice(0, -1) : display;
    if (!clean || clean === '.git' || clean.startsWith('.git/') || clean.includes('/.git/')) continue;
    if (!isWorkspaceFile(clean)) continue;
    const { score, basenameMatch } = scorePath(clean, query, isDirectory);
    if (score <= 0) continue;
    const name = basenameOf(clean);
    ranked.push({
      path: isDirectory ? `${clean}/` : clean,
      label: isDirectory ? `${name}/` : name,
      description: clean,
      labelHighlights: basenameMatch ? computeLabelHighlights(name, query) : [],
      score,
      isDirectory,
    });
  }
  ranked.sort(compareRankedMentions);
  return ranked
    .slice(0, MAX_FILE_MENTION_RESULTS)
    .map(({ path, label, description, labelHighlights }) => ({
      path,
      label,
      description,
      labelHighlights,
    }));
}

async function getWorkspaceFiles(root: string): Promise<string[]> {
  const now = Date.now();
  const cached = cache.get(root);
  if (cached && cached.expiresAt > now) return cached.files;
  if (cached) cache.delete(root);
  while (cache.size >= MAX_CACHED_ROOTS) {
    const oldestRoot = cache.keys().next().value;
    if (oldestRoot === undefined) break;
    cache.delete(oldestRoot);
  }

  const files = listWorkspaceFiles(root)
    .then((result) => {
      const current = cache.get(root);
      if (current?.files === files) current.expiresAt = Date.now() + CACHE_TTL_MS;
      return result;
    })
    .catch((error) => {
      if (cache.get(root)?.files === files) cache.delete(root);
      throw error;
    });
  cache.set(root, { expiresAt: Number.POSITIVE_INFINITY, files });
  return files;
}

async function listWorkspaceFiles(root: string): Promise<string[]> {
  const gitFiles = await listGitWorkspaceFiles(root);
  return gitFiles ?? walkWorkspaceFiles(root);
}

async function listGitWorkspaceFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', root, 'ls-files', '--cached', '--others', '-z', '--', '.'],
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
    );
    return stdout.split('\0').filter(Boolean).filter(isWorkspaceFile).slice(0, MAX_WORKSPACE_FILES);
  } catch {
    return null;
  }
}

async function walkWorkspaceFiles(root: string): Promise<string[]> {
  const directories = [root];
  const files: string[] = [];

  while (directories.length > 0 && files.length < MAX_WORKSPACE_FILES) {
    const directoryPath = directories.pop();
    if (!directoryPath) break;
    let directory;
    try {
      directory = await opendir(directoryPath);
    } catch {
      continue;
    }

    for await (const entry of directory) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        directories.push(entryPath);
      } else if (entry.isFile()) {
        files.push(relative(root, entryPath).split(sep).join('/'));
        if (files.length >= MAX_WORKSPACE_FILES) break;
      }
    }
  }

  return files;
}

function basenameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? path : path.slice(index + 1);
}
