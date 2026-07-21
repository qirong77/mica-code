import { execFile } from 'node:child_process';
import { opendir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import type { TerminalFileMentionItem } from '@packages/mica-ui/index.js';

const IGNORED_DIRECTORIES = new Set(['.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules', 'out']);
const MAX_FILES = 50_000;
const MAX_RESULTS = 100;
const CACHE_TTL_MS = 3_000;
const MAX_CACHED_ROOTS = 4;
const execFileAsync = promisify(execFile);

type CacheEntry = { expiresAt: number; files: Promise<string[]> };
type RankedFile = { path: string; labelHighlights: number[] };
const cache = new Map<string, CacheEntry>();

export default function setup(ctx: PluginContext): void {
  const disposable = ctx.ui?.input?.registerFileMentionProvider((query) => findFileMentions(process.cwd(), query));
  if (disposable) ctx.onDispose(() => disposable.dispose());
}

export async function findFileMentions(root: string, query: string): Promise<TerminalFileMentionItem[]> {
  const files = await getWorkspaceFiles(root);
  const needle = normalizePathQuery(query);
  return matchWorkspaceFiles(files, needle)
    .slice(0, MAX_RESULTS)
    .map(({ path, labelHighlights }) => ({ path, label: path, labelHighlights }));
}

function matchWorkspaceFiles(files: string[], query: string): RankedFile[] {
  if (!query) {
    return files.toSorted(comparePaths).map((path) => ({ path, labelHighlights: [] }));
  }

  if (query.includes('/')) {
    const directoryQuery = query.replace(/\/+$/u, '');
    const directoryPrefix = `${directoryQuery}/`;
    const exactDirectoryFiles = files.filter((path) => path.toLocaleLowerCase().startsWith(directoryPrefix));
    if (exactDirectoryFiles.length > 0) {
      return exactDirectoryFiles.toSorted(comparePaths).map((path) => ({
        path,
        labelHighlights: Array.from({ length: directoryQuery.length }, (_, index) => index),
      }));
    }

    const separatorIndex = query.lastIndexOf('/');
    const parentDirectory = query.slice(0, separatorIndex).replace(/\/+$/u, '');
    const nameQuery = query.slice(separatorIndex + 1);
    if (!parentDirectory || !nameQuery) return [];
    const parentPrefix = `${parentDirectory}/`;
    const scopedFiles = files.filter((path) => path.toLocaleLowerCase().startsWith(parentPrefix));
    return rankFiles(scopedFiles, nameQuery);
  }

  return rankFiles(files, query);
}

function rankFiles(files: string[], query: string): RankedFile[] {
  return files
    .map((path) => ({ path, score: scoreFileMatch(path, query) }))
    .filter((match): match is { path: string; score: number } => match.score !== null)
    .sort((left, right) => left.score - right.score || comparePaths(left.path, right.path))
    .map(({ path }) => ({ path, labelHighlights: fileHighlightIndices(path, query) }));
}

function fileHighlightIndices(path: string, query: string): number[] {
  const lowerPath = path.toLocaleLowerCase();
  const name = lowerPath.split('/').at(-1) ?? lowerPath;
  const nameMatch = fuzzyMatch(name, query);
  if (nameMatch) {
    const nameOffset = path.length - name.length;
    return nameMatch.indices.map((index) => nameOffset + index);
  }
  return fuzzyMatch(lowerPath, query)?.indices ?? [];
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
      ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
    );
    return stdout.split('\0').filter(Boolean).slice(0, MAX_FILES);
  } catch {
    return null;
  }
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

type FuzzyMatch = { score: number; indices: number[] };

function fuzzyMatch(value: string, query: string): FuzzyMatch | null {
  if (!query) return { score: 0, indices: [] };
  const contiguousIndex = value.indexOf(query);
  if (contiguousIndex >= 0) {
    return {
      score: value === query ? -300 : contiguousIndex === 0 ? -200 + value.length / 1_000 : -100 + contiguousIndex,
      indices: Array.from({ length: query.length }, (_, index) => contiguousIndex + index),
    };
  }

  let queryIndex = 0;
  const indices: number[] = [];
  for (let valueIndex = 0; valueIndex < value.length && queryIndex < query.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) continue;
    indices.push(valueIndex);
    queryIndex += 1;
  }
  if (queryIndex !== query.length) return null;

  const first = indices[0] ?? 0;
  const last = indices.at(-1) ?? first;
  let gaps = 0;
  let boundaryBonus = 0;
  let consecutivePairs = 0;
  for (let index = 0; index < indices.length; index += 1) {
    if (index > 0) {
      const gap = indices[index]! - indices[index - 1]! - 1;
      gaps += gap;
      if (gap === 0) consecutivePairs += 1;
    }
    const position = indices[index]!;
    if (position === 0 || /[\s._/\\-]/.test(value[position - 1] ?? '')) boundaryBonus += 2;
  }

  return {
    score: first * 3 + gaps * 2 + (last - first) - boundaryBonus - consecutivePairs * 2,
    indices,
  };
}

function scoreFileMatch(path: string, query: string): number | null {
  const lowerPath = path.toLocaleLowerCase();
  const name = lowerPath.split('/').at(-1) ?? lowerPath;
  const nameMatch = fuzzyMatch(name, query);
  if (nameMatch) return nameMatch.score;

  const pathMatch = fuzzyMatch(lowerPath, query);
  return pathMatch ? 10_000 + pathMatch.score : null;
}

function comparePaths(left: string, right: string): number {
  return left.length - right.length || left.localeCompare(right);
}
