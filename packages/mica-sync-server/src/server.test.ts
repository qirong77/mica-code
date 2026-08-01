import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startSyncServer, type RunningSyncServer } from './server.js';
import { SyncStore } from './store.js';

const dataDirs: string[] = [];
let server: RunningSyncServer | null = null;

async function request(
  path: string,
  options: { method?: string; body?: unknown; machineId?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${server!.port}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.machineId ? { 'x-machine-id': options.machineId } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

beforeEach(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mica-sync-server-'));
  dataDirs.push(dataDir);
  server = await startSyncServer({ port: 0, host: '127.0.0.1', dataDir });
});

afterEach(async () => {
  await server?.stop();
  server = null;
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  return dataDirs[dataDirs.length - 1];
}

describe('create session endpoint', () => {
  it('mints a session id and dispatches a create command to the daemon', async () => {
    const registered = await request('/daemon/register', {
      method: 'POST',
      body: { name: 'host', hostname: 'host.local', platform: 'darwin', version: '1' },
    });
    const machineId = String(registered.body.machineId);

    const created = await request(`/api/machines/${machineId}/sessions`, {
      method: 'POST',
      body: { text: 'hello', cwd: '/tmp' },
    });
    expect(created.status).toBe(200);
    expect(created.body.sessionId).toEqual(expect.any(String));

    const polled = await request('/daemon/poll', { method: 'POST', body: {}, machineId });
    const commands = polled.body.commands as Array<Record<string, unknown>>;
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: 'create',
      sessionId: created.body.sessionId,
      prompt: 'hello',
      cwd: '/tmp',
    });
  });

  it('allows omitting cwd and rejects empty text', async () => {
    const registered = await request('/daemon/register', {
      method: 'POST',
      body: { name: 'host', hostname: 'host.local', platform: 'darwin', version: '1' },
    });
    const machineId = String(registered.body.machineId);

    const created = await request(`/api/machines/${machineId}/sessions`, {
      method: 'POST',
      body: { text: 'hello' },
    });
    expect(created.status).toBe(200);

    const empty = await request(`/api/machines/${machineId}/sessions`, {
      method: 'POST',
      body: { text: '   ' },
    });
    expect(empty.status).toBe(400);
  });

  it('rejects create for an offline machine', async () => {
    // Registration sets lastSeen to now (online), so seed an old record via the
    // store directly and only make the server aware of it.
    const store = new SyncStore(dataDir());
    store.upsertMachine({
      id: 'offline-machine',
      name: 'old',
      hostname: 'old.local',
      platform: 'darwin',
      version: '1',
    });
    store.updateMachine('offline-machine', { lastSeen: new Date(Date.now() - 120_000).toISOString() });

    const created = await request(`/api/machines/offline-machine/sessions`, {
      method: 'POST',
      body: { text: 'hello' },
    });
    expect(created.status).toBe(409);
  });

  it('dispatches an update_cwd command with a non-empty cwd', async () => {
    const registered = await request('/daemon/register', {
      method: 'POST',
      body: { name: 'host', hostname: 'host.local', platform: 'darwin', version: '1' },
    });
    const machineId = String(registered.body.machineId);
    const created = await request(`/api/machines/${machineId}/sessions`, {
      method: 'POST',
      body: { text: 'hello' },
    });
    const sessionId = String(created.body.sessionId);

    const updated = await request(`/api/machines/${machineId}/sessions/${sessionId}/cwd`, {
      method: 'POST',
      body: { cwd: '/srv/app' },
    });
    expect(updated.status).toBe(200);

    const polled = await request('/daemon/poll', { method: 'POST', body: {}, machineId });
    const commands = polled.body.commands as Array<Record<string, unknown>>;
    expect(commands).toHaveLength(2);
    expect(commands[1]).toMatchObject({ type: 'update_cwd', sessionId, cwd: '/srv/app' });

    const empty = await request(`/api/machines/${machineId}/sessions/${sessionId}/cwd`, {
      method: 'POST',
      body: { cwd: '   ' },
    });
    expect(empty.status).toBe(400);
  });

  it('does not let an abandoned poll steal queued commands', async () => {
    const registered = await request('/daemon/register', {
      method: 'POST',
      body: { name: 'host', hostname: 'host.local', platform: 'darwin', version: '1' },
    });
    const machineId = String(registered.body.machineId);

    // Open a long-poll and abandon it: the server must drop the waiter when
    // the connection closes, otherwise a later command is routed to a dead
    // socket and lost for the live daemon.
    const controller = new AbortController();
    const abandoned = fetch(`http://127.0.0.1:${server!.port}/daemon/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-machine-id': machineId },
      body: '{}',
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await abandoned.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const created = await request(`/api/machines/${machineId}/sessions`, {
      method: 'POST',
      body: { text: 'hi' },
    });
    expect(created.status).toBe(200);

    const polled = await request('/daemon/poll', { method: 'POST', body: {}, machineId });
    const commands = polled.body.commands as Array<Record<string, unknown>>;
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: 'create', prompt: 'hi' });
  });
});
