import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import type { PluginBackgroundTask } from '@packages/mica-plugin/PluginBackground.js';
import type { PluginPanelHandler } from '@packages/mica-plugin/index.js';
import { probeTarget } from './probes.js';
import setup from './index.js';
import type { EnvironmentReadyTool } from './Tool.js';
import { deferred, web } from './test-harness.js';
import type { ProbeStatus } from './state.js';

vi.mock('./probes.js', () => ({ probeTarget: vi.fn() }));
beforeEach(() => {
  vi.mocked(probeTarget)
    .mockReset()
    .mockResolvedValue({ checkedAt: Date.now(), reachable: true, healthy: true, statusCode: 200 });
});

function context(singleRuntime = false) {
  let current = 'session-a';
  const runtimeOwner = {};
  const data = new Map<string, unknown>();
  const disposers: (() => void)[] = [];
  let task!: PluginBackgroundTask;
  let tool!: EnvironmentReadyTool;
  let panel!: PluginPanelHandler;
  const disposeTool = vi.fn();
  const disposeBackground = vi.fn();
  const disposePanel = vi.fn();
  const registerTool = vi.fn((value: EnvironmentReadyTool) => {
    tool = value;
    return { dispose: disposeTool };
  });
  const settings = { intervalSeconds: '30', telemetry: 'true' };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx = {
    pluginId: 'environment-ready',
    session: {
      captureOwner: () => (singleRuntime ? runtimeOwner : current),
      describe: (owner?: unknown) => ({ id: singleRuntime ? current : String(owner ?? current) }),
    },
    sessionState: {
      get: (owner?: unknown) => data.get(singleRuntime ? current : String(owner ?? current)),
      set: (value: unknown, owner?: unknown) => data.set(singleRuntime ? current : String(owner ?? current), value),
    },
    settings: { get: () => settings },
    tools: { register: registerTool },
    desktop: {
      panel: (handler: PluginPanelHandler) => {
        panel = handler;
        return { dispose: disposePanel };
      },
    },
    background: {
      register: (value: PluginBackgroundTask) => {
        task = value;
        return { dispose: disposeBackground };
      },
    },
    health: { report: vi.fn() },
    logger,
    onDispose: (callback: () => void) => disposers.push(callback),
  } as unknown as PluginContext;
  setup(ctx);
  return {
    ctx,
    task,
    tool,
    panel,
    data,
    logger,
    registerTool,
    settings,
    disposers,
    disposeTool,
    disposeBackground,
    disposePanel,
    setCurrent: (value: string) => {
      current = value;
    },
  };
}

describe('plugin host wiring', () => {
  it('discards a late probe when one runtime resumes a copied session and ignores owner arguments', async () => {
    const h = context(true);
    await h.tool.execute({ operation: 'set', targets: [web] });
    const pending = deferred<ProbeStatus>();
    vi.mocked(probeTarget).mockImplementationOnce(() => pending.promise);
    const check = h.task.run({ signal: new AbortController().signal, tick: 1 });
    h.data.set('session-b', structuredClone(h.data.get('session-a')));
    h.setCurrent('session-b');
    pending.resolve({ checkedAt: Date.now(), reachable: true, healthy: true, statusCode: 200 });
    await check;
    expect(h.data.get('session-a')).toMatchObject({ statuses: {} });
    expect(h.data.get('session-b')).toMatchObject({ statuses: {} });
    expect(h.ctx.health.report).not.toHaveBeenCalled();
  });
  it('registers a primary-only MicaTool, optional panel and bounded dynamic background interval', async () => {
    const h = context();
    expect(h.registerTool).toHaveBeenCalledWith(h.tool, { icon: '🔌', primaryAgentOnly: true });
    expect(h.task.immediate).not.toBe(true);
    expect((h.task.every as () => number)()).toBe(30_000);
    h.settings.intervalSeconds = '1';
    expect((h.task.every as () => number)()).toBe(10_000);
    h.settings.intervalSeconds = '1000';
    expect((h.task.every as () => number)()).toBe(300_000);
    await h.task.run({ signal: new AbortController().signal, tick: 1 });
    expect(probeTarget).not.toHaveBeenCalled();
    await h.tool.execute({ operation: 'set', targets: [web] });
    expect(probeTarget).not.toHaveBeenCalled();
    await h.task.run({ signal: new AbortController().signal, tick: 2 });
    expect(probeTarget).toHaveBeenCalledOnce();
    expect(JSON.parse(await h.tool.execute({ operation: 'list' })).targets[0].reachable).toBe(true);
  });
  it('aborts in-flight work and disposes all registrations when unloaded', async () => {
    const h = context();
    let signal: AbortSignal | undefined;
    vi.mocked(probeTarget).mockImplementation(async (_target, value) => {
      signal = value;
      return new Promise((resolve) =>
        value.addEventListener(
          'abort',
          () => resolve({ checkedAt: Date.now(), reachable: false, healthy: null, error: 'aborted' }),
          { once: true },
        ),
      );
    });
    await h.tool.execute({ operation: 'set', targets: [web] });
    const check = h.task.run({ signal: new AbortController().signal, tick: 1 });
    h.disposers.forEach((dispose) => dispose());
    await check;
    expect(signal?.aborted).toBe(true);
    expect(h.disposeTool).toHaveBeenCalledOnce();
    expect(h.disposeBackground).toHaveBeenCalledOnce();
    expect(h.disposePanel).toHaveBeenCalledOnce();
    expect(h.data.get('session-a')).toMatchObject({ statuses: {} });
  });
  it('honors telemetry opt-out and emits only metadata without endpoint or error payloads', async () => {
    const h = context();
    await h.tool.execute({ operation: 'set', targets: [web] });
    await h.tool.execute({ operation: 'check' });
    expect(h.logger.info).toHaveBeenCalled();
    expect(JSON.stringify(h.logger.info.mock.calls)).not.toContain(web.kind === 'http' ? web.url : '');
    expect(JSON.stringify(h.logger.info.mock.calls)).not.toContain('session-a');
    const count = h.logger.info.mock.calls.length;
    h.settings.telemetry = 'false';
    await h.tool.execute({ operation: 'clear' });
    expect(h.logger.info).toHaveBeenCalledTimes(count);
  });
});
