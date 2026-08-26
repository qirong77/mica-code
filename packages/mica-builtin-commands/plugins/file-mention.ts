import { execFile } from 'node:child_process';
import { opendir } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import type { TerminalFileMentionItem } from '@packages/mica-ui/index.js';

const IGNORED_DIRECTORIES = new Set(['.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules', 'out']);
const MAX_FILES = 50_000;
// Kimi-code's getFuzzyFileSuggestions keeps only the top 20 scored candidates
// for `@` file mention (scored.slice(0, 20)). Keep the truncation aligned so
// `@doc` surfaces the most relevant docs/ + files instead of a wall of
// basename-only-substring matches (file_type_docusaurus.svg etc).
const MAX_RESULTS = 20;
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
type RankedFile = {
  path: string;
  label: string;
  description: string | undefined;
  labelHighlights: number[];
  score: number;
  isDirectory: boolean;
};
const cache = new Map<string, CacheEntry>();

export default function setup(ctx: PluginContext): void {
  // Prewarm the workspace file list so the first `@` (which otherwise cold
  // starts a full `git ls-files` scan ~1.7s on a large repo) hits the cache
  // instead of blocking the user's first keystroke. Fire-and-forget: never
  // block plugin setup or surface an error to the UI.
  void getWorkspaceFiles(process.cwd()).catch(() => {});
  const disposable = ctx.ui?.input?.registerFileMentionProvider((query) => findFileMentions(process.cwd(), query));
  if (disposable) ctx.onDispose(() => disposable.dispose());
}

export async function findFileMentions(root: string, query: string): Promise<TerminalFileMentionItem[]> {
  const needle = normalizePathQuery(query);
  if (needle) {
    const fdPath = await getFdExecutable();
    if (fdPath) {
      try {
        return await findFileMentionsWithFd(root, fdPath, needle);
      } catch {
        // fd failed (e.g. binary race, permission) — fall back to a full
        // workspace scan so `@` still resolves.
      }
    }
  }
  const files = await getWorkspaceFiles(root);
  return matchWorkspaceFiles(files, needle)
    .slice(0, MAX_RESULTS)
    .map(({ path, label, description, labelHighlights }) => ({ path, label, description, labelHighlights }));
}

let detectedFdExecutable: string | null | undefined;

/**
 * Resolve the `fd` (or Debian `fdfind`) executable, cached for the process.
 * `fd` pushes the query down to the filesystem (C implementation) instead of
 * enumerating the whole tree, which is what makes kimi's `@` completion feel
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
): Promise<TerminalFileMentionItem[]> {
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

  const ranked: RankedFile[] = [];
  for (const line of stdout.split('\n')) {
    const display = line.replace(/\\/gu, '/');
    if (!display) continue;
    const isDirectory = display.endsWith('/');
    const clean = isDirectory ? display.slice(0, -1) : display;
    if (!clean || clean === '.git' || clean.startsWith('.git/') || clean.includes('/.git/')) continue;
    if (!isWorkspaceFile(clean)) continue;
    const { score, basenameMatch } = scorePath(clean, query, isDirectory);
    if (score <= 0) continue;
    const name = basename(clean);
    ranked.push({
      path: isDirectory ? `${clean}/` : clean,
      label: isDirectory ? `${name}/` : name,
      description: clean,
      labelHighlights: basenameMatch ? computeLabelHighlights(name, query) : [],
      score,
      isDirectory,
    });
  }
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return comparePaths(a.path, b.path);
  });
  return ranked.slice(0, MAX_RESULTS).map(({ path, label, description, labelHighlights }) => ({
    path,
    label,
    description,
    labelHighlights,
  }));
}

/**
 * Rank every workspace file/directory against `query` using kimi-code's graded
 * substring scoring: exact basename > basename prefix > basename substring >
 * path substring. Higher score = better match, and directories outrank files
 * at equal score (so `@doc` puts the `docs/` entries first). Candidates that do
 * not contain the query anywhere are dropped, so `@doc` only surfaces
 * files/directories whose name or path actually holds "doc" — not unrelated
 * files whose full path merely contains the letters d-o-c out of order.
 * Mirrors kimi-code's `scoreCandidate`; keep the two in sync.
 */
