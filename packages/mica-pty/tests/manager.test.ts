import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PtyManager, MAX_PTY_OUTPUT_BYTES, findNodePtyUpward, resolveNodePtyEntry } from '../src/manager.js';

const SHELL = process.env.MICA_PTY_TEST_SHELL ?? '/bin/sh';
const LONG_TIMEOUT = 20_000;

function makeManager(): PtyManager {
  return new PtyManager();
}

afterAll(async () => {
  // Ensure no helper processes leak across test files.
  const { ptyManager } = await import('../index.js');
  await ptyManager.shutdown();
});

describe('PtyManager', () => {
  it('spawns a PTY program and captures its output', async () => {
    const manager = makeManager();
    const { sessionId, pid } = await manager.spawn([SHELL, '-c', 'echo pty-hello; sleep 5'], {
      cols: 80,
      rows: 24,
    });
    expect(sessionId).toMatch(/^[a-f0-9]{12}$/);
    expect(pid).toBeGreaterThan(0);

    const wait = await manager.wait(sessionId, { pattern: 'pty-hello', timeoutMs: LONG_TIMEOUT });
    expect(wait.matched).toBe(true);
    expect(wait.output).toContain('pty-hello');

    const read = manager.read(sessionId);
    expect(read.output).toContain('pty-hello');
    expect(read.exited).toBe(false);

    await manager.kill(sessionId);
  });

  it('supports interactive input via send and named keys', async () => {
    const manager = makeManager();
    const { sessionId } = await manager.spawn([SHELL], { cols: 80, rows: 24 });
    await manager.send(sessionId, 'echo pty-interactive\r');
    const wait = await manager.wait(sessionId, { pattern: 'pty-interactive', timeoutMs: LONG_TIMEOUT });
    expect(wait.matched).toBe(true);

    // Named key: Ctrl+C should not crash the shell (it is non-interactive here).
    await manager.sendKey(sessionId, 'ctrlC');
    await manager.sendKey(sessionId, 'enter');
    const read = manager.read(sessionId);
    expect(read.output).toContain('pty-interactive');

    await manager.kill(sessionId);
  });

  it('reports process exit through read()', async () => {
    const manager = makeManager();
    const { sessionId } = await manager.spawn([SHELL, '-c', 'exit 7']);
    await manager.wait(sessionId, { timeoutMs: LONG_TIMEOUT });
    const read = manager.read(sessionId);
    expect(read.exited).toBe(true);
  });

  it('wait returns exited when the process terminates before matching', async () => {
    const manager = makeManager();
    const { sessionId } = await manager.spawn([SHELL, '-c', 'true']);
    const wait = await manager.wait(sessionId, { pattern: 'never-appears', timeoutMs: LONG_TIMEOUT });
    expect(wait.reason).toBe('exited');
    expect(wait.exited).toBe(true);
  });

  it('wait idle resolves after output settles', async () => {
    const manager = makeManager();
    const { sessionId } = await manager.spawn([SHELL, '-c', 'echo settled; sleep 0.3']);
    const wait = await manager.wait(sessionId, { idleMs: 200, timeoutMs: LONG_TIMEOUT });
    expect(wait.reason).toBe('idle');
    expect(wait.output).toContain('settled');
    await manager.kill(sessionId);
  });

  it('tail read returns only the trailing window', async () => {
    const manager = makeManager();
    const { sessionId } = await manager.spawn([SHELL, '-c', 'seq 1 50']);
    await manager.wait(sessionId, { idleMs: 150, timeoutMs: LONG_TIMEOUT });
    const read = manager.read(sessionId, { mode: 'tail', windowSize: 20 });
    expect(read.output.length).toBeLessThanOrEqual(20);
    await manager.kill(sessionId);
  });

  it('does not return malformed Unicode when a tail window cuts an emoji', async () => {
    const manager = makeManager();
    const { sessionId } = await manager.spawn([process.execPath, '-e', "process.stdout.write('🤖')"]);
    await manager.wait(sessionId, { idleMs: 150, timeoutMs: LONG_TIMEOUT });
    const read = manager.read(sessionId, { mode: 'tail', windowSize: 1 });
    expect(JSON.stringify(read.output)).not.toContain('\\ud');
    await manager.kill(sessionId);
  });

  it('read clear empties the buffer', async () => {
    const manager = makeManager();
    const { sessionId } = await manager.spawn([SHELL, '-c', 'echo to-clear']);
    await manager.wait(sessionId, { pattern: 'to-clear', timeoutMs: LONG_TIMEOUT });
    const read = manager.read(sessionId, { clear: true });
    expect(read.output).toContain('to-clear');
    const after = manager.read(sessionId);
    expect(after.output).not.toContain('to-clear');
    await manager.kill(sessionId);
  });

  it('rejects unknown sessions', async () => {
    const manager = makeManager();
    await expect(manager.send('000000000000', 'x')).rejects.toThrow();
    expect(() => manager.read('not-a-session')).toThrow();
    await expect(manager.wait('000000000000', { timeoutMs: 100 })).rejects.toThrow();
  });

  it('keeps the helper alive across sessions and shuts down cleanly', async () => {
    const manager = makeManager();
    const a = await manager.spawn([SHELL, '-c', 'echo session-a']);
    const b = await manager.spawn([SHELL, '-c', 'echo session-b']);
    await manager.wait(a.sessionId, { pattern: 'session-a', timeoutMs: LONG_TIMEOUT });
    await manager.wait(b.sessionId, { pattern: 'session-b', timeoutMs: LONG_TIMEOUT });
    expect(manager.list().length).toBe(2);
    await manager.shutdown();
    expect(manager.sessionCount).toBe(0);
  });

  it('caps the captured buffer at MAX_PTY_OUTPUT_BYTES', async () => {
    const manager = makeManager();
    // ~1 MB of output with a small interval keeps the process from being killed
    // before the buffer cap kicks in.
    const { sessionId } = await manager.spawn([
      SHELL,
      '-c',
      'i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done',
    ]);
    await manager.wait(sessionId, { idleMs: 200, timeoutMs: LONG_TIMEOUT });
    const read = manager.read(sessionId, { mode: 'tail', windowSize: MAX_PTY_OUTPUT_BYTES });
    expect(read.totalBytes).toBeLessThanOrEqual(MAX_PTY_OUTPUT_BYTES + 4096);
    await manager.kill(sessionId);
  });
});

