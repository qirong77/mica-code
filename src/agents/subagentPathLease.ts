import { relative, resolve, sep } from 'node:path';

export type PathLease = {
  taskId: string;
  ownerKey: string;
  ownedPaths: string[];
};

export class SubagentPathLeaseManager {
  private readonly leases = new Map<string, PathLease>();

  assertAvailable(options: { ownerKey: string; ownedPaths: string[]; cwd?: string }): void {
    const ownedPaths = normalizeOwnedPaths(options.ownedPaths, options.cwd);
    for (const existing of this.leases.values()) {
      if (existing.ownerKey !== options.ownerKey) continue;
      const conflict = findPathConflict(ownedPaths, existing.ownedPaths);
      if (conflict) {
        throw new Error(
          `owned_paths conflict with running subagent ${existing.taskId}: ${conflict.left} overlaps ${conflict.right}`,
        );
      }
    }
  }

  acquire(options: { taskId: string; ownerKey: string; ownedPaths: string[]; cwd?: string }): void {
    const ownedPaths = normalizeOwnedPaths(options.ownedPaths, options.cwd);
    this.assertAvailable({ ownerKey: options.ownerKey, ownedPaths, cwd: options.cwd });
    this.leases.set(options.taskId, {
      taskId: options.taskId,
      ownerKey: options.ownerKey,
      ownedPaths,
    });
  }

  release(taskId: string): void {
    this.leases.delete(taskId);
  }

  getOwnedPaths(taskId: string): string[] | undefined {
    return this.leases.get(taskId)?.ownedPaths;
  }

  assertWritable(path: string, ownedPaths: string[] | undefined, cwd = process.cwd()): void {
    assertPathWritable(path, ownedPaths, cwd);
  }
}

export function normalizeOwnedPaths(paths: string[], cwd = process.cwd()): string[] {
  const unique = new Set<string>();
  for (const raw of paths) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    unique.add(resolve(cwd, trimmed));
  }
  return [...unique];
}

export function assertPathWritable(path: string, ownedPaths: string[] | undefined, cwd = process.cwd()): void {
  if (!ownedPaths || ownedPaths.length === 0) return;
  const target = resolve(cwd, path);
  if (ownedPaths.some((owned) => pathIsWithin(target, owned))) return;
  throw new Error(
    `Path is outside subagent owned_paths: ${path}. Allowed: ${ownedPaths.map((item) => relativePath(cwd, item)).join(', ')}`,
  );
}

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

export function pathIsWithin(target: string, root: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix);
}

function relativePath(cwd: string, absolutePath: string): string {
  const rel = relative(cwd, absolutePath);
  return rel || '.';
}

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
