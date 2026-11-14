import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  assertShellPathAccess,
  assertWritablePath,
  findPathConflict,
  normalizeOwnedPaths,
  parseOwnedPaths,
} from '@packages/mica-tools/index.js';

/**
 * `owned_paths` 是子代理唯一的写入边界，判定错了就是「以为被限制、其实能写」。
 * 这里只测判定本身：写工具侧的接线由各工具的用例覆盖。
 */
describe('path ownership', () => {
  const root = '/repo';
  const src = join(root, 'src');

  it('allows writes inside an owned path and rejects anything outside it', () => {
    const context = { writeMode: 'owned_paths', ownedPaths: [src], cwd: root };

    expect(() => assertWritablePath('src/a.ts', context)).not.toThrow();
    expect(() => assertWritablePath('src/nested/a.ts', context)).not.toThrow();
    // 前缀相近但不是子目录，必须按路径段判断而不是字符串前缀。
    expect(() => assertWritablePath('src-extra/a.ts', context)).toThrow(/outside subagent owned_paths/);
    expect(() => assertWritablePath('docs/a.md', context)).toThrow(/outside subagent owned_paths/);
  });

  it('rejects every write for read-only and proposal subagents', () => {
    expect(() => assertWritablePath('src/a.ts', { writeMode: 'none', cwd: root })).toThrow(/read-only/);
    expect(() => assertWritablePath('src/a.ts', { writeMode: 'proposal', cwd: root })).toThrow(/proposal mode/);
  });

  it('allows shell cwd inside or above the lease within the workspace', () => {
    const context = { writeMode: 'owned_paths', ownedPaths: [src], cwd: root };

    expect(() => assertShellPathAccess('src', context)).not.toThrow();
    expect(() => assertShellPathAccess('src/nested', context)).not.toThrow();
    expect(() => assertShellPathAccess(undefined, context)).not.toThrow();
    expect(() => assertShellPathAccess('docs', context)).toThrow(/outside subagent owned_paths/);
    expect(() => assertShellPathAccess('src-extra', context)).toThrow(/outside subagent owned_paths/);
    expect(() => assertShellPathAccess('..', context)).toThrow(/outside subagent owned_paths/);
  });

  it('supports not-yet-created file leases without widening file writes', () => {
    const context = { writeMode: 'owned_paths', ownedPaths: [join(src, 'nested', 'new-file')], cwd: root };

    for (const cwd of [undefined, '.', 'src', 'src/nested'])
      expect(() => assertShellPathAccess(cwd, context)).not.toThrow();
    expect(() => assertWritablePath('src/nested/new-file', context)).not.toThrow();
    expect(() => assertWritablePath('src/nested/other-file', context)).toThrow(/outside subagent owned_paths/);
    expect(() => assertShellPathAccess('src/other', context)).toThrow(/outside subagent owned_paths/);
    expect(() => assertShellPathAccess('/', context)).toThrow(/outside subagent owned_paths/);
  });

  it.each(['file', 'directory'])('bounds external checkout cwd at its .git %s', (gitKind) => {
    const outer = mkdtempSync(join(tmpdir(), 'mica-lease-checkout-'));
    const checkout = join(outer, 'nested-checkout');
    try {
      mkdirSync(join(outer, '.git'));
      mkdirSync(checkout);
      if (gitKind === 'file') writeFileSync(join(checkout, '.git'), 'gitdir: /unused/worktree-metadata');
      else mkdirSync(join(checkout, '.git'));
      const context = {
        writeMode: 'owned_paths',
        ownedPaths: [join(checkout, 'src', 'new-file')],
        cwd: root,
      };

      expect(() => assertShellPathAccess(checkout, context)).not.toThrow();
      expect(() => assertShellPathAccess(join(checkout, 'src'), context)).not.toThrow();
      expect(() => assertShellPathAccess(dirname(checkout), context)).toThrow(/outside subagent owned_paths/);
      expect(() => assertShellPathAccess(join(checkout, 'unrelated'), context)).toThrow(/outside subagent owned_paths/);
      expect(() => assertShellPathAccess(root, context)).toThrow(/outside subagent owned_paths/);
      expect(() => assertWritablePath(join(checkout, 'src', 'other-file'), context)).toThrow(
        /outside subagent owned_paths/,
      );

      const directoryLease = { ...context, ownedPaths: [checkout] };
      expect(() => assertShellPathAccess(checkout, directoryLease)).not.toThrow();
      expect(() => assertShellPathAccess(dirname(checkout), directoryLease)).toThrow(/outside subagent owned_paths/);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('allows only the containing directory for standalone external file leases', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mica-lease-standalone-'));
    try {
      const context = { writeMode: 'owned_paths', ownedPaths: [join(directory, 'new-file')], cwd: root };
      expect(() => assertShellPathAccess(directory, context)).not.toThrow();
      expect(() => assertShellPathAccess(dirname(directory), context)).toThrow(/outside subagent owned_paths/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('parses owned_paths strictly: bad input must not degrade into "no limit"', () => {
    expect(parseOwnedPaths(undefined)).toEqual([]);
    expect(parseOwnedPaths(['src', ' src '])).toEqual(normalizeOwnedPaths(['src']));
    expect(() => parseOwnedPaths('src')).toThrow(/array of strings/);
    expect(() => parseOwnedPaths([1])).toThrow(/non-empty strings/);
    expect(() => parseOwnedPaths(['  '])).toThrow(/non-empty strings/);
  });

  it('normalizes to absolute paths so relative and absolute leases compare equal', () => {
    expect(normalizeOwnedPaths(['src', src], root)).toEqual([src]);
  });

  it('treats nested paths as conflicting leases', () => {
    expect(findPathConflict([src], [join(src, 'nested')])).not.toBeNull();
    expect(findPathConflict([src], [join(root, 'docs')])).toBeNull();
  });
});
