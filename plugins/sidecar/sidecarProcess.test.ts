import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { currentSidecarDepth, MAX_SIDECAR_DEPTH, resolveSessionCwd } from './sidecarProcess.js';

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

describe('currentSidecarDepth', () => {
  const original = process.env.MICA_SIDECAR_DEPTH;
  const restore = () => {
    if (original === undefined) delete process.env.MICA_SIDECAR_DEPTH;
    else process.env.MICA_SIDECAR_DEPTH = original;
  };

  it('is 0 when the env marker is absent', () => {
    delete process.env.MICA_SIDECAR_DEPTH;
    expect(currentSidecarDepth()).toBe(0);
    restore();
  });

  it('reads the marker a parent wrote', () => {
    process.env.MICA_SIDECAR_DEPTH = '2';
    expect(currentSidecarDepth()).toBe(2);
    restore();
  });

  it('treats garbage as depth 0 rather than letting nesting explode', () => {
    // 一个坏值必须退化成「顶层」而不是「无限」，否则防护本身就失效了。
    for (const bad of ['', 'abc', '-1', 'NaN']) {
      process.env.MICA_SIDECAR_DEPTH = bad;
      expect(currentSidecarDepth()).toBe(0);
    }
    restore();
  });

  it('keeps the ceiling at 2', () => {
    // 每层都是完整 mica 进程；改大这个值等于放大指数级的进程数。
    expect(MAX_SIDECAR_DEPTH).toBe(2);
  });
});
