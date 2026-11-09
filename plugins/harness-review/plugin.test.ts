import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { micaCommands } from '@packages/mica-commands/index.js';
import {
  micaPlugin,
  type AgentObservationEvent,
  type PluginActionHandler,
  type PluginContext,
  type PluginStatusFile,
} from '@packages/mica-plugin/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { toolResultToText, type MicaTool } from '@packages/mica-tools/index.js';
import setup from './index.js';
import { CLASSIFIER_VERSION } from './engine.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function harness(
  options: {
    home?: string;
    cwd?: string;
    mode?: 'session' | 'one-shot';
    tools?: false;
    session?: false;
    pluginStatus?: () => PluginStatusFile;
  } = {},
) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'mica-harness-review-plugin-'));
  const hooks = new micaPlugin.HookRegistry();
  const commands = new micaCommands.CommandRegistry();
  const tools: MicaTool[] = [];
  const settings: Record<string, string> = { enabled: 'true', captureContent: 'true' };
  const disposers: Array<() => void | Promise<void>> = [];
  const reports: unknown[] = [];
  const actions = new Map<string, PluginActionHandler>();
  const owner = {};
  const events = new micaRuntime.RuntimeEventBus();
  const readSettings = vi.fn(() => settings);
  const describeSession = vi.fn(() => ({ id: 'session-test', title: 'Task', cwd: options.cwd ?? '/workspace/test' }));
  const ctx = {
    pluginId: 'harness-review',
    paths: { config: home, home, plugins: join(home, 'plugins') },
    hooks,
    commands,
    events,
    agent: { mode: options.mode ?? 'session' },
    pluginStatus: options.pluginStatus,
    session: options.session === false ? undefined : { describe: describeSession },
    settings: { get: readSettings, validate: () => [], path: null },
    tools:
      options.tools === false
        ? undefined
        : {
            register(tool: MicaTool) {
              tools.push(tool);
              return { dispose: () => tools.splice(tools.indexOf(tool), 1) };
            },
          },
    ui: { showMessage: vi.fn() },
    actions: {
      register(key: string, handler: PluginActionHandler) {
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
    if (!options.home) rmSync(home, { recursive: true, force: true });
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

  it('raises a sidebar prompt for recurring candidates without registered assessments', async () => {
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
    expect(String(data.attention!.text)).toContain('候选');
    expect(String(data.attention!.text)).toContain('尚未登记评估');
    expect(String(data.attention!.text)).not.toContain('没有人复盘');
    expect(data.attention!.action).toBe('open-review');
    expect(String(data.openFindings)).toContain('项');
  });

  it('surfaces new evidence after validation and explicitly regressed findings without changing the verdict', async () => {
    const h = harness();
    const fail = async () => {
      await h.start();
      await h.emit({ type: 'tool:call', id: 'read', name: 'read_file', args: '{}' } as never);
      await h.emit({ type: 'tool:result', id: 'read', name: 'read_file', result: 'Error: ENOENT' } as never);
      await h.finish();
    };
    await fail();
    const id = (await h.review()).findings[0].id;
    const assess = async (status: string) =>
      JSON.parse(
        toolResultToText(
          await h.tools[0].execute({
            action: 'assess',
            id,
            status,
            note: `External review: ${status}`,
          }),
        ),
      );
    expect((await assess('validated')).recorded).toBe(true);
    await fail();
    await h.hooks.emit('turn:after', { outcome: 'completed' });
    const data = await waitForStatus(h.home, (value) => String(value.attention?.text).includes('待复核'));
    expect(data.attention?.action).toBe('open-review');
    expect((await h.review()).findings[0]).toMatchObject({
      status: 'validated',
      reviewNeeded: { reason: 'new-evidence', occurrences: 1, runs: 1 },
    });
    await assess('regressed');
    expect(
      String(
        (await waitForStatus(h.home, (value) => String(value.attention?.text).includes('待复核'))).attention?.text,
      ),
    ).toContain('待复核');
  });

  // 提示点必须点得动：动作只把提示词放进输入框，不替用户按发送。
  it('opens the review through a new session without sending it', async () => {
    const h = harness();
    const result = await h.actions.get('open-review')!({ values: {} });
    if (!result?.newSession) throw new Error('Expected a new review session');
    expect(result.newSession.prompt).toContain('harness_review');
    expect(result.newSession.cwd).toBe('/workspace/test');
    expect(result.newSession.send).toBe(false);
    expect(result.newSession.prompt).toContain('不要代我登记 assess');
    const selected = await h.actions.get('open-review')!({ values: {}, cwd: '/workspace/selected' });
    expect(selected).toMatchObject({ newSession: { cwd: '/workspace/selected', send: false } });
  });

  it.each([{ tools: false as const }, { session: false as const }, { tools: false as const, session: false as const }])(
    'registers only the action when recording capabilities are absent: %j',
    async (missing) => {
      const h = harness(missing);
      expect(h.tools).toHaveLength(0);
      expect((await h.commands.execute('/harness-review list')).ok).toBe(false);
      expect(h.readSettings).not.toHaveBeenCalled();
      expect(h.describeSession).not.toHaveBeenCalled();
      const result = await h.actions.get('open-review')!({ values: {}, cwd: '/workspace/action' });
      expect(result).toMatchObject({ newSession: { cwd: '/workspace/action', send: false } });
      await h.start();
      await h.finish();
      await h.hooks.emit('turn:after', { outcome: 'completed' });
      expect(existsSync(join(h.home, 'plugin-data', 'harness-review'))).toBe(false);
    },
  );

  it('does not invent a workspace from the process cwd for an action-only host', async () => {
    const h = harness({ tools: false, session: false });
    const result = await h.actions.get('open-review')!({ values: {} });
    expect(result).toEqual({ message: '无法确定复盘工作区，请从工作区会话中打开复盘。' });
    expect(existsSync(join(h.home, 'plugin-data', 'harness-review'))).toBe(false);
  });

  it('refreshes machine-wide status after scoped manual rebuild and prune without claiming global rules were rebuilt', async () => {
    const first = harness({ mode: 'one-shot', cwd: '/workspace/first' });
    const second = harness({ mode: 'one-shot', home: first.home, cwd: '/workspace/second' });
    for (const h of [first, second]) {
      await h.start();
      await h.finish();
      const [run] = (await h.review()).runs;
      await writeFile(
        join(h.home, 'plugin-data', 'harness-review', 'runs', run.id, 'summary.json'),
        JSON.stringify({
          ...run,
          findings: [],
          startedAt: '2020-01-01T00:00:00.000Z',
          finishedAt: '2020-01-01T00:00:01.000Z',
        }),
      );
    }
    const root = join(first.home, 'plugin-data', 'harness-review');
    const stateFile = join(root, 'state.json');
    const readData = async () => JSON.parse(await readFile(join(root, 'data.json'), 'utf8'));
    const readState = async () => JSON.parse(await readFile(stateFile, 'utf8'));
    await writeFile(stateFile, JSON.stringify({ classifierVersion: CLASSIFIER_VERSION - 1, lastStatusAt: 123 }));
    const rebuilt = await first.commands.execute('/harness-review rebuild');
    expect(rebuilt.ok).toBe(true);
    expect(await readState()).toMatchObject({ classifierVersion: CLASSIFIER_VERSION - 1, lastStatusAt: 123 });
    expect(await readData()).toMatchObject({
      runs: '2 次',
      scope: '所有工作区',
      rebuilt: (await readState()).lastRebuildAt,
    });
    expect((await first.review()).totalRuns).toBe(1);
    expect((await second.review()).totalRuns).toBe(1);

    await writeFile(
      stateFile,
      JSON.stringify({ ...(await readState()), classifierVersion: CLASSIFIER_VERSION, lastStatusAt: 456 }),
    );
    expect((await second.commands.execute('/harness-review rebuild')).ok).toBe(true);
    expect(await readState()).toMatchObject({ classifierVersion: CLASSIFIER_VERSION, lastStatusAt: 456 });
    expect(await readData()).toMatchObject({
      runs: '2 次',
      scope: '所有工作区',
      rebuilt: (await readState()).lastRebuildAt,
    });
    expect((await first.commands.execute('/harness-review prune 1')).ok).toBe(true);
    expect(await readData()).toMatchObject({ runs: '1 次', scope: '所有工作区' });
    expect((await first.review()).totalRuns).toBe(0);
    expect((await second.review()).totalRuns).toBe(1);
  });

  it('serializes status refreshes from multiple hosts and keeps their latest shared state', async () => {
    const first = harness({ mode: 'one-shot', cwd: '/workspace/first' });
    const second = harness({ mode: 'one-shot', home: first.home, cwd: '/workspace/second' });
    await first.start();
    await first.finish();
    await second.start();
    await second.finish();
    const root = join(first.home, 'plugin-data', 'harness-review');
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'state.json'),
      JSON.stringify({ classifierVersion: CLASSIFIER_VERSION + 1, lastStatusAt: 123 }),
    );
    const results = await Promise.all([
      first.commands.execute('/harness-review rebuild'),
      second.commands.execute('/harness-review rebuild'),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(JSON.parse(await readFile(join(root, 'state.json'), 'utf8'))).toMatchObject({
      classifierVersion: CLASSIFIER_VERSION + 1,
      lastStatusAt: 123,
    });
    expect(JSON.parse(await readFile(join(root, 'data.json'), 'utf8'))).toMatchObject({
      runs: '2 次',
      scope: '所有工作区',
    });
  });

  it('refreshes old workspace-only status on startup even when classifier rules are current', async () => {
    const seed = harness({ mode: 'one-shot', cwd: '/workspace/seed' });
    await seed.start();
    await seed.finish();
    await seed.review();
    const root = join(seed.home, 'plugin-data', 'harness-review');
    await writeFile(
      join(root, 'state.json'),
      JSON.stringify({ classifierVersion: CLASSIFIER_VERSION, lastStatusAt: Date.now() }),
    );
    await writeFile(join(root, 'data.json'), JSON.stringify({ runs: 'wrong workspace count' }));
    harness({ home: seed.home, cwd: '/workspace/other' });
    const data = await waitForStatus(seed.home, (value) => (value as Record<string, unknown>).scope === '所有工作区');
    expect(data).toMatchObject({ runs: '1 次', scope: '所有工作区' });
  });

  it('takes the host plugin snapshot only at run:start after the remaining plugins were assembled', async () => {
    const plugins: PluginStatusFile['plugins'] = [{ id: 'harness-review', status: 'loaded' }];
    const pluginStatus = vi.fn(
      (): PluginStatusFile => ({ host: 'app-server', root: '/plugins', updatedAt: '', plugins, loadFailed: [] }),
    );
    const h = harness({ pluginStatus });
    expect(pluginStatus).not.toHaveBeenCalled();
    plugins.push({ id: 'later-plugin', status: 'loaded' });
    await h.start();
    for (let i = 0; i < 50; i++) await h.emit({ type: 'request:start', messageCount: i } as never);
    plugins.push({ id: 'next-run-only', status: 'loaded' });
    await h.finish();
    expect((await h.review()).runs[0].plugins).toMatchObject({ host: 'app-server', loaded: 2 });
    expect(pluginStatus).toHaveBeenCalledTimes(1);
    await h.start();
    await h.finish();
    expect((await h.review()).runs.map((run: { plugins: { loaded: number } }) => run.plugins.loaded).sort()).toEqual([
      2, 3,
    ]);
    expect(pluginStatus).toHaveBeenCalledTimes(2);
  });

  // 常驻任务不在任何一轮里：它的失败走 plugin:observe，由 recorder 单独落盘与聚合。
  it('records a plugin background failure forwarded through plugin:observe', async () => {
    const h = harness();
    h.hooks.notify('plugin:observe', {
      pluginId: 'mobile-relay',
      timestamp: new Date().toISOString(),
      type: 'background:failed',
      taskId: 'poll',
      tick: 1,
      failures: 1,
      error: 'ECONNREFUSED 127.0.0.1:8787',
    });
    expect((await h.review()).pluginFailures).toEqual([
      {
        pluginId: 'mobile-relay',
        taskId: 'poll',
        count: 1,
        lastAt: expect.any(String),
        lastError: 'ECONNREFUSED 127.0.0.1:8787',
      },
    ]);
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
