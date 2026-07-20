import { opendir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { TerminalFileMentionItem } from '@packages/mica-ui/index.js';

const IGNORED_DIRECTORIES = new Set(['.git', '.next', '.turbo', 'build', 'coverage', 'dist', 'node_modules', 'out']);
const MAX_FILES = 50_000;
const MAX_RESULTS = 100;
const CACHE_TTL_MS = 3_000;
const MAX_CACHED_ROOTS = 4;

type CacheEntry = { expiresAt: number; files: Promise<string[]> };
const cache = new Map<string, CacheEntry>();

export async function findFileMentions(root: string, query: string): Promise<TerminalFileMentionItem[]> {
  const files = await getWorkspaceFiles(root);
  const needle = query.trim().toLocaleLowerCase();
  const matches = needle
    ? files
        .filter((path) => fuzzyMatch(path.toLocaleLowerCase(), needle))
        .sort((left, right) => compareMatches(left, right, needle))
        .slice(0, MAX_RESULTS)
    : files.slice(0, MAX_RESULTS);
  return matches.map((path) => {
    const parts = path.split('/');
    return {
      path,
      label: parts.at(-1) ?? path,
      description: parts.length > 1 ? parts.slice(0, -1).join('/') : '',
    };
  });
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

  const files = walkWorkspaceFiles(root)
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

    try {
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
    } finally {
      await directory.close().catch(() => {});
    }
  }

  return files;
}

function fuzzyMatch(value: string, query: string): boolean {
  if (!query || value.includes(query)) return true;
  let queryIndex = 0;
  for (const character of value) {
    if (character === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return false;
}

function compareMatches(left: string, right: string, query: string): number {
  const leftLower = left.toLocaleLowerCase();
  const rightLower = right.toLocaleLowerCase();
  const leftScore = matchScore(leftLower, query);
  const rightScore = matchScore(rightLower, query);
  return leftScore - rightScore || left.length - right.length || left.localeCompare(right);
}

function matchScore(path: string, query: string): number {
  if (!query) return 4;
  const name = path.split('/').at(-1) ?? path;
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (path.startsWith(query)) return 3;
  return 4;
}
