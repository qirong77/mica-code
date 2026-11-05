import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPanelHandler } from './panel.js';
import { emptyState, mutateState, readState, stateFilePath, writeState } from './state.js';
import { readPluginData, updatePluginData } from './status.js';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mica-cookie-state-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('sync state', () => {
  it('reads a missing file as an empty state instead of throwing', () => {
    expect(readState(stateFilePath(dir))).toEqual(emptyState());
  });

  it('round-trips the baseline with an atomic replace', () => {
    const file = stateFilePath(dir);
    writeState(file, {
      version: 2,
      updatedAt: '',
      baseline: { 'example.com\u0000/\u0000sid': { c: 'aaaa', m: 'bbbb' } },
      lastRun: null
    });
    expect(readState(file).baseline['example.com\u0000/\u0000sid']).toEqual({ c: 'aaaa', m: 'bbbb' });
  });

  it('ignores entries that are not a fingerprint pair', () => {
    const file = stateFilePath(dir);
    writeState(file, { version: 2, updatedAt: '', baseline: {}, lastRun: null });
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    writeState(file, {
      version: 2,
      updatedAt: '',
      baseline: { broken: { c: 'x' } as never },
      lastRun: null
    });
    expect(readState(file).baseline).toEqual({});
    expect(parsed.version).toBe(2);
  });

  it('mutates inside a cross-process lock', async () => {
    const file = stateFilePath(dir);
    const next = await mutateState(file, (state) => ({
      ...state,
      baseline: { key: { c: '1', m: '2' } }
    }));
    expect(next.baseline.key).toEqual({ c: '1', m: '2' });
    expect(readState(file).baseline.key).toEqual({ c: '1', m: '2' });
  });
});

describe('plugin data', () => {
  it('merges patches instead of dropping keys it did not touch', () => {
    updatePluginData(dir, { target: { text: 'Chrome · Default', tone: 'ok' } });
    updatePluginData(dir, { notes: ['Chrome 正开着'] });
    const data = readPluginData(dir);
    expect(data.target?.text).toBe('Chrome · Default');
    expect(data.notes).toEqual(['Chrome 正开着']);
  });
});

describe('panel', () => {
  const handler = (patch: { settings?: Record<string, string>; saved?: Record<string, string>[] }) =>
    createPanelHandler({
      dataDir: dir,
      settings: () => patch.settings ?? {},
      saveSettings: (values) => patch.saved?.push(values),
      sync: async ({ dryRun, resolve }) => ({
        message: dryRun ? '试算：无差异' : resolve ? `选边：${resolve.key}` : '已同步'
      })
    });

  it('shows an honest empty state before the first sync', async () => {
    const view = await handler({}).view({ role: 'default' });
    expect(view.title).toBe('Cookie 同步');
    expect(view.status).toEqual({ label: '未同步', tone: 'muted' });
    expect(view.sections?.[0]?.subtitle).toContain('立即同步');
    expect(view.sections?.[2]?.empty).toBe('没有冲突');
  });

  it('renders the last run, the counts and one row per conflict', async () => {
    updatePluginData(dir, {
      target: { text: 'Chrome · 个人', tone: 'ok' },
      lastRun: { text: '2026-11-05 10:00:00 同步：写 Chrome 2', tone: 'ok' },
      counts: { text: 'Chrome 10 条 · 受控浏览器 8 条 · 一致 3 条', tone: 'ok' },
      notes: ['Chrome 正开着：这一轮没有写'],
      conflicts: [{ key: 'k1', host: 'example.com', name: 'sid', path: '/' }]
    });
    const view = await handler({}).view({ role: 'default' });
    const rows = view.sections?.[0]?.rows ?? [];
    expect(rows.map((row) => row.label)).toEqual(['上次同步', '两边条数', '注意']);
    const table = view.sections?.[2]?.table;
    expect(table?.rows).toHaveLength(1);
    expect(table?.rows[0]?.actions?.map((entry) => entry.id)).toEqual(['use-chrome', 'use-mica']);
    expect(view.statusBar?.detail).toBe('1 条冲突');
  });

  it('saves only the declared fields when the panel commits a draft', async () => {
    const saved: Record<string, string>[] = [];
    const result = await handler({ saved }).action({
      action: 'save',
      values: { toChrome: 'false', bogus: 'x' }
    });
    expect(result).toEqual({ keepDrafts: true });
    expect(saved).toEqual([{ toChrome: 'false' }]);
  });

  it('reports a settings rejection instead of pretending it saved', async () => {
    const panel = createPanelHandler({
      dataDir: dir,
      settings: () => ({}),
      saveSettings: () => {
        throw new Error('browser 必须是 chrome / chrome-beta / chrome-dev / chrome-canary');
      },
      sync: async () => ({ message: '' })
    });
    const result = (await panel.action({ action: 'save', values: { browser: 'firefox' } })) as {
      message?: string;
      keepDrafts?: boolean;
    };
    expect(result.message).toContain('browser');
    expect(result.keepDrafts).toBe(true);
  });

  it('runs preview and sync through the same handler', async () => {
    await expect(handler({}).action({ action: 'preview', values: {} })).resolves.toEqual({
      message: '试算：无差异'
    });
    await expect(handler({}).action({ action: 'sync', values: {} })).resolves.toEqual({
      message: '已同步'
    });
  });

  it('passes the row key and the chosen side when resolving a conflict', async () => {
    await expect(
      handler({}).action({ action: 'use-mica', key: 'example.com\u0000/\u0000sid', values: {} })
    ).resolves.toEqual({ message: '选边：example.com\u0000/\u0000sid' });
  });

  it('refuses an unknown action and a resolve without a key', async () => {
    await expect(handler({}).action({ action: 'nope', values: {} })).resolves.toMatchObject({
      message: expect.stringContaining('不认识')
    });
    await expect(handler({}).action({ action: 'use-chrome', values: {} })).resolves.toMatchObject({
      message: expect.stringContaining('哪一条')
    });
  });
});
