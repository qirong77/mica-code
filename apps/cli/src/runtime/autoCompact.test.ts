import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import {
  AUTO_COMPACT_DEFAULTS,
  AutoCompactController,
  decideAutoCompactStep,
  emptyAutoCompactCounters,
  normalizeAutoCompactSettings,
  normalizeAutoCompactTurnParams,
  type AutoCompactCounters,
} from './autoCompact.js';

const TOOL_PLACEHOLDER = '[Old tool result content cleared during compact]';
const SUMMARY = '<analysis>draft</analysis><summary>\n## Current Work\n- compaction\n</summary>';

describe('auto compact settings', () => {
  it('falls back to the documented defaults for missing or garbage values', () => {
    expect(normalizeAutoCompactSettings(undefined)).toEqual(AUTO_COMPACT_DEFAULTS);
    expect(normalizeAutoCompactSettings({ quickThresholdK: 'nope', quickLimit: Number.NaN })).toEqual(
      AUTO_COMPACT_DEFAULTS,
    );
    expect(AUTO_COMPACT_DEFAULTS).toMatchObject({
      enabled: true,
      quickThresholdK: 200,
      quickLimit: 3,
      modelThresholdK: 120,
      modelLimit: 3,
    });
  });

  it('keeps valid values and clamps out-of-range ones back to the default', () => {
    expect(
      normalizeAutoCompactSettings({
        enabled: false,
        quickThresholdK: 50,
        quickLimit: 0,
        modelThresholdK: 80,
        modelLimit: 10,
      }),
    ).toEqual({ enabled: false, quickThresholdK: 50, quickLimit: 0, modelThresholdK: 80, modelLimit: 10 });
    // 越界值不静默改写成一个「差不多」的阈值，而是回到默认值，避免把 0 当成 1。
    expect(normalizeAutoCompactSettings({ quickThresholdK: 0, quickLimit: -3 })).toMatchObject({
      quickThresholdK: 200,
      quickLimit: 3,
    });
  });

  it('normalizes the turn params (settings + counters)', () => {
    expect(normalizeAutoCompactTurnParams({ enabled: true, quickRuns: 2, modelRuns: -1 })).toMatchObject({
      quickRuns: 2,
      modelRuns: 0,
    });
    expect(normalizeAutoCompactTurnParams(null)).toMatchObject({ quickRuns: 0, modelRuns: 0 });
  });
});

describe('auto compact decision', () => {
  const settings = { ...AUTO_COMPACT_DEFAULTS };
  const counters = { quickRuns: 0, modelRuns: 0 };

  it('runs the quick pass while the context is above its threshold', () => {
    expect(decideAutoCompactStep({ settings, counters, ctxTokens: 200_000 })).toBe('quick');
  });

  it('escalates to the model pass when the quick pass is exhausted or its threshold is not reached', () => {
    expect(
      decideAutoCompactStep({ settings, counters: { quickRuns: 3, modelRuns: 0 }, ctxTokens: 250_000 }),
    ).toBe('model');
    expect(decideAutoCompactStep({ settings, counters, ctxTokens: 150_000 })).toBe('model');
    expect(decideAutoCompactStep({ settings, counters, ctxTokens: 119_999 })).toBeNull();
  });

  it('stops once both passes used up their allowance or the setting is off', () => {
    expect(
      decideAutoCompactStep({ settings, counters: { quickRuns: 3, modelRuns: 3 }, ctxTokens: 900_000 }),
    ).toBeNull();
    expect(
      decideAutoCompactStep({
        settings: { ...settings, enabled: false },
        counters,
        ctxTokens: 900_000,
      }),
    ).toBeNull();
    expect(decideAutoCompactStep({ settings, counters, ctxTokens: 0 })).toBeNull();
  });
});

