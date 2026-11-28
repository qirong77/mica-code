import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHttpConfigWebClient } from '../../web/src/http-client.js';
import { httpRoutes, matchHttpAction } from '../httpRoutes.js';

const id = '20260801-http';
const home = mkdtempSync(join(tmpdir(), 'mica-config-http-'));
let handle: typeof import('./server.js').handleConfigApi;

beforeAll(async () => {
  vi.stubEnv('MICA_HOME', home);
  vi.resetModules();
  handle = (await import('./server.js')).handleConfigApi;
  mkdirSync(join(home, 'sessions'), { recursive: true });
  const time = '2026-08-01T00:00:00.000Z';
  writeFileSync(
    join(home, 'sessions', `${id}.json`),
    JSON.stringify({
      version: 1,
      id,
      title: 'HTTP session',
      createdAt: time,
      updatedAt: time,
      cwd: home,
      turnState: 'completed',
      snapshot: {
        messageFormat: 'pi-ai-v1',
        providerId: 'test',
        protocol: 'openai_responses',
        model: 'test',
        effort: 'high',
        role: 'default',
        systemPrompt: 'system',
        conversationMessages: [],
        usageHistory: [],
        messages: ['one', 'two', 'three'].map((content, timestamp) => ({ role: 'user', content, timestamp })),
      },
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function request(path: string, options?: RequestInit) {
  return handle(new Request(new URL(path, 'http://localhost'), options));
}

describe('config HTTP actions', () => {
  it('resolves every registered method and view and preserves HTTP error statuses', async () => {
    for (const [name, route] of Object.entries(httpRoutes)) {
      expect(matchHttpAction(route.path, route.method, route.view)).toBe(name);
    }
    expect((await request('/api/details/unknown')).status).toBe(404);
    expect((await request('/api/provider-test')).status).toBe(405);
    expect((await request('/api/details/session?id=missing')).status).toBe(404);
    expect((await request('/api/files/config', { method: 'PUT', body: '{}' })).status).toBe(400);
    expect(await (await request(`/api/details/session?id=${id}&view=unknown`)).json()).toMatchObject({ id });
  });

  it('reads the requested end of the conversation through the browser client and the real action', async () => {
    vi.stubGlobal('fetch', request);
    const client = createHttpConfigWebClient();
    const first = await client.readSessionConversationPage(id, 0, 2);
    const last = await client.readSessionConversationPage(id, 0, 2, true);
    expect(first.items.map((item) => item.content)).toEqual(['system', 'one']);
    expect(last.items.map((item) => item.content)).toEqual(['two', 'three']);
    expect(await client.readSessionItem(id, 3)).toEqual(last.items[0]);
  });

  it('creates, edits and deletes a role through its existing HTTP resource', async () => {
    vi.stubGlobal('fetch', request);
    const client = createHttpConfigWebClient();
    const role = '审阅';
    expect((await client.createRole(role)).roles).toContainEqual(expect.objectContaining({ name: role, content: '' }));
    expect((await client.writeRole(role, 'Updated')).roles.at(-1)?.content).toBe('Updated');
    expect((await client.deleteRole(role)).roles.map(({ name }) => name)).toEqual(['default']);
  });
});
