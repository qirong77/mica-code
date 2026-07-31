import { afterAll, describe, expect, it } from 'vitest';
import { PtyManager, MAX_PTY_OUTPUT_BYTES } from '../src/manager.js';

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
    const { sessionId } = await manager.spawn([SHELL, '-c', 'i=0; while [ $i -lt 2000 ]; do echo line-$i; i=$((i+1)); done']);
    await manager.wait(sessionId, { idleMs: 200, timeoutMs: LONG_TIMEOUT });
    const read = manager.read(sessionId, { mode: 'tail', windowSize: MAX_PTY_OUTPUT_BYTES });
    expect(read.totalBytes).toBeLessThanOrEqual(MAX_PTY_OUTPUT_BYTES + 4096);
    await manager.kill(sessionId);
  });
});
