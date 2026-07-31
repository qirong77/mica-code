import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { PtyDriver } from '../index.js';

const enabled = process.env.MICA_PTY_SYNC_SMOKE === '1';
const suite = enabled ? describe : describe.skip;
const root = resolve(import.meta.dirname, '../../..');

suite('local and remote turns share one session safely', () => {
  it('preserves local → remote → local history', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'mica-sync-pty-'));
    const micaHome = join(temp, 'home');
    const workDir = join(temp, 'work');
    const dataDir = join(temp, 'server-data');
    const sourceHome = process.env.MICA_PTY_SOURCE_HOME ?? join(process.env.HOME ?? '', '.mica');
    mkdirSync(micaHome, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    copyFileSync(join(sourceHome, 'config.json'), join(micaHome, 'config.json'));
    copyFileSync(join(sourceHome, 'storage.json'), join(micaHome, 'storage.json'));

    const port = await freePort();
    const serverUrl = `http://127.0.0.1:${port}`;
    const server = spawn(process.execPath, [join(root, 'dist/mica-sync-server.js'), '--port', String(port), '--data-dir', dataDir], {
      cwd: root,
      stdio: 'pipe',
    });
    const daemon = spawn(
      join(root, 'dist/mica'),
      ['daemon', '--server', serverUrl, '--name', 'mica-pty-sync-smoke'],
      {
        cwd: root,
        env: { ...process.env, MICA_HOME: micaHome, MICA_NO_UPDATE: '1' },
        stdio: 'pipe',
      },
    );
    const driver = PtyDriver.spawn([join(root, 'dist/mica')], {
      cwd: workDir,
      env: { MICA_HOME: micaHome, MICA_NO_UPDATE: '1' },
      cols: 120,
      rows: 40,
      logPath: join(temp, 'mica.raw'),
    });

    try {
      await waitUntil(async () => (await fetch(`${serverUrl}/api/status`)).ok, 15_000, 'sync server did not start');
      expect(await driver.waitFor(/Type a message|start a conversation/, { timeoutMs: 60_000 })).toBe(true);
      await driver.waitIdle(500, 10_000);

      await submitTurn(driver, 'LOCAL_ONE keep this marker');
      const first = latestSession(micaHome);
      const sessionId = String(first.id);

      await waitUntil(
        async () => {
          const sync = readJson(join(micaHome, 'sync.json'));
          if (!sync.machineId) return false;
          const response = await fetch(
            `${serverUrl}/api/machines/${encodeURIComponent(String(sync.machineId))}/sessions/${encodeURIComponent(sessionId)}`,
          );
          return response.ok;
        },
        20_000,
        'daemon did not mirror the local session',
      );

      const sync = readJson(join(micaHome, 'sync.json'));
      const runResponse = await fetch(
        `${serverUrl}/api/machines/${encodeURIComponent(String(sync.machineId))}/sessions/${encodeURIComponent(sessionId)}/run`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'REMOTE_TWO keep this marker' }),
        },
      );
      expect(runResponse.ok).toBe(true);
      await waitUntil(
        () => {
          const session = latestSession(micaHome);
          return session.turnState === 'completed' && JSON.stringify(session.snapshot).includes('REMOTE_TWO');
        },
        180_000,
        'remote turn did not complete',
      );
      expect(await driver.waitFor(/REMOTE_TWO/, { timeoutMs: 10_000, mode: 'screen' })).toBe(true);

      await submitTurn(driver, 'LOCAL_THREE keep all earlier markers');
      const finalSession = latestSession(micaHome);
      const serialized = JSON.stringify(finalSession.snapshot);
      expect(serialized).toContain('LOCAL_ONE');
      expect(serialized).toContain('REMOTE_TWO');
      expect(serialized).toContain('LOCAL_THREE');
      expect(Number(finalSession.revision)).toBeGreaterThan(Number(first.revision ?? 0));
    } finally {
      await driver.close('SIGTERM', 3000);
      stopChild(daemon);
      stopChild(server);
      rmSync(temp, { recursive: true, force: true });
    }
  }, 600_000);
});

async function submitTurn(driver: PtyDriver, text: string): Promise<void> {
  const sendPos = driver.text().length;
  await driver.typeText(text, 8);
  driver.enter();
  expect(await driver.waitTurnCompleted(sendPos, { timeoutMs: 180_000 })).toBe('completed');
  await driver.waitIdle(500, 10_000);
}

function latestSession(micaHome: string): Record<string, any> {
  const dir = join(micaHome, 'sessions');
  const name = readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .sort((left, right) => statSync(join(dir, right)).mtimeMs - statSync(join(dir, left)).mtimeMs)[0];
  if (!name) throw new Error('No session was persisted');
  return readJson(join(dir, name));
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, message: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // Startup and atomic file replacement can make a check transiently fail.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(message);
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Unable to allocate test port');
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}