describe('AutoCompactController', () => {
  it('rewrites the tool results locally at the iteration boundary and counts the run', async () => {
    const { agent, statuses } = createAgent({ inputTokens: 250_000 });
    const controller = new AutoCompactController({ agent, onStatus: (c) => statuses.push(c) });
    // 模型压缩关掉额度，只观察快速压缩这一步。
    controller.setParams({ enabled: true, quickThresholdK: 200, quickLimit: 3, modelLimit: 0, quickRuns: 0 });

    const messages = toolRound();
    const rewritten = await controller.rewriteIterationMessages(messages);

    expect(rewritten).not.toBeNull();
    expect(rewritten![2]).toMatchObject({ role: 'tool', content: TOOL_PLACEHOLDER });
    expect(controller.getCounters()).toMatchObject({ quickRuns: 1, modelRuns: 0, lastKind: 'quick' });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.quickRuns).toBe(1);
  });

  it('stays off until a host sends its settings (mica exec / Codex drivers keep today\'s behavior)', async () => {
    const { agent } = createAgent({ inputTokens: 900_000 });
    const controller = new AutoCompactController({ agent });
    // 没有 setParams：codex-family driver 只发原生参数，不能因此多出模型摘要请求。
    expect(await controller.rewriteIterationMessages(toolRound(5))).toBeNull();
    expect(controller.getCounters()).toMatchObject({ quickRuns: 0, modelRuns: 0 });
  });

  it('handles each completed request only once', async () => {
    const { agent } = createAgent({ inputTokens: 250_000 });
    const controller = new AutoCompactController({ agent });
    controller.setParams({ quickLimit: 3, modelLimit: 0 });

    const messages = toolRound();
    expect(await controller.rewriteIterationMessages(messages)).not.toBeNull();
    // 同一个 usage（同一次请求）在同一个边界被回调多次时不能重复压缩。
    expect(await controller.rewriteIterationMessages(messages)).toBeNull();
    expect(controller.getCounters().quickRuns).toBe(1);
  });

  it('does nothing below the thresholds or when the setting is disabled', async () => {
    const { agent } = createAgent({ inputTokens: 250_000 });
    const controller = new AutoCompactController({ agent });
    controller.setParams({ enabled: false });
    expect(await controller.rewriteIterationMessages(toolRound())).toBeNull();

    controller.setParams({ enabled: true, quickThresholdK: 500, modelThresholdK: 400 });
    expect(await controller.rewriteIterationMessages(toolRound())).toBeNull();
    expect(controller.getCounters().quickRuns).toBe(0);
  });

  it('escalates to a model compaction when the quick pass did not free enough', async () => {
    const { agent, recordSubagentUsage } = createAgent({ inputTokens: 250_000, summary: SUMMARY });
    const controller = new AutoCompactController({ agent, onStatus: () => {} });
    controller.setParams({ enabled: true, quickThresholdK: 200, quickLimit: 3, modelThresholdK: 120, modelLimit: 3 });

    const rewritten = await controller.rewriteIterationMessages(toolRound(5));
    expect(rewritten).not.toBeNull();
    const counters = controller.getCounters();
    // 工具结果太小、快速压缩省不下 130k：同一次请求结束时升级为模型压缩。
    expect(counters).toMatchObject({ quickRuns: 1, modelRuns: 1, lastKind: 'model' });
    expect(JSON.stringify(rewritten)).toContain('[Mica compact boundary]');
    // 摘要请求走子代理，用量记进 subagentUsageHistory。
    expect(recordSubagentUsage).toHaveBeenCalledTimes(1);
  });

  it('runs the model pass directly when only its threshold is exceeded', async () => {
    const { agent } = createAgent({ inputTokens: 150_000, summary: SUMMARY });
    const controller = new AutoCompactController({ agent });
    controller.setParams({ enabled: true, quickThresholdK: 200, quickLimit: 3, modelThresholdK: 120, modelLimit: 3 });

    const rewritten = await controller.rewriteIterationMessages(toolRound(5));
    expect(rewritten).not.toBeNull();
    expect(controller.getCounters()).toMatchObject({ quickRuns: 0, modelRuns: 1, lastKind: 'model' });
  });

  it('respects the run limits', async () => {
    const { agent } = createAgent({ inputTokens: 900_000 });
    const controller = new AutoCompactController({ agent });
    controller.setParams({ enabled: true, quickRuns: 3, quickLimit: 3, modelRuns: 3, modelLimit: 3 });
    expect(await controller.rewriteIterationMessages(toolRound())).toBeNull();
    expect(controller.getCounters()).toMatchObject({ quickRuns: 3, modelRuns: 3 });
  });

  it('keeps the turn alive and records a note when a pass has nothing to do or fails', async () => {
    const { agent } = createAgent({ inputTokens: 250_000 });
    const controller = new AutoCompactController({ agent });
    controller.setParams({ enabled: true, quickThresholdK: 200, quickLimit: 3, modelLimit: 0 });

    // 没有工具结果可清理：快速压缩报 not needed，不计数、不改写历史。
    expect(await controller.rewriteIterationMessages([{ role: 'user', content: 'hi' }])).toBeNull();
    expect(controller.getCounters()).toMatchObject({ quickRuns: 0, lastKind: null });
    expect(controller.getCounters().lastNote).toContain('没有可清理');

    const failing = createAgent({ inputTokens: 250_000, summaryError: new Error('provider down') });
    const failed = new AutoCompactController({ agent: failing.agent });
    failed.setParams({ enabled: true, quickThresholdK: 200, modelThresholdK: 120, modelLimit: 3 });
    // 模型压缩失败不能把已经生效的快速压缩结果丢掉，也不能让 turn 挂掉。
    expect(await failed.rewriteIterationMessages(toolRound(5))).not.toBeNull();
    expect(failed.getCounters()).toMatchObject({ quickRuns: 1, modelRuns: 0 });
    expect(failed.getCounters().lastNote).toContain('模型压缩失败');
  });

  it('counts each request again after a new turn re-sends the params', async () => {
    const { agent } = createAgent({ inputTokens: 250_000 });
    const controller = new AutoCompactController({ agent });
    controller.setParams({ quickLimit: 3, modelLimit: 0 });
    await controller.rewriteIterationMessages(toolRound());
    // 宿主每个 turn 都会重新下发一次「设置 + 该会话累计次数」。
    controller.setParams({ quickLimit: 3, modelLimit: 0, quickRuns: 1 });
    const messages = toolRound();
    expect(await controller.rewriteIterationMessages(messages)).not.toBeNull();
    expect(controller.getCounters().quickRuns).toBe(2);
  });
});

