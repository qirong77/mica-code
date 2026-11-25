import { describe, expect, it, vi } from 'vitest';
import type { PluginPanelView } from '@packages/mica-plugin/index.js';
import {
  ABORT_ACTION,
  CLOSE_ACTION,
  CLOSE_IDLE_ACTION,
  COLLECT_ACTION,
  INSPECT_ACTION,
  createPanelHandler,
} from './panel.js';
import type { SubagentEntry, SubagentRegistry } from './registry.js';
import { SubagentTranscript } from './transcript.js';

const now = 1_000_000;

function entryOf(
  id: string,
  options: { busy?: boolean; closed?: boolean; text?: string; tokens?: number } = {},
): SubagentEntry {
  const transcript = new SubagentTranscript();
  transcript.recordUserInput('跑测试');
  transcript.apply({ method: 'turn/started', params: { turn: { id: 't1' } } });
  if (options.text) transcript.apply({ method: 'item/agentMessage/delta', params: { delta: options.text } });
  if (!options.busy) {
    transcript.apply({ method: 'turn/completed', params: { turn: { id: 't1', status: 'completed' } } });
  }
  transcript.usage.total = options.tokens ?? 0;
  transcript.lastActivityAt = now - 4_000;
  return {
    id,
    title: `任务 ${id}`,
    cwd: '/tmp',
    createdAt: now - 60_000,
    process: {
      closed: options.closed ?? false,
      transcript,
      abort: vi.fn(async () => true),
      describeFailure: () => '',
    },
    seenFinishedTurns: 0,
  } as unknown as SubagentEntry;
}

function registryOf(entries: SubagentEntry[], options: { events?: number; live?: number } = {}) {
  const close = vi.fn(async () => true);
  const closeMany = vi.fn(async () => entries.map((entry) => entry.id));
  const markRead = vi.fn();
  const registry = {
    list: () => entries,
    get: (id: string) => entries.find((entry) => entry.id === id) ?? null,
    close,
    closeMany,
    markRead,
    liveCount: options.live ?? entries.filter((entry) => !entry.process.closed).length,
    pendingEventCount: options.events ?? 0,
  } as unknown as SubagentRegistry;
  return { registry, close, closeMany, markRead };
}

describe('subagent panel', () => {
  /** 视图是同步给的；断言前把它收成同步值，省掉每处 `as`。 */
  const viewOf = (registry: SubagentRegistry): PluginPanelView =>
    createPanelHandler({ registry, now: () => now }).view({ role: 'default' }) as PluginPanelView;

  it('shows a status bar only when something is actually running', () => {
    const running = registryOf([entryOf('a', { busy: true })]);
    expect(viewOf(running.registry).statusBar).toMatchObject({ label: '1 个在跑' });

    const idle = registryOf([entryOf('a')]);
    // 没有子会话时不占一条常驻位置：那会变成一条永远「0 个在跑」的噪音。
    expect(viewOf(idle.registry).statusBar).toBeUndefined();
  });

  it('lists each child with its state, activity and conclusion', () => {
    const { registry } = registryOf([entryOf('a', { text: '全部通过', tokens: 1234 })]);
    const section = viewOf(registry).sections?.[0];
    expect(section?.items?.[0]?.label).toContain('任务 a');
    expect(section?.items?.[0]?.label).toContain('空闲');
    expect(section?.items?.[0]?.value).toContain('4s 前');
    expect(section?.items?.[0]?.value).toContain('1234 token');
    expect(section?.items?.[0]?.value).toContain('全部通过');
  });

  it('offers abort while running and close once it is done', () => {
    const { registry } = registryOf([entryOf('a', { busy: true }), entryOf('b')]);
    const items = viewOf(registry).sections?.[0]?.items ?? [];
    expect(items[0]?.actions?.map((action) => action.id)).toContain(ABORT_ACTION);
    expect(items[1]?.actions?.map((action) => action.id)).toContain(CLOSE_ACTION);
  });

  it('aborts through the child process and reports back', async () => {
    const entry = entryOf('a', { busy: true });
    const { registry } = registryOf([entry]);
    const result = await createPanelHandler({ registry, now: () => now }).action({
      action: ABORT_ACTION,
      key: 'a',
      values: {},
    } as never);
    expect(entry.process.abort).toHaveBeenCalled();
    expect(result).toMatchObject({ message: expect.stringContaining('已打断') });
  });

  it('opens a detail dialog instead of dumping the projection into the view', async () => {
    const { registry, markRead } = registryOf([entryOf('a', { text: '结论在这' })]);
    const result = await createPanelHandler({ registry, now: () => now }).action({
      action: INSPECT_ACTION,
      key: 'a',
      values: {},
    } as never);
    expect(markRead).toHaveBeenCalledWith('a');
    expect(result).toMatchObject({ dialog: { text: expect.stringContaining('结论在这') } });
  });

  it('closes every idle child in one click', async () => {
    const { registry, closeMany } = registryOf([entryOf('a')]);
    const result = await createPanelHandler({ registry, now: () => now }).action({
      action: CLOSE_IDLE_ACTION,
      values: {},
    } as never);
    expect(closeMany).toHaveBeenCalledWith('idle');
    expect(result).toMatchObject({ message: expect.stringContaining('1 个') });
  });

  it('hands the summary job to the model instead of running it in the click handler', async () => {
    const { registry } = registryOf([entryOf('a')]);
    const result = await createPanelHandler({ registry, now: () => now }).action({
      action: COLLECT_ACTION,
      values: {},
    } as never);
    // 汇总要读转录、写结论：那是模型的事，插件只把话放进输入框。
    expect(result).toMatchObject({ compose: expect.stringContaining('subagent_inspect') });
  });

  it('tolerates a stale click after the child is gone', async () => {
    const { registry } = registryOf([]);
    const result = await createPanelHandler({ registry, now: () => now }).action({
      action: ABORT_ACTION,
      key: 'gone',
      values: {},
    } as never);
    expect(result).toMatchObject({ message: expect.stringContaining('不在了') });
  });
});
