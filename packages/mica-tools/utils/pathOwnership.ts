import { isAbsolute, relative, resolve, sep } from 'node:path';

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
  if (ownership.writeMode === 'none' || ownership.writeMode === 'proposal') {
    // Read-only / proposal subagents may still inspect code, but keep cwd inside owned paths when provided.
  }
  const processCwd = ownership.cwd ?? process.cwd();
  const target = cwd?.trim() ? resolve(processCwd, cwd) : processCwd;
  if (ownership.ownedPaths.some((owned) => pathIsWithin(target, resolve(processCwd, owned)))) return;
  throw new Error(
    `run_shell cwd is outside subagent owned_paths: ${cwd ?? '.'}. Allowed: ${ownership.ownedPaths
      .map((item) => formatOwnedPath(processCwd, item))
      .join(', ')}`,
  );
}

export function pathIsWithin(target: string, root: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

function formatOwnedPath(cwd: string, path: string): string {
  const absolute = resolve(cwd, path);
  if (isAbsolute(path)) return absolute;
  const rel = relative(cwd, absolute);
  return rel || '.';
}