function matchWorkspaceFiles(files: string[], query: string): RankedFile[] {
  if (!query) {
    return files.toSorted(comparePaths).map((path) => ({
      path,
      label: basename(path),
      description: path,
      labelHighlights: [],
      score: 0,
      isDirectory: false,
    }));
  }

  const results: RankedFile[] = [];
  for (const path of files) {
    const { score, basenameMatch } = scorePath(path, query, false);
    if (score <= 0) continue;
    results.push({
      path,
      label: basename(path),
      description: path,
      labelHighlights: basenameMatch ? computeLabelHighlights(basename(path), query) : [],
      score,
      isDirectory: false,
    });
  }
  for (const directory of collectDirectoryPaths(files)) {
    const { score, basenameMatch } = scorePath(directory, query, true);
    if (score <= 0) continue;
    const name = basename(directory);
    results.push({
      path: `${directory}/`,
      label: `${name}/`,
      description: directory,
      labelHighlights: basenameMatch ? computeLabelHighlights(name, query) : [],
      score,
      isDirectory: true,
    });
  }
  results.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
    return comparePaths(left.path, right.path);
  });
  return results;
}

/**
 * Every directory reachable from the workspace files, as relative paths. Used
 * to surface directory completions (e.g. `docs/`) ahead of path-only matches.
 */
function collectDirectoryPaths(files: string[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    let directory = dirname(file);
    while (directory && directory !== '.') {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  return [...directories];
}

/**
 * Mirrors kimi-code's `scoreCandidate`: base name beats path, within the base
 * name an exact match beats a prefix which beats a substring, and directories
 * get a small bonus so workspace folders surface ahead of files.
 */
function scorePath(path: string, query: string, isDirectory: boolean): { score: number; basenameMatch: boolean } {
  const lowerQuery = query.toLowerCase();
  const lowerPath = path.toLowerCase();
  const lowerBase = basename(path).toLowerCase();
  let score = 0;
  let basenameMatch = false;
  if (lowerBase === lowerQuery) {
    score = 100;
    basenameMatch = true;
  } else if (lowerBase.startsWith(lowerQuery)) {
    score = 80;
    basenameMatch = true;
  } else if (lowerBase.includes(lowerQuery)) {
    score = 50;
    basenameMatch = true;
  } else if (lowerPath.includes(lowerQuery)) {
    score = 30;
  }
  if (isDirectory && score > 0) score += 10;
  return { score, basenameMatch };
}

/** Character indexes into `label` for the query substring, or [] when absent. */
function computeLabelHighlights(label: string, query: string): number[] {
  const index = label.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return [];
  return Array.from({ length: query.length }, (_, offset) => index + offset);
}

function normalizePathQuery(query: string): string {
  return query
    .trim()
    .replace(/\\/gu, '/')
    .replace(/^\.\//u, '')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/gu, '/')
    .toLocaleLowerCase();
}

function getWorkspaceFiles(root: string): Promise<string[]> {
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
    return stdout.split('\0').filter(Boolean).filter(isWorkspaceFile).slice(0, MAX_FILES);
  } catch {
    return null;
  }
}

function isWorkspaceFile(path: string): boolean {
  return !path.split('/').some((segment) => IGNORED_DIRECTORIES.has(segment));
}

async function walkWorkspaceFiles(root: string): Promise<string[]> {
  const directories = [root];
  const files: string[] = [];

  while (directories.length > 0 && files.length < MAX_FILES) {
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
        if (!IGNORED_DIRECTORIES.has(entry.name)) directories.push(entryPath);
      } else if (entry.isFile()) {
        files.push(relative(root, entryPath).split(sep).join('/'));
        if (files.length >= MAX_FILES) break;
      }
    }
  }

  return files;
}

function comparePaths(left: string, right: string): number {
  return left.length - right.length || left.localeCompare(right);
}
