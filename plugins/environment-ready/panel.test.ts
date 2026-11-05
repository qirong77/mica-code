import { describe, expect, it } from 'vitest';
import type { PluginPanelView } from '@packages/mica-plugin/index.js';
import { createEnvironmentPanel } from './panel.js';
import { harness, web } from './test-harness.js';

const viewInput = { role: 'default' };

describe('aggregate card and detail actions', () => {
  it('has no compact card without registered services and never probes from view', async () => {
    const h = harness();
    const panel = createEnvironmentPanel(h.controller);
    expect((await panel.view(viewInput)).cards).toEqual([]);
    h.controller.replace([web, { id: 'db', label: 'DB', kind: 'tcp', host: '::1', port: 5432 }], h.ownerA);
    const view = await panel.view(viewInput);
    expect(view.cards).toHaveLength(1);
    expect(view.cards?.[0]?.actions).toHaveLength(3);
    expect(view.cards?.[0]?.summary).toContain('2 个未知');
    const rows = view.sections?.[0]?.table?.rows;
    expect(rows?.[0]?.actions?.map((action) => action.id)).toEqual(['open', 'check', 'remove']);
    expect(rows?.[1]?.actions?.map((action) => action.id)).toEqual(['check', 'remove']);
    expect(h.probe).not.toHaveBeenCalled();
  });
  it('uses current revision keys for cards, impression callbacks and per-target actions', async () => {
    const h = harness();
    const panel = createEnvironmentPanel(h.controller);
    h.controller.replace([web], h.ownerA);
    const old = await panel.view(viewInput);
    const card = old.cards![0]!;
    const row = old.sections![0]!.table!.rows[0]!;
    await panel.action({ action: card.impressionAction!, key: card.revision });
    expect(h.track).toHaveBeenLastCalledWith(
      'impression',
      expect.objectContaining({ surface: 'card' }),
      h.ownerA.handle,
    );
    expect(await panel.action({ action: 'open', key: row.key })).toEqual({
      openExternal: web.kind === 'http' ? web.url : '',
    });
    h.controller.replace([{ ...web, url: 'http://127.0.0.1:4000/' }], h.ownerA);
    expect(await panel.action({ action: 'remove', key: row.key })).toMatchObject({
      message: expect.stringContaining('已更新'),
    });
    expect(await panel.action({ action: 'check', key: row.key })).toMatchObject({
      message: expect.stringContaining('已更新'),
    });
    expect(await panel.action({ action: 'open', key: row.key })).toMatchObject({
      message: expect.stringContaining('已更新'),
    });
    expect(await panel.action({ action: 'dismiss', key: card.actions![2]!.key })).toMatchObject({
      message: expect.stringContaining('已更新'),
    });
    expect(h.controller.read(h.ownerA).targets).toHaveLength(1);
    expect(h.probe).not.toHaveBeenCalled();
  });
  it('keeps dismissal through polls and checks, restores through explicit panel reopen or config update', async () => {
    const h = harness();
    const panel = createEnvironmentPanel(h.controller);
    h.controller.replace([web], h.ownerA);
    const view = await panel.view(viewInput);
    await panel.action({ action: 'dismiss', key: view.cards![0]!.actions![2]!.key });
    expect((await panel.view(viewInput)).cards).toEqual([]);
    await panel.action({ action: 'check-all' });
    expect((await panel.view(viewInput)).cards).toEqual([]);
    await panel.action({ action: 'reopen' });
    expect((await panel.view(viewInput)).cards).toHaveLength(1);
    h.controller.dismiss(h.ownerA);
    h.controller.replace([web], h.ownerA);
    expect((await panel.view(viewInput)).cards).toHaveLength(1);
  });
  it('renders stale history as unknown, exact HTTP status and nonsemantic health language', async () => {
    const h = harness({ probe: async () => ({ checkedAt: 1000, reachable: true, healthy: false, statusCode: 503 }) });
    const panel = createEnvironmentPanel(h.controller);
    h.controller.replace([web], h.ownerA);
    await panel.action({ action: 'check-all' });
    const fresh = await panel.view(viewInput);
    expect(fresh.sections![0]!.table!.rows[0]!.cells.status?.text).toBe('可达 · HTTP 503');
    expect(fresh.sections![0]!.table!.rows[0]!.cells.status?.sub).toContain('不代表业务健康');
    h.setNow(61_001);
    const stale = await panel.view(viewInput);
    expect(stale.cards![0]!.tone).toBe('muted');
    expect(stale.sections![0]!.table!.rows[0]!.cells.status?.text).toContain('未知');
  });
  it('checks the explicit row only and supports details without initiating network work', async () => {
    const h = harness();
    const panel = createEnvironmentPanel(h.controller);
    h.controller.replace([web, { ...web, id: 'api', label: 'API' }], h.ownerA);
    const view = (await panel.view(viewInput)) as PluginPanelView;
    const details = await panel.action({ action: 'details', key: view.cards![0]!.actions![1]!.key });
    expect(details).toMatchObject({ dialog: { title: '任务环境', panel: { label: '管理服务' } } });
    expect(h.probe).not.toHaveBeenCalled();
    await panel.action({ action: 'check', key: view.sections![0]!.table!.rows[0]!.key });
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.probe).toHaveBeenCalledWith(expect.objectContaining({ id: 'web' }), expect.any(AbortSignal));
  });
});
