import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { currentSidecarDepth, MAX_SIDECAR_DEPTH, SidecarProcess, resolveSessionCwd } from './sidecarProcess.js';

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

/** 等进程真的消失（pid 复用在这种时间尺度上可以忽略）。 */
async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  while (Date.now() < deadline) {
    if (!alive()) return true;
    await new Promise((done) => setTimeout(done, 50));
  }
  return !alive();
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((done) => setTimeout(done, 20));
  }
  return existsSync(path);
}

describe('SidecarProcess.start', () => {
  it('kills the child process when the handshake never completes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-sidecar-handshake-'));
    const pidFile = join(dir, 'pid');
    // 冒充一个「起得来但永远不回答 initialize」的 app-server：先把 pid 落盘再 exec
    // 成 sleep，落盘的 pid 就是那个真正需要被收掉的进程。
    const launch = { command: '/bin/sh', prefixArgs: ['-c', `echo $$ > ${pidFile}; exec sleep 30`] };

    await expect(SidecarProcess.start({ cwd: dir, launch, requestTimeoutMs: 300 })).rejects.toThrow(/超时/);
    expect(await waitForFile(pidFile, 2_000)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    // 握手失败时调用方拿不到引用：不在这里收掉，它就成了没人管的进程——继续吃内存，
    // 还不占 MAX_SIDECARS 名额，重试几次就是一份进程堆积。
    expect(await waitUntilGone(pid, 5_000)).toBe(true);
  }, 20_000);
});
