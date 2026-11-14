import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export type PathOwnershipContext = {
  ownedPaths?: string[];
  cwd?: string;
  writeMode?: 'none' | 'owned_paths' | 'proposal' | 'unrestricted';
};

export function getPathOwnershipContext(context: unknown): PathOwnershipContext | null {
  if (!context || typeof context !== 'object') return null;
  const record = context as Record<string, unknown>;
  const ownedPaths = Array.isArray(record.ownedPaths)
    ? record.ownedPaths.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : undefined;
  const cwd = typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd : undefined;
  const writeMode =
    record.writeMode === 'none' ||
    record.writeMode === 'owned_paths' ||
    record.writeMode === 'proposal' ||
    record.writeMode === 'unrestricted'
      ? record.writeMode
      : undefined;
  if (!ownedPaths && !cwd && !writeMode) return null;
  return { ownedPaths, cwd, writeMode };
}

export function assertWritablePath(path: string, context: unknown): void {
  const ownership = getPathOwnershipContext(context);
  if (!ownership) return;
  if (ownership.writeMode === 'none' || ownership.writeMode === 'proposal') {
    throw new Error(
      ownership.writeMode === 'proposal'
        ? 'This subagent is in proposal mode and cannot write files directly. Return a patch proposal instead.'
        : 'This subagent is read-only and cannot write files.',
    );
  }
  if (!ownership.ownedPaths || ownership.ownedPaths.length === 0) return;
  const cwd = ownership.cwd ?? process.cwd();
  const target = resolve(cwd, path);
  if (ownership.ownedPaths.some((owned) => pathIsWithin(target, resolve(cwd, owned)))) return;
  throw new Error(
    `Path is outside subagent owned_paths: ${path}. Allowed: ${ownership.ownedPaths
      .map((item) => formatOwnedPath(cwd, item))
      .join(', ')}`,
  );
}

export function assertShellPathAccess(cwd: string | undefined, context: unknown): void {
  const ownership = getPathOwnershipContext(context);
  if (!ownership?.ownedPaths || ownership.ownedPaths.length === 0) return;
  const processCwd = ownership.cwd ?? process.cwd();
  const target = cwd?.trim() ? resolve(processCwd, cwd) : processCwd;
  if (
    ownership.ownedPaths.some((owned) => {
      const ownedPath = resolve(processCwd, owned);
      // A file lease has no directory inside it. Commands may instead run from a
      // containing directory, up to the task workspace (or the leased worktree).
      // This does not grant writes to that directory: file tools keep using the
      // exact lease, and shell commands must still respect the write policy.
      return (
        pathIsWithin(target, ownedPath) ||
        (pathIsWithin(ownedPath, target) && pathIsWithin(target, shellScopeRoot(ownedPath, resolve(processCwd))))
      );
    })
  )
    return;
  throw new Error(
    `path is outside subagent owned_paths: ${cwd ?? '.'}. Use a directory containing an owned path within its workspace, or a directory inside an owned path. Owned: ${ownership.ownedPaths
      .map((item) => formatOwnedPath(processCwd, item))
      .join(', ')}`,
  );
}

function shellScopeRoot(ownedPath: string, workspace: string): string {
  if (pathIsWithin(ownedPath, workspace)) return workspace;
  // Leases can point into another checkout. A worktree has a .git file rather
  // than a directory; either bounds its usable ancestors without allowing / or
  // the user's home directory. Standalone paths allow only their direct parent.
  let directory = ownedPath;
  while (true) {
    if (existsSync(join(directory, '.git'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return dirname(ownedPath);
    directory = parent;
  }
}

export function pathIsWithin(target: string, root: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

/**
 * 把 `owned_paths` 归一化成绝对路径并去重。
 *
 * 租约表与写工具校验必须比较同一套绝对路径：直接比较用户给的相对路径，
 * `src/a` 与 `/repo/src/a` 会被当成两段互不重叠的租约。
 */
export function normalizeOwnedPaths(paths: string[], cwd = process.cwd()): string[] {
  const unique = new Set<string>();
  for (const raw of paths) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    unique.add(resolve(cwd, trimmed));
  }
  return [...unique];
}

/**
 * 解析父代理给的 `owned_paths`。值非法是调用方错误，必须报错而不是悄悄当成「没有限制」。
 */
export function parseOwnedPaths(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error('owned_paths must be an array of strings.');
  }
  const paths = value.map((item) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error('owned_paths entries must be non-empty strings.');
    }
    return item.trim();
  });
  return normalizeOwnedPaths(paths);
}

/** 两段租约只要有包含关系就算冲突：并发写同一棵子树同样会互相覆盖。 */
export function findPathConflict(leftPaths: string[], rightPaths: string[]): { left: string; right: string } | null {
  for (const left of leftPaths) {
    for (const right of rightPaths) {
      if (pathIsWithin(left, right) || pathIsWithin(right, left)) {
        return { left, right };
      }
    }
  }
  return null;
}

function formatOwnedPath(cwd: string, path: string): string {
  const absolute = resolve(cwd, path);
  if (isAbsolute(path)) return absolute;
  const rel = relative(cwd, absolute);
  return rel || '.';
}
