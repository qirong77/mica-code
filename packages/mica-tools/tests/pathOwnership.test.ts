import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
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

  it('keeps shell cwd inside the lease', () => {
    const context = { writeMode: 'owned_paths', ownedPaths: [src], cwd: root };

    expect(() => assertShellPathAccess('src', context)).not.toThrow();
    expect(() => assertShellPathAccess(undefined, context)).toThrow(/outside subagent owned_paths/);
    expect(() => assertShellPathAccess('..', context)).toThrow(/outside subagent owned_paths/);
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
