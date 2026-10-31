import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { micaCommands } from '@packages/mica-commands/index.js';
import { micaPlugin, type AgentObservationEvent, type PluginContext } from '@packages/mica-plugin/index.js';
import { toolResultToText, type MicaTool } from '@packages/mica-tools/index.js';
import setup from './index.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

function harness() {
  const home = mkdtempSync(join(tmpdir(), 'mica-harness-review-plugin-'));
  const hooks = new micaPlugin.HookRegistry();
  const commands = new micaCommands.CommandRegistry();
  const tools: MicaTool[] = [];
  const settings: Record<string, string> = { enabled: 'true', captureContent: 'true' };
  const disposers: Array<() => void | Promise<void>> = [];
  const reports: unknown[] = [];
  const owner = {};
  const readSettings = vi.fn(() => settings);
  const describeSession = vi.fn(() => ({ id: 'session-test', title: 'Task', cwd: '/workspace/test' }));
  const ctx = {
    pluginId: 'harness-review',
    paths: { config: home, home, plugins: join(home, 'plugins') },
    hooks,
    commands,
    session: { describe: describeSession },
    settings: { get: readSettings, validate: () => [], path: null },
    tools: {
      register(tool: MicaTool) {
        tools.push(tool);
        return { dispose: () => tools.splice(tools.indexOf(tool), 1) };
      },
    },
    ui: { showMessage: vi.fn() },
    health: { report: (data: unknown) => reports.push(data) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onDispose: (dispose: () => void | Promise<void>) => disposers.push(dispose),
  } as unknown as PluginContext;
  setup(ctx);
  const emit = (event: Omit<AgentObservationEvent, 'owner' | 'runId' | 'timestamp'>) =>
    hooks.emit('agent:observe', { owner, runId: 1, timestamp: new Date().toISOString(), ...event });
  const start = () =>
    emit({
      type: 'run:start',
      input: 'Read a missing file',
      config: {
        providerId: 'test',
        protocol: 'openai_chat_completions',
        model: 'test',
        effort: 'none',
        role: 'default',
      },
    } as never);
  const finish = () => emit({ type: 'run:finish', outcome: 'completed', elapsedMs: 20 } as never);
  const review = async () => JSON.parse(toolResultToText(await tools[0]!.execute({ action: 'list' })));
  cleanup.push(async () => {
    for (const dispose of disposers.reverse()) await dispose();
    rmSync(home, { recursive: true, force: true });
  });
  return {
    home,
    hooks,
    commands,
    tools,
    settings,
    reports,
    emit,
    start,
    finish,
    review,
    readSettings,
    describeSession,
  };
}

describe('harness-review plugin', () => {
  it('reads settings and session metadata once per run across a high-frequency event stream', async () => {
    const h = harness();
    await h.start();
    for (let index = 0; index < 500; index++) await h.emit({ type: 'request:start', messageCount: index } as never);
    await h.finish();
    expect(h.readSettings).toHaveBeenCalledTimes(1);
    expect(h.describeSession).toHaveBeenCalledTimes(1);
    expect((await h.review()).runs[0].requestCount).toBe(500);
  });
  it('automatically records evidence and exposes it through tool and command without reflection calls', async () => {
    const h = harness();
    await h.start();
    await h.emit({ type: 'request:start', messageCount: 1 } as never);
    await h.emit({ type: 'tool:call', id: 'c1', name: 'read_file', args: '{"file_path":"missing"}' } as never);
    await h.emit({
      type: 'tool:result',
      id: 'c1',
      name: 'read_file',
      result: '工具 read_file 执行失败：\nENOENT: no such file',
    } as never);
    await h.finish();
    const report = await h.review();
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0].outcome).toBe('completed');
    expect(report.findings.length).toBeGreaterThan(0);
    const result = await h.commands.execute('/harness-review list');
    expect(result.ok).toBe(true);
    expect(result).toHaveProperty('data');
    expect(h.reports).toEqual([]);
  });

  it('respects disabling capture and finishes an already active run after a settings change', async () => {
    const h = harness();
    h.settings.enabled = 'false';
    await h.start();
    await h.finish();
    expect((await h.review()).runs).toHaveLength(0);
    h.settings.enabled = 'true';
    await h.start();
    h.settings.enabled = 'false';
    await h.finish();
    expect((await h.review()).runs[0].outcome).toBe('completed');
  });

  it('requires an explicit reason and workspace-visible finding for assessments', async () => {
    const h = harness();
    const tool = h.tools[0]!;
    expect(JSON.parse(toolResultToText(await tool.execute({ action: 'unknown' })))).toMatchObject({ ok: false });
    expect(
      JSON.parse(toolResultToText(await tool.execute({ action: 'assess', id: 'x', status: 'accepted' }))).error,
    ).toContain('note');
    expect(
      JSON.parse(
        toolResultToText(await tool.execute({ action: 'assess', id: 'x', status: 'accepted', note: 'user reviewed' })),
      ).error,
    ).toContain('当前工作区');
    expect((await h.commands.execute('/harness-review unknown')).ok).toBe(false);
  });

  it('registers a capability-changing tool as non-readonly', () => {
    const h = harness();
    expect(h.tools[0]!.name).toBe('harness_review');
    expect(h.tools[0]!.readOnly).toBe(false);
  });
});
