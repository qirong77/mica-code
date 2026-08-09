import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { daemonShouldStart, isPidAlive, readPid, writeDaemonPid, removeDaemonPid } from './ensureDaemonRunning.js';

function spawnSleepingChild(): Promise<{ pid: number; kill: () => void }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    proc.once('error', reject);
    proc.once('spawn', () => resolve({ pid: proc.pid!, kill: () => proc.kill('SIGKILL') }));
  });
}

describe('daemon pid decision', () => {
  it('writes and reads the pid file under MICA_HOME', () => {
    const temp = mkdtempSync(join(tmpdir(), 'mica-daemon-unit-'));
    const original = process.env.MICA_HOME;
    process.env.MICA_HOME = temp;
    try {
      writeDaemonPid(12345);
      expect(readPid(join(temp, 'daemon.pid'))).toBe(12345);
      expect(readFileSync(join(temp, 'daemon.pid'), 'utf-8').trim()).toBe('12345');
      removeDaemonPid();
      expect(readPid(join(temp, 'daemon.pid'))).toBe(0);
    } finally {
      if (original === undefined) delete process.env.MICA_HOME;
      else process.env.MICA_HOME = original;
    }
  });

  it('starts when there is no pid file', () => {
    const temp = mkdtempSync(join(tmpdir(), 'mica-daemon-unit-'));
    expect(daemonShouldStart(join(temp, 'daemon.pid'))).toBe(true);
  });

  it('does not start when the recorded pid is alive', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'mica-daemon-unit-'));
    const child = await spawnSleepingChild();
    try {
      const pidPath = join(temp, 'daemon.pid');
      writeFileSync(pidPath, `${child.pid}\n`, 'utf-8');
      expect(isPidAlive(child.pid)).toBe(true);
      expect(daemonShouldStart(pidPath)).toBe(false);
    } finally {
      child.kill();
    }
  });

  it('starts again when the recorded pid is stale (daemon was killed)', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'mica-daemon-unit-'));
    const child = await spawnSleepingChild();
    const pidPath = join(temp, 'daemon.pid');
    writeFileSync(pidPath, `${child.pid}\n`, 'utf-8');
    child.kill();
    // Wait for the process to actually die.
    const deadline = Date.now() + 5000;
    while (isPidAlive(child.pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(isPidAlive(child.pid)).toBe(false);
    expect(daemonShouldStart(pidPath)).toBe(true);
  });
});
