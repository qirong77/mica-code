import { readFileSync } from 'node:fs';
import { parsePluginManifest } from '@packages/mica-plugin/PluginManifest.js';
import { describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { HookRegistry } from '@packages/mica-plugin/HookRegistry.js';
import type { AgentObservationEvent } from '@packages/mica-plugin/AgentObservation.js';
import type { PluginPanelHandler } from '@packages/mica-plugin/PluginPanel.js';
import setup from './index.js';
import { TaskDeliveryTool } from './Tool.js';
import { DeliveryEvidence, commandExitCode } from './evidence.js';
import { sanitizeDelivery } from './state.js';

const output =
  '[command]\ncommand: "bun test"\ncwd: /repo\nshell: /bin/sh\ntimeout_ms: 1000\nduration_ms: 10\nexit_code: 0\nsignal: null\ntimed_out: false\naborted: false\nstream_output_truncated: false\nstdout_truncated: false\nstderr_truncated: false\n\n[stdout]\nTests passed\n\n[stderr]\n(empty)';
function harness() {
  const owners = [{}, {}];
  let active = owners[0];
  const states = new Map<unknown, unknown>();
  const hooks = new HookRegistry();
  const logs = vi.fn();
  const disposers: Array<() => void> = [];
  let tool!: TaskDeliveryTool;
  let panel!: PluginPanelHandler;
  const register = vi.fn((value: TaskDeliveryTool, _options?: unknown) => {
    tool = value;
    return { dispose: vi.fn() };
  });
  const settings = { telemetry: 'true' };
  const ctx = {
    pluginId: 'task-delivery',
    hooks,
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
    hooks,
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
function event(owner: object, type: string, extra: object = {}, runId = 1): AgentObservationEvent {
  return { owner, type, runId, timestamp: '2026-04-01T00:00:00.000Z', ...extra } as AgentObservationEvent;
}
describe('Task Delivery integration', () => {
  it('registers primary-only and keeps per-owner state even when selection changes', async () => {
    const h = harness();
    expect(h.register.mock.calls[0]?.[1]).toEqual({ primaryAgentOnly: true, icon: '📦' });
    h.select(1);
    await h.tool.execute({ action: 'set', summary: 'private-a' }, { context: h.owners[0] } as never);
    expect(h.states.has(h.owners[1])).toBe(false);
    h.select(0);
    const view = await h.panel.view({ role: '' });
    expect(view.cards).toHaveLength(1);
    expect(JSON.stringify(h.logs.mock.calls)).not.toContain('private-a');
  });
  it('guards all old actions, persists dismissal and invalidates it on update', async () => {
    const h = harness();
    await h.tool.execute({ action: 'set', summary: 'first' });
    const first = sanitizeDelivery(h.states.get(h.owners[0]))!;
    await h.panel.action({ action: 'dismiss', key: first.revision });
    expect((await h.panel.view({ role: '' })).cards).toEqual([]);
    expect((await h.panel.view({ role: '' })).sections?.length).toBeGreaterThan(0);
    await h.tool.execute({ action: 'set', summary: 'second' });
    const stale = await h.panel.action({ action: `clear:${first.revision}` });
    expect(stale).toHaveProperty('message', '交付记录已变化，请刷新后再操作。');
    expect(sanitizeDelivery(h.states.get(h.owners[0]))?.summary).toBe('second');
    expect((await h.panel.view({ role: '' })).cards).toHaveLength(1);
    const next = sanitizeDelivery(h.states.get(h.owners[0]))!;
    await h.panel.action({ action: `impression:${next.revision}` });
    expect(h.logs.mock.calls.some((call) => call[1]?.event === 'impression')).toBe(true);
    await h.panel.action({ action: `clear:${next.revision}` });
    expect((await h.panel.view({ role: '' })).cards).toEqual([]);
  });
  it('hides the previous card at the next turn without losing its report or affecting another owner', async () => {
    const h = harness();
    await h.tool.execute({ action: 'set', summary: 'first' });
    h.select(1);
    await h.tool.execute({ action: 'set', summary: 'other' });
    await h.hooks.emit('turn:before', { owner: h.owners[0] });
    expect((await h.panel.view({ role: '' })).cards).toHaveLength(1);
    h.select(0);
    expect((await h.panel.view({ role: '' })).cards).toEqual([]);
    expect(JSON.parse(await h.tool.execute({ action: 'read' })).delivery.summary).toBe('first');
    await h.tool.execute({ action: 'set', summary: 'new' });
    expect((await h.panel.view({ role: '' })).cards).toHaveLength(1);
  });
  it('shows complete key report fields and evidence in the first details dialog', async () => {
    const h = harness();
    const owner = h.owners[0]!;
    await h.hooks.emit('turn:before', { owner });
    await h.hooks.emit('agent:observe', event(owner, 'run:start'));
    await h.hooks.emit('agent:observe', event(owner, 'tool:call', { id: 'actual', name: 'run_shell' }));
    await h.hooks.emit('agent:observe', event(owner, 'tool:result', { id: 'actual', name: 'run_shell', result: output }));
    await h.tool.execute({ action: 'set', summary: 'result', changedFiles: ['src/test.ts'], validationClaims: ['tests pass'], deploymentReport: 'not deployed', evidenceIds: ['actual'], reports: { code: 'done', validation: 'done', build: 'skipped', deploy: 'skipped' } });
    const revision = sanitizeDelivery(h.states.get(owner))!.revision;
    const result = await h.panel.action({ action: 'details', key: revision });
    expect(result).toBeTruthy();
    if (!result) throw new Error('Expected details dialog');
    const dialog = result.dialog!;
    expect(dialog.markdown).toContain('result');
    expect(dialog.markdown).toContain('src/test');
    expect(dialog.markdown).toContain('tests pass');
    expect(dialog.markdown).toContain('not deployed');
    expect(dialog.markdown).toContain('actual');
    expect(dialog.markdown).toContain('退出码 0');
    expect(dialog.markdown).toContain('未独立验证');
    expect(dialog.panel).toBeUndefined();
  });
  it('accepts only observed current-run primary results, never raw output or model proof', async () => {
    const h = harness();
    const owner = h.owners[0]!;
    await h.hooks.emit('turn:before', { owner });
    await h.hooks.emit('agent:observe', event(owner, 'run:start'));
    await h.hooks.emit('agent:observe', event(owner, 'tool:call', { id: 'actual', name: 'run_shell', args: '{}' }));
    await h.hooks.emit(
      'agent:observe',
      event(owner, 'tool:result', { id: 'actual', name: 'run_shell', result: output }),
    );
    await h.hooks.emit(
      'agent:observe',
      event(h.owners[1]!, 'tool:result', { id: 'other', name: 'run_shell', result: output }),
    );
    await h.tool.execute({
      action: 'set',
      summary: 'done',
      validationClaims: ['All tests pass'],
      evidenceIds: ['actual', 'invented', 'other'],
    });
    const saved = sanitizeDelivery(h.states.get(owner))!;
    expect(saved.evidence).toEqual([
      {
        id: 'actual',
        tool: 'run_shell',
        runId: 1,
        observedAt: '2026-04-01T00:00:00.000Z',
        kind: 'command-exit',
        exitCode: 0,
      },
    ]);
    expect(JSON.stringify(saved)).not.toContain('Tests passed');
    expect(JSON.stringify(await h.panel.view({ role: '' }))).toContain('未独立验证');
    await h.hooks.emit('turn:before', { owner });
    await h.hooks.emit('agent:observe', event(owner, 'run:start', {}, 2));
    await h.tool.execute({ action: 'set', summary: 'new', evidenceIds: ['actual'] });
    expect(sanitizeDelivery(h.states.get(owner))?.evidence).toEqual([]);
  });
  it('does not log content and supports disabling telemetry', async () => {
    const h = harness();
    h.settings.telemetry = 'false';
    await h.tool.execute({ action: 'set', summary: 'secret path /private/test' });
    expect(h.logs).not.toHaveBeenCalled();
    expect(h.tool.validateInput({ action: 'set', summary: 'x', evidence: [{ verified: true }] }).valid).toBe(false);
    await expect(
      h.tool.execute({ action: 'set', summary: 'x', reports: { validation: 'VERIFIED' } }),
    ).rejects.toThrow();
  });
  it('rejects corrupt state and oversized input without silently truncating', async () => {
    const h = harness();
    for (const input of [
      { action: 'read', summary: 'extra' },
      { action: 'set', summary: 'x'.repeat(3001) },
      { action: 'set', summary: 'x', changedFiles: ['bad\npath'] },
      { action: 'set', summary: 'x', validationClaims: Array(13).fill('x') },
      { action: 'set', summary: 'x', deploymentReport: '\u0000' },
    ]) {
      expect(h.tool.validateInput(input).valid).toBe(false);
      await expect(h.tool.execute(input)).rejects.toThrow();
    }
    h.states.set(h.owners[0], { version: 1, summary: 'fake', evidence: [{ verified: true }] });
    expect((await h.panel.view({ role: '' })).cards).toEqual([]);
  });
});
describe('runtime evidence parsing', () => {
  it('only trusts the metadata header and never parses stdout or arbitrary tool output', () => {
    expect(commandExitCode('run_shell', output)).toBe(0);
    expect(commandExitCode('ssh_run', output)).toBeUndefined();
    expect(commandExitCode('run_shell', 'exit_code: 0\nTests passed')).toBeUndefined();
    expect(commandExitCode('run_shell', output.replace('timed_out: false', 'timed_out: true'))).toBeUndefined();
    expect(commandExitCode('run_shell', output.replace('exit_code: 0', 'exit_code: 7'))).toBe(7);
  });
  it('rejects unmatched calls, cross-run results and helper runs', () => {
    const ledger = new DeliveryEvidence();
    const owner = {};
    ledger.begin(owner);
    ledger.observe(event(owner, 'run:start', { helper: { kind: 'plugin-llm' } }));
    ledger.observe(event(owner, 'tool:call', { id: 'x', name: 'run_shell' }));
    ledger.observe(event(owner, 'tool:result', { id: 'x', name: 'run_shell', result: output }));
    expect(ledger.select(owner, ['x'])).toEqual([]);
    ledger.observe(event(owner, 'run:start'));
    ledger.observe(event(owner, 'tool:result', { id: 'x', name: 'run_shell', result: output }));
    ledger.observe(event(owner, 'tool:call', { id: 'x', name: 'run_shell' }));
    ledger.observe(event(owner, 'tool:result', { id: 'x', name: 'run_shell', result: output }, 2));
    expect(ledger.select(owner, ['x'])).toEqual([]);
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
