import { describe, expect, it, vi } from 'vitest';
import { EnvironmentReadyTool } from './Tool.js';
import { harness, web } from './test-harness.js';

function toolHarness() {
  const h = harness();
  return { ...h, tool: new EnvironmentReadyTool(h.controller) };
}

describe('environment_ready tool', () => {
  it('sets/replaces, lists, removes and clears task targets without implicit checks', async () => {
    const h = toolHarness();
    expect(h.tool.name).toBe('environment_ready');
    expect(h.tool.readOnly).toBe(false);
    const set = JSON.parse(await h.tool.execute({ operation: 'set', targets: [web] }));
    expect(set.targets[0]).toMatchObject({
      id: 'web',
      status: 'unknown',
      checkedAt: null,
      reachable: null,
      healthy: null,
    });
    expect(h.probe).not.toHaveBeenCalled();
    await h.tool.execute({ operation: 'set', targets: [{ ...web, id: 'api' }] });
    expect(
      JSON.parse(await h.tool.execute({ operation: 'list' })).targets.map((entry: { id: string }) => entry.id),
    ).toEqual(['api']);
    await h.tool.execute({ operation: 'remove', id: 'api' });
    expect(h.controller.read(h.ownerA).targets).toEqual([]);
    await h.tool.execute({ operation: 'set', targets: [web] });
    await h.tool.execute({ operation: 'clear' });
    expect(h.controller.read(h.ownerA).targets).toEqual([]);
  });
  it('checks explicitly and makes old or restored health null rather than live healthy', async () => {
    const h = toolHarness();
    await h.tool.execute({ operation: 'set', targets: [web] });
    const check = JSON.parse(await h.tool.execute({ operation: 'check', id: 'web' }));
    expect(check.check).toEqual({ outcome: 'success', count: 1 });
    expect(check.targets[0]).toMatchObject({
      checkedAt: 1000,
      status: 'fresh',
      reachable: true,
      healthy: true,
      lastStatusCode: 200,
    });
    h.setNow(61_001);
    expect(JSON.parse(await h.tool.execute({ operation: 'list' })).targets[0]).toMatchObject({
      status: 'stale',
      reachable: null,
      healthy: null,
    });
  });
  it('keeps invalid registrations atomic and rejects missing ids and invalid operations', async () => {
    const h = toolHarness();
    await h.tool.execute({ operation: 'set', targets: [web] });
    for (const input of [
      { operation: 'set', targets: [{ ...web, url: 'https://remote.test' }] },
      { operation: 'set', targets: [web, web] },
      { operation: 'remove' },
      { operation: 'check', id: 1 },
      { operation: 'check', id: 'missing' },
      { operation: 'start' },
    ])
      await expect(h.tool.execute(input)).rejects.toThrow();
    expect(h.controller.read(h.ownerA).targets).toEqual([web]);
    expect(h.probe).not.toHaveBeenCalled();
    expect(JSON.stringify(h.track.mock.calls)).not.toContain('https://remote.test');
  });
  it('passes tool context to capture and abort signal to the check', async () => {
    const h = toolHarness();
    const capture = vi.spyOn(h.controller, 'capture');
    await h.tool.execute({ operation: 'set', targets: [web] });
    const signal = new AbortController().signal;
    const context = { arbitrary: 'context' };
    await h.tool.execute({ operation: 'check' }, { context, signal });
    expect(capture).toHaveBeenLastCalledWith(context);
    expect(h.probe).toHaveBeenCalledWith(web, expect.any(AbortSignal));
  });
});
