import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { resolveSessionCwd } from './sidecarProcess.js';

describe('resolveSessionCwd', () => {
  it('always returns an absolute path', () => {
    // 这个值是子进程的 cwd 兼 --dir；相对路径会被解析两次（/repo/api → /repo/api/api）。
    expect(isAbsolute(resolveSessionCwd('apps/desktop'))).toBe(true);
    expect(resolveSessionCwd('apps/desktop')).toBe(resolve(process.cwd(), 'apps/desktop'));
  });

  it('leaves an absolute path alone', () => {
    const abs = resolve(process.cwd(), 'apps');
    expect(resolveSessionCwd(abs)).toBe(abs);
  });

  it('expands ~ and ~/', () => {
    expect(resolveSessionCwd('~')).toBe(resolve(homedir()));
    expect(resolveSessionCwd('~/Desktop')).toBe(join(homedir(), 'Desktop'));
  });

  it('does not expand ~ in the middle of a path', () => {
    // `a/~/b` 是普通目录名，别把 ~ 当通配符。
    const weird = join(process.cwd(), 'a', '~', 'b');
    expect(resolveSessionCwd('a/~/b')).toBe(weird);
  });

  it('falls back to the current directory when omitted or blank', () => {
    expect(resolveSessionCwd()).toBe(process.cwd());
    expect(resolveSessionCwd('   ')).toBe(process.cwd());
  });

  it('normalises . and ..', () => {
    expect(resolveSessionCwd('apps/../apps/desktop')).toBe(resolve(process.cwd(), 'apps/desktop'));
  });
});
