import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { micaCommands } from '@packages/mica-commands/index.js';
import { micaPlugin, type AgentObservationEvent, type PluginContext } from '@packages/mica-plugin/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
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
  const actions = new Map<string, () => unknown>();
  const owner = {};
  const events = new micaRuntime.RuntimeEventBus();
  const readSettings = vi.fn(() => settings);
  const describeSession = vi.fn(() => ({ id: 'session-test', title: 'Task', cwd: '/workspace/test' }));
  const ctx = {
    pluginId: 'harness-review',
    paths: { config: home, home, plugins: join(home, 'plugins') },
    hooks,
    commands,
    events,
    session: { describe: describeSession },
    settings: { get: readSettings, validate: () => [], path: null },
    tools: {
      register(tool: MicaTool) {
        tools.push(tool);
        return { dispose: () => tools.splice(tools.indexOf(tool), 1) };
      },
    },
    ui: { showMessage: vi.fn() },
    actions: {
      register(key: string, handler: () => unknown) {
        actions.set(key, handler);
        return { dispose: () => actions.delete(key) };
      },
    },
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
    actions,
    events,
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

  it('records which host produced the run', async () => {
    const h = harness();
    await h.start();
    await h.finish();
    const [run] = (await h.review()).runs;
    expect(run.mode).toBe('session');
    expect(run.host).toBe('cli');
  });

  // 用户纠正由宿主经运行期事件发出：插件收到后暂存，下一次该会话的运行才带上它。
  it('carries a correction from the runtime event into the next run of that session', async () => {
    const h = harness();
    h.events.publish({ type: 'input:corrected', kind: 'edit', chars: 120 });
    await h.start();
    await h.finish();
    const report = await h.review();
    expect(report.runs[0].corrections).toEqual({ edit: 1, recall: 0, retry: 0 });
    expect(report.findings.filter((finding: { kind: string }) => finding.kind === 'user-correction')).toHaveLength(1);
    expect(h.reports).toEqual([]);
  });

  // 复盘页面没人打开过：把「重复出现又没人处理」浮到侧栏上，否则 record 只是堆积。
  it('raises a sidebar prompt for recurring problems nobody has reviewed yet', async () => {
    const h = harness();
    const failOnce = async () => {
      await h.start();
      await h.emit({ type: 'tool:call', id: 'c1', name: 'read_file', args: '{"file_path":"missing"}' } as never);
      await h.emit({
        type: 'tool:result',
        id: 'c1',
        name: 'read_file',
        result: '工具 read_file 执行失败：\nENOENT: no such file',
      } as never);
      await h.finish();
    };
    await failOnce();
    await failOnce();
    await h.hooks.emit('turn:after', { outcome: 'completed' });
    const data = await waitForStatus(h.home, (value) => Boolean(value.attention));
    expect(String(data.attention!.text)).toContain('重复出现');
    expect(data.attention!.action).toBe('open-review');
    expect(String(data.openFindings)).toContain('项');
  });

  // 提示点必须点得动：动作只把提示词放进输入框，不替用户按发送。
  it('opens the review through a new session without sending it', async () => {
    const h = harness();
    const result = h.actions.get('open-review')!() as { newSession: { prompt: string; cwd: string; send: boolean } };
    expect(result.newSession.prompt).toContain('harness_review');
    expect(result.newSession.cwd).toBe('/workspace/test');
    expect(result.newSession.send).toBe(false);
  });
});

async function waitForStatus(
  home: string,
  ready: (value: { attention?: { text?: string; action?: string }; openFindings?: string }) => boolean,
): Promise<{ attention?: { text?: string; action?: string }; openFindings?: string }> {
  const file = join(home, 'plugin-data', 'harness-review', 'data.json');
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      if (ready(parsed)) return parsed;
    } catch {
      // 还没写出来
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('data.json 没有在预期时间内带着提示点写出来');
}