describe('resolveNodePtyEntry', () => {
  it('优先使用 MICA_PTY_ENTRY 环境变量指定的入口', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-pty-test-'));
    const fakeEntry = join(dir, 'index.js');
    writeFileSync(fakeEntry, '');
    process.env.MICA_PTY_ENTRY = fakeEntry;
    try {
      const entry = await resolveNodePtyEntry();
      expect(entry).toBe(pathToFileURL(fakeEntry).href);
    } finally {
      delete process.env.MICA_PTY_ENTRY;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MICA_PTY_ENTRY 指向不存在的文件时继续后续查找而不是报错', async () => {
    process.env.MICA_PTY_ENTRY = join(tmpdir(), 'mica-pty-does-not-exist', 'index.js');
    try {
      const entry = await resolveNodePtyEntry();
      // 本仓库 node_modules 里应能找到真实 node-pty。
      expect(entry.endsWith('/node-pty/lib/index.js')).toBe(true);
    } finally {
      delete process.env.MICA_PTY_ENTRY;
    }
  });

  it('findNodePtyUpward 能从 node_modules 布局中定位 node-pty 入口', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-pty-test-'));
    const ptyDir = join(dir, 'node_modules', 'node-pty', 'lib');
    mkdirSync(ptyDir, { recursive: true });
    writeFileSync(join(ptyDir, 'index.js'), '');
    try {
      const entry = findNodePtyUpward(dir);
      expect(entry).toBe(pathToFileURL(join(ptyDir, 'index.js')).href);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('发布版布局（二进制旁 node_modules/node-pty）可被解析', () => {
    // 模拟 ~/.local/lib/mica/ 的发布目录结构：mica 二进制 + node_modules/node-pty。
    const dir = mkdtempSync(join(tmpdir(), 'mica-pty-test-'));
    const binaryDir = join(dir, 'lib', 'mica');
    const ptyDir = join(binaryDir, 'node_modules', 'node-pty', 'lib');
    mkdirSync(ptyDir, { recursive: true });
    writeFileSync(join(ptyDir, 'index.js'), '');
    try {
      const entry = findNodePtyUpward(binaryDir);
      expect(entry).toBe(pathToFileURL(join(ptyDir, 'index.js')).href);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
