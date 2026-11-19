import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPanelHandler, PANEL_STATE_FILE } from './Panel.js';
import { emptyData, readData, upsertHost, writeData } from './Hosts.js';
import { readHostFingerprint, testConnection, type RemoteContext } from './Remote.js';

vi.mock('./Remote.js', () => ({ testConnection: vi.fn(), readHostFingerprint: vi.fn() }));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mica-ssh-panel-'));
  vi.clearAllMocks();
  vi.mocked(testConnection).mockResolvedValue({ ok: true, message: 'mock Linux', fingerprint: null });
  vi.mocked(readHostFingerprint).mockReturnValue(null);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const values = { id: 'test', host: 'example.invalid', port: '22', user: 'root', auth: 'key', keyPath: '/mock/key' };
function setup() {
  const dataFile = join(dir, 'data.json');
  writeData(dataFile, upsertHost(emptyData(), values).data);
  let explicit: string[] | null = ['test'];
  const closeSession = vi.fn();
  const panel = createPanelHandler({
    ctx: { dataDir: dir } as RemoteContext,
    dataFile,
    closeSession,
    scope: {
      explicit: () => explicit,
      set: (ids) => {
        explicit = ids;
      },
    },
  });
  return { panel, dataFile, closeSession, explicit: () => explicit };
}

describe('SSH panel structured outcomes (mock transport)', () => {
  it('reports successful connection and preserves its existing human message', async () => {
    const { panel } = setup();
    expect(await panel.action({ action: 'connect', values })).toMatchObject({
      outcome: 'success',
      code: 'connected',
      message: expect.stringContaining('已连接 test'),
    });
    expect(testConnection).toHaveBeenCalledTimes(1);
  });

  it('reports a captured connection failure as error and keeps the form', async () => {
    const { panel } = setup();
    vi.mocked(testConnection).mockResolvedValue({ ok: false, message: 'mock refused', fingerprint: null });
    expect(await panel.action({ action: 'connect', values })).toMatchObject({
      outcome: 'error',
      code: 'connection_failed',
      message: '连接失败：mock refused',
      keepDrafts: true,
    });
    const view = await panel.view({ role: 'default' });
    expect(view?.sections?.[0]?.table?.rows[0]?.cells.status?.text).toBe('连不上');
  });

  it('does not call the transport when validation fails', async () => {
    const { panel } = setup();
    expect(await panel.action({ action: 'connect', values: { ...values, id: 'bad id' } })).toMatchObject({
      outcome: 'error',
      code: 'connect_failed',
      keepDrafts: true,
    });
    expect(testConnection).not.toHaveBeenCalled();
  });

  it('does not report a corrupt-store save as successful or change its bytes', async () => {
    const { panel, dataFile } = setup();
    const raw = '{ CANARY original damaged source';
    writeFileSync(dataFile, raw, 'utf8');
    expect(await panel.action({ action: 'toggle-auto', key: 'test', values: { check: 'true' } })).toMatchObject({
      outcome: 'error',
      code: 'invalid_data',
      keepDrafts: true,
    });
    expect(readFileSync(dataFile, 'utf8')).toBe(raw);
    expect(testConnection).not.toHaveBeenCalled();
  });

  it('reports failed draft persistence without consuming the form', async () => {
    const { panel } = setup();
    mkdirSync(join(dir, PANEL_STATE_FILE));
    expect(await panel.action({ action: 'draft', values })).toMatchObject({
      outcome: 'error',
      code: 'state_save_failed',
      keepDrafts: true,
    });
  });

  it('closes the old shell immediately when the panel revokes session scope', async () => {
    const { panel, closeSession, explicit, dataFile } = setup();
    expect(await panel.action({ action: 'toggle-session', key: 'test', values: { check: 'false' } })).toMatchObject({
      outcome: 'success',
      code: 'session_scope_saved',
    });
    expect(explicit()).toEqual([]);
    expect(closeSession).toHaveBeenCalledExactlyOnceWith('test');
    expect(readData(dataFile).hosts).toHaveLength(1);
  });

  it('keeps confirmation waiting, cancellation and missing-host rejection distinct', async () => {
    const { panel } = setup();
    expect(await panel.action({ action: 'toggle-session' })).toMatchObject({
      outcome: 'declined',
      code: 'missing_host',
    });
    expect(await panel.action({ action: 'edit', key: 'gone' })).toMatchObject({
      outcome: 'declined',
      code: 'host_unavailable',
    });
    expect(await panel.action({ action: 'delete', key: 'test' })).toMatchObject({
      outcome: 'waiting',
      code: 'delete_confirmation',
    });
    expect(await panel.action({ action: 'cancel-delete' })).toMatchObject({
      outcome: 'cancelled',
      code: 'delete_cancelled',
    });
  });
});
