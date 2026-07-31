// Verifies that every interactive `mica` launch auto-starts the sync daemon
// (pid file) and does not double-start when the daemon is already alive.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PtyDriver } from '../index.js';

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(path: string): number {
  try {
    const value = Number.parseInt(readFileSync(path, 'utf-8').trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

async function waitForPid(pidPath: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = readPidFile(pidPath);
    if (pid && isPidAlive(pid)) return pid;
    await new Promise((r) => setTimeout(r, 200));
  }
  return 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('daemon auto-start from interactive mica', () => {
  it('starts the daemon on first launch and reuses it on the next', async () => {
    const step = (label: string) => console.log(`[daemon-test] ${label}`);
    const temp = mkdtempSync(join(tmpdir(), 'mica-daemon-test-'));
    const micaHome = join(temp, 'home');
    const workDir = join(temp, 'work');
    const dataDir = join(temp, 'data');
    mkdirSync(micaHome, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    // Minimal valid config: a provider with an explicit model so the UI
    // starts without network lookups (an empty providers array or a missing
    // model both fail startup validation).
    writeFileSync(
      join(micaHome, 'config.json'),
      JSON.stringify({
        providers: [
          {
            id: 'local',
            name: 'Local',
            protocol: 'openai_chat_completions',
            api_base: 'http://127.0.0.1:9',
            api_key: 'x',
            models: ['test-model'],
          },
        ],
      }),
    );

    // Real local sync server so the daemon registers successfully and stays up
    // (a daemon whose registration fails exits and removes its pid file).
    const serverBin = resolve(import.meta.dirname, '../../..', 'dist/mica-sync-server.js');
    const port = 5780 + Math.floor(Math.random() * 100);
    const server: ChildProcess = spawn(process.execPath, [serverBin, '--port', String(port), '--data-dir', dataDir], {
      stdio: 'ignore',
    });
    const serverUrl = `http://127.0.0.1:${port}`;
    const waitServer = async () => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${serverUrl}/api/status`);
          if (res.ok) return;
        } catch {
          // not up yet
        }
        await sleep(200);
      }
      throw new Error('sync server did not start');
    };
    await waitServer();
    step(`sync server up at ${serverUrl}`);
    writeFileSync(join(micaHome, 'sync.json'), JSON.stringify({ serverUrl, name: 't' }));

    const pidPath = join(micaHome, 'daemon.pid');
    const mica = resolve(import.meta.dirname, '../../..', 'dist/mica');
    const env = { MICA_HOME: micaHome, MICA_NO_UPDATE: '1' };
    const drivers: PtyDriver[] = [];
    const spawnMica = () => {
      const driver = PtyDriver.spawn([mica], { cwd: workDir, env, cols: 120, rows: 40, logPath: join(temp, 'mica.raw') });
      drivers.push(driver);
      return driver;
    };
    const waitStarted = (driver: PtyDriver) =>
      driver.waitFor(/Type a message|start a conversation/, { timeoutMs: 60_000 });

    const daemons = new Set<number>();
    try {
      // 1. First launch: daemon should be spawned and pid file written.
      step('launching mica #1');
      const first = spawnMica();
      await waitStarted(first);
      step('mica #1 UI up');
      const firstPid = await waitForPid(pidPath, 10_000);
      step(`mica #1 daemon pid=${firstPid}`);
      expect(firstPid).toBeGreaterThan(0);
      daemons.add(firstPid);
      await first.close('SIGTERM', 3000);

      // 2. Second launch: daemon already alive -> pid file unchanged.
      await sleep(500);
      step('launching mica #2');
      const second = spawnMica();
      await waitStarted(second);
      step('mica #2 UI up');
      await sleep(2500);
      const secondPid = readPidFile(pidPath);
      step(`mica #2 daemon pid=${secondPid}`);
      expect(secondPid).toBe(firstPid);
      await second.close('SIGTERM', 3000);
    } finally {
      for (const driver of drivers) {
        try {
          await driver.close('SIGKILL', 2000);
        } catch {
          // already closed
        }
      }
      for (const pid of daemons) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      server.kill('SIGKILL');
    }
  }, 120_000);
});
