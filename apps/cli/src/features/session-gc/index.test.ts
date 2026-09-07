import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { daemonShouldStart, isPidAlive, readGcPid, writeGcPid, removeGcPid } from './index.js';

const originalMicaHome = process.env.MICA_HOME;

afterEach(() => {
  if (originalMicaHome === undefined) delete process.env.MICA_HOME;
  else process.env.MICA_HOME = originalMicaHome;
});

describe('session-gc single-instance guard', () => {
  let tempHome: string;

  beforeAll(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'mica-gc-unit-'));
  });

  afterEach(() => {
    rmSync(join(tempHome, 'session-gc.pid'), { force: true });
  });

  it('writes and reads the pid file under MICA_HOME', () => {
    process.env.MICA_HOME = tempHome;
    writeGcPid(12345);
    expect(readGcPid()).toBe(12345);
    expect(readFileSync(join(tempHome, 'session-gc.pid'), 'utf-8').trim()).toBe('12345');
    removeGcPid();
    expect(readGcPid()).toBe(0);
  });

  it('returns 0 when the pid file is absent', () => {
    process.env.MICA_HOME = tempHome;
    expect(readGcPid()).toBe(0);
  });

  it('treats an existing live pid as not needing to start', () => {
    process.env.MICA_HOME = tempHome;
    writeFileSync(join(tempHome, 'session-gc.pid'), `${process.pid}\n`, 'utf8');
    expect(isPidAlive(process.pid)).toBe(true);
    expect(daemonShouldStart()).toBe(false);
  });

  it('treats a missing pid file or a dead pid as needing to start', () => {
    process.env.MICA_HOME = tempHome;
    // No pid file.
    expect(daemonShouldStart()).toBe(true);
    // A pid that cannot be alive: beyond PID_MAX (9007199254740991) kill(pid, 0)
    // throws ESRCH on every platform, which isPidAlive maps to "not alive".
    writeFileSync(join(tempHome, 'session-gc.pid'), `9007199254740991\n`, 'utf8');
    expect(daemonShouldStart()).toBe(true);
  });
});
