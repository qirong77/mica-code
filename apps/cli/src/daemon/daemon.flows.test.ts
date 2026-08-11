import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const bunAvailable = process.env.MICA_BIN || spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
const suite = bunAvailable ? describe : describe.skip;
const children: ChildProcess[] = [];
const servers: Server[] = [];

function makeHome(tag: string): string {
  const home = mkdtempSync(join(tmpdir(), `mica-daemon-flow-${process.pid}-${tag}-`));
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      providers: [
        {
          id: 'flow',
          api_base: 'https://example.invalid/v1',
          protocol: 'openai_chat_completions',
          models: ['flow-model'],
        },
      ],
    }),
    'utf-8',
  );
  return home;
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<Server> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function childArgs(args: string[]): string[] {
  return [...(process.env.MICA_BIN ? [] : ['apps/cli/src/index.ts']), ...args];
}

function startDaemon(
  home: string,
  serverPort: number,
): { child: ChildProcess; output: Promise<{ code: number | null; stdout: string; stderr: string }> } {
  const child = spawn(
    process.env.MICA_BIN ?? 'bun',
    childArgs(['daemon', '--server', `http://127.0.0.1:${serverPort}`, '--name', 'flow-machine']),
    {
      cwd: ROOT,
      env: { ...process.env, MICA_HOME: home, MICA_NO_DAEMON: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => (stdout += chunk.toString()));
  child.stderr?.on('data', (chunk) => (stderr += chunk.toString()));
  const output = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, output };
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(condition()).toBe(true);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
  }
  for (const server of servers.splice(0)) {
    if (server.listening) await closeServer(server);
  }
});

suite('mica daemon flows', () => {
  it('reports registration failures and removes its pid file before exiting', async () => {
    let registerRequests = 0;
    const server = await listen((_request, response) => {
      registerRequests += 1;
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'registration unavailable' }));
    });
    const home = makeHome('registration-error');
    const { output } = startDaemon(home, (server.address() as AddressInfo).port);

    const result = await output;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('registration failed');
    expect(result.stderr).toContain('HTTP 503');
    expect(registerRequests).toBe(1);
    expect(existsSync(join(home, 'daemon.pid'))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  }, 20_000);

  it('does not register or overwrite a live daemon pid during duplicate startup', async () => {
    let requests = 0;
    const server = await listen((_request, response) => {
      requests += 1;
      response.writeHead(500).end();
    });
    const home = makeHome('duplicate');
    const pidPath = join(home, 'daemon.pid');
    writeFileSync(pidPath, `${process.pid}\n`, 'utf-8');
    const { output } = startDaemon(home, (server.address() as AddressInfo).port);

    const result = await output;
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('already running');
    expect(requests).toBe(0);
    expect(readFileSync(pidPath, 'utf-8').trim()).toBe(String(process.pid));
    rmSync(home, { recursive: true, force: true });
  }, 20_000);

  it('retries a failed poll and cleans up the poll connection and pid on SIGTERM', async () => {
    let registerRequests = 0;
    let pollRequests = 0;
    let pollDisconnected = false;
    const server = await listen((request, response) => {
      if (request.url === '/daemon/register') {
        registerRequests += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ machineId: 'flow-machine-id', name: 'flow-machine' }));
        return;
      }
      if (request.url === '/daemon/poll') {
        pollRequests += 1;
        if (pollRequests === 1) {
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'temporary poll failure' }));
          return;
        }
        request.once('close', () => {
          pollDisconnected = true;
        });
        // Keep the second poll open so SIGTERM exercises cleanup of an in-flight request.
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    const home = makeHome('poll-retry-signal');
    const port = (server.address() as AddressInfo).port;
    const { child, output } = startDaemon(home, port);

    await waitFor(() => registerRequests === 1 && pollRequests >= 2, 15_000);
    child.kill('SIGTERM');
    const result = await output;
    await waitFor(() => pollDisconnected, 2_000);

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('poll failed');
    expect(result.stderr).toContain('temporary poll failure');
    expect(pollRequests).toBe(2);
    expect(pollDisconnected).toBe(true);
    expect(existsSync(join(home, 'daemon.pid'))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, 'sync.json'), 'utf-8'))).toMatchObject({
      serverUrl: `http://127.0.0.1:${port}`,
      machineId: 'flow-machine-id',
      name: 'flow-machine',
    });
    rmSync(home, { recursive: true, force: true });
  }, 25_000);
});
