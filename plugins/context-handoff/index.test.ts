import { readFileSync } from 'node:fs';
import { parsePluginManifest } from '@packages/mica-plugin/PluginManifest.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import type { PluginPanelHandler } from '@packages/mica-plugin/PluginPanel.js';
import setup from './index.js';
import { ContextHandoffTool } from './Tool.js';
import { ageMinutes, createCheckpoint, sanitizeCheckpoint, showCard } from './state.js';

function harness(initial?: unknown) {
  const owners = [{}, {}];
  let active = owners[0];
  const states = new Map<unknown, unknown>(initial ? [[owners[0], initial]] : []);
  const logs = vi.fn();
  const disposers: Array<() => void> = [];
  let tool!: ContextHandoffTool;
  let panel!: PluginPanelHandler;
  const settings = { telemetry: 'true', ageMinutes: '30' };
  const register = vi.fn((value: ContextHandoffTool, _options?: unknown) => {
    tool = value;
    return { dispose: vi.fn() };
  });
  const ctx = {
    pluginId: 'context-handoff',
    session: {
      captureOwner: (context?: unknown) => (owners.includes(context as object) ? context : active),
      describe: (owner = active) => ({ id: owner === owners[0] ? 'session-a' : 'session-b', title: '' }),
    },
    sessionState: {
      get: (owner = active) => states.get(owner),
      set: (value: unknown, owner = active) => {
        states.set(owner, value);
      },
      clear: (owner = active) => {
        states.delete(owner);
      },
    },
    settings: { get: () => settings },
    logger: { info: logs },
    desktop: {
      panel: (value: PluginPanelHandler) => {
        panel = value;
        return { dispose: vi.fn() };
      },
    },
    tools: { register },
    prompt: { section: () => ({ dispose: vi.fn() }) },
    onDispose: (fn: () => void) => disposers.push(fn),
  } as unknown as PluginContext;
  setup(ctx);
  return {
    owners,
    logs,
    states,
    settings,
    register,
    disposers,
    tool,
    panel,
    select: (index: number) => {
      active = owners[index];
    },
  };
}
afterEach(() => vi.useRealTimers());
describe('Context Handoff', () => {
  it('shows no compact empty/recent card; age threshold works on later views and restore', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const h = harness();
    expect((await h.panel.view({ role: '' })).cards).toEqual([]);
    await h.tool.execute({ action: 'set', checkpoint: 'implement next step', pending: ['verify first'] });
    expect((await h.panel.view({ role: '' })).cards).toEqual([]);
    expect((await h.panel.view({ role: '' })).sections?.length).toBe(4);
    vi.advanceTimersByTime(30 * 60000 - 1);
    expect((await h.panel.view({ role: '' })).cards).toEqual([]);
    vi.advanceTimersByTime(1);
    expect((await h.panel.view({ role: '' })).cards).toHaveLength(1);
    const restored = harness(h.states.get(h.owners[0]));
    expect((await restored.panel.view({ role: '' })).cards).toHaveLength(1);
    expect(JSON.stringify(await restored.panel.view({ role: '' }))).toContain('历史');
  });
  it('continue only composes a draft requiring cwd/git reverification and preserves source identity', async () => {
    const h = harness();
    h.select(1);
    await h.tool.execute(
      {
        action: 'set',
        checkpoint: 'historical work',
        completed: ['old tests passed'],
        pending: ['next'],
        cautions: ['user constraints'],
      },
      { context: h.owners[0] } as never,
    );
    expect(h.states.has(h.owners[1])).toBe(false);
    h.select(0);
    const saved = sanitizeCheckpoint(h.states.get(h.owners[0]))!;
    expect(saved.sourceSessionId).toBe('session-a');
    const result = await h.panel.action({ action: 'continue', key: saved.revision });
    expect(result).toHaveProperty('compose');
    expect(result).not.toHaveProperty('newSession');
    expect(result).not.toHaveProperty('send');
    expect((result as { compose: string }).compose).toContain('先重新核对当前 cwd、Git');
    expect((result as { compose: string }).compose).toContain('不要自动执行历史命令');
    expect(h.register.mock.calls[0]?.[1]).toMatchObject({ primaryAgentOnly: true });
    expect(JSON.stringify(h.logs.mock.calls)).not.toContain('historical work');
  });
  it('persists dismissal across setup and preserves history, while updates invalidate old actions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
    const h = harness();
    await h.tool.execute({ action: 'set', checkpoint: 'first' });
    const first = sanitizeCheckpoint(h.states.get(h.owners[0]))!;
    vi.advanceTimersByTime(31 * 60000);
    await h.panel.action({ action: 'dismiss', key: first.revision });
    const restored = harness(h.states.get(h.owners[0]));
    expect((await restored.panel.view({ role: '' })).cards).toEqual([]);
    expect(JSON.stringify(await restored.panel.view({ role: '' }))).toContain('first');
    await h.tool.execute({ action: 'set', checkpoint: 'second' });
    for (const action of ['continue', 'clear', 'dismiss', 'details', 'impression']) {
      const result = await h.panel.action({ action: `${action}:${first.revision}` });
      expect(result).toHaveProperty('message', '历史检查点已变化，请刷新后再操作。');
      expect(result).not.toHaveProperty('compose');
    }
    const next = sanitizeCheckpoint(h.states.get(h.owners[0]))!;
    expect(next.dismissedRevision).toBeUndefined();
    await h.panel.action({ action: `clear:${next.revision}` });
    expect(h.states.has(h.owners[0])).toBe(false);
  });
  it('rejects invalid fields, spoofed identity and oversized content without state writes', async () => {
    const h = harness();
    for (const input of [
      { action: 'set', checkpoint: 'x', savedAt: 'fake' },
      { action: 'read', pending: [] },
      { action: 'set', checkpoint: '' },
      { action: 'set', checkpoint: 'x'.repeat(3001) },
      { action: 'set', checkpoint: 'x', pending: Array(17).fill('x') },
      { action: 'set', checkpoint: 'x', cautions: ['\u0000'] },
    ]) {
      expect(h.tool.validateInput(input).valid).toBe(false);
      await expect(h.tool.execute(input)).rejects.toThrow();
    }
    expect(h.states.size).toBe(0);
    h.states.set(h.owners[0], { checkpoint: 'corrupt', savedAt: 'x' });
    expect((await h.panel.view({ role: '' })).cards).toEqual([]);
    h.settings.telemetry = 'false';
    h.logs.mockClear();
    await h.tool.execute({ action: 'set', checkpoint: 'private' });
    expect(h.logs).not.toHaveBeenCalled();
  });
  it('sanitizes restored state, bounds bytes, uses configured threshold and hides future timestamps', () => {
    const c = createCheckpoint(
      { checkpoint: 'x', completed: [], pending: [], cautions: [] },
      'source',
      new Date('2026-04-01T00:00:00.000Z'),
    );
    const now = Date.parse(c.savedAt);
    expect(showCard(c, 30, now - 1)).toBe(false);
    expect(showCard(c, 1, now + 60000)).toBe(true);
    expect(ageMinutes('garbage')).toBe(30);
    expect(ageMinutes('0')).toBe(30);
    expect(sanitizeCheckpoint({ ...c, savedAt: 'invalid' })).toBeUndefined();
    expect(sanitizeCheckpoint({ ...c, junk: 'x'.repeat(70000) })).toBeUndefined();
    expect(sanitizeCheckpoint({ ...c, junk: 'ignored' })).not.toHaveProperty('junk');
  });
});

it('declares desktop-only capabilities, telemetry and eager panel views', () => {
  const result = parsePluginManifest(JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf8')));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.manifest.requires).toEqual(
    expect.arrayContaining(['desktop', 'session', 'sessionState', 'tools', 'prompt', 'settings']),
  );
  expect(result.manifest.desktopPanel?.dynamicShortcuts).toBe(true);
  expect(result.manifest.settings?.find((setting) => setting.key === 'telemetry')?.default).toBe('true');
});