type FakeAgentOptions = {
  inputTokens: number;
  summary?: string;
  summaryError?: Error;
};

function createAgent(options: FakeAgentOptions): {
  agent: AgentRuntime;
  recordSubagentUsage: ReturnType<typeof vi.fn>;
  statuses: AutoCompactCounters[];
} {
  const recordSubagentUsage = vi.fn();
  const statuses: AutoCompactCounters[] = [];
  const agent = {
    config: { model: 'test-model' },
    getSnapshot: () => ({
      lastUsage: {
        usageId: 'usage-1',
        occurredAt: '2026-09-01T00:00:00.000Z',
        provider: 'test',
        turnId: 1,
        requestIndex: 1,
        messageCount: 4,
        model: 'test-model',
        inputTokens: options.inputTokens,
        outputTokens: 10,
        totalTokens: options.inputTokens + 10,
        paidTokenRate: 1,
      },
    }),
    createSubAgent: () => ({
      usageHistory: [
        {
          usageId: 'sub-1',
          provider: 'test',
          turnId: 1,
          requestIndex: 1,
          messageCount: 3,
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          paidTokenRate: 1,
        },
      ],
      query: async () => {
        if (options.summaryError) throw options.summaryError;
        return options.summary ?? SUMMARY;
      },
    }),
    recordSubagentUsage,
  } as unknown as AgentRuntime;
  return { agent, recordSubagentUsage, statuses };
}

function history(rounds: number): unknown[] {
  return Array.from({ length: rounds }, (_, index) => index + 1).flatMap((turn) => [
    { role: 'user', content: `user request ${turn} ${'u'.repeat(1200)}` },
    {
      role: 'assistant',
      content: `assistant answer ${turn}\nfile packages/example${turn}.ts\n${'a'.repeat(1200)}`,
    },
  ]);
}

/** 最后一条请求（含工具调用与工具结果）加上若干历史轮次。 */
function toolRound(rounds = 0): unknown[] {
  return [
    ...history(rounds),
    { role: 'user', content: 'read the file' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"file_path":"src/a.ts"}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'x'.repeat(2000) },
  ];
}

describe('emptyAutoCompactCounters', () => {
  it('starts every counter at zero', () => {
    expect(emptyAutoCompactCounters()).toEqual({
      quickRuns: 0,
      modelRuns: 0,
      lastRunAt: null,
      lastKind: null,
      lastSavedTokens: 0,
      lastNote: null,
    });
  });
});
