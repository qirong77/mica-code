import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import type { IMicaConfig } from '@packages/mica-config/index.js';
import { micaPlugin } from '@packages/mica-plugin/index.js';
import type { PluginIdleCompactOutcome, PluginTurnPrepareEvent } from '@packages/mica-plugin/index.js';
import { micaSession } from '@packages/mica-session/index.js';
import { assistant, toolBatch, user } from '@packages/mica-context/testFixtures.js';
import type { AgentRuntimeSnapshot } from '../agent/AgentRuntime.js';

const testConfig: IMicaConfig = {
  provider: 'test-provider',
  model: 'test-model',
  effort: 'none',
  contextWindowSize: 1000,
  providers: [
    {
      id: 'test-provider',
      api_base: 'https://example.com/v1',
      api_key: 'test-key',
      protocol: 'openai_chat_completions',
      models: ['test-model', 'other-model'],
      supportsEffort: false,
    },
  ],
};

vi.mock('@packages/mica-config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@packages/mica-config/index.js')>();
  return {
    ...actual,
    micaConfig: {
      ...actual.micaConfig,
      get: () => testConfig,
      update: () => testConfig,
      resetSessionModelDefaults: () => testConfig,
      prepareSessionModelDefaults: async () => testConfig,
      assertValid: () => {},
      getModelRule: () => ({ contextSize: 400_000 }),
    },
  };
});

/** 一条像真的会话：若干轮「用户请求 + 两批工具调用 + 一条回答」。 */
function history(rounds: number): Message[] {
  return Array.from({ length: rounds }, (_, index) => index + 1).flatMap((turn) => [
    user(`task ${turn}`),
    ...toolBatch(`read${turn}`),
    ...toolBatch(`shell${turn}`, 'run_shell'),
    assistant(`answer ${turn}`),
  ]);
}

function compacted(messages: Message[]): boolean {
  return JSON.stringify(messages).includes('mica_compact');
}

async function runTurn(input: {
  messages: Message[];
  model: string;
  nextModel: string;
  /** 模拟 plugins/session-compact 的 turn:prepare 处理器。 */
  prepare?: (event: PluginTurnPrepareEvent) => Promise<void>;
}) {
  const { AgentRuntime } = await import('../agent/AgentRuntime.js');
  const { SessionController } = await import('../session/SessionController.js');
  const { HeadlessTurnExecutor } = await import('./HeadlessTurnExecutor.js');

  const agent = new AgentRuntime();
  const snapshot: AgentRuntimeSnapshot = {
    providerId: 'test-provider',
    protocol: 'openai_chat_completions',
    model: input.model,
    effort: 'none',
    role: 'default',
    messageFormat: 'pi-ai-v1',
    messages: input.messages,
    usageHistory: [],
    // 上一次真实请求用的是切换前的模型：`turn:prepare` 的「前一模型」就取这里。
    lastUsage: {
      provider: 'test-provider',
      providerId: 'test-provider',
      turnId: 1,
      requestIndex: 0,
      messageCount: input.messages.length,
      model: input.model,
      inputTokens: 9000,
      outputTokens: 100,
      totalTokens: 9100,
      paidTokenRate: 0,
    },
    contextWindowSize: 400_000,
  };
  agent.loadSnapshot(snapshot);

  const controller = new SessionController({
    agent: agent as never,
    store: micaSession.createStore(),
    config: { apply: () => undefined },
    ui: { restore: vi.fn() },
  });
  const sessionId = controller.getCurrentSessionId();
  expect(controller.saveCurrent({ allowEmpty: true })).toBe(true);

  const hooks = new micaPlugin.HookRegistry();
  const outcomes: PluginIdleCompactOutcome[] = [];
  hooks.on('turn:prepare', async (event: PluginTurnPrepareEvent) => {
    const { previous, current, compactHistory } = event;
    if (previous.providerId === current.providerId && previous.model === current.model) return;
    outcomes.push(await compactHistory({ mode: 'quick' }));
    await input.prepare?.(event);
  });

  const outgoing: Message[][] = [];
  vi.spyOn(agent, 'run').mockImplementation(async () => {
    outgoing.push(agent.getSnapshot().messages);
    return { runId: agent.activeRunId, text: 'done' };
  });

  let idle = 0;
  const executor = new HeadlessTurnExecutor({
    agent: agent as never,
    sessionController: controller as never,
    hooks,
    host: { getCurrentSessionId: () => sessionId },
    onEvent: () => {},
    onIdle: () => {
      idle++;
    },
    parseImageRefs: async (text: string) => text,
    applyInputSettings: () => {
      agent.configureForRun({ providerId: 'test-provider', model: input.nextModel, effort: 'none' }, true);
    },
  });

  await executor.start({ id: 'input-1', text: 'next', source: 'user' } as never);
  await vi.waitFor(() => expect(idle).toBe(1));

  return {
    outcomes,
    outgoing: outgoing[0] ?? [],
    persisted: controller.load(sessionId)?.snapshot.messages ?? [],
  };
}

describe('automatic compaction before a turn', () => {
  it('sends and stores the compacted history after the model changes', async () => {
    const run = await runTurn({ messages: history(4), model: 'test-model', nextModel: 'other-model' });

    // 一次应用、不是静默跳过：这是「切换模型后自动快速压缩」的全部证据。
    expect(run.outcomes).toHaveLength(1);
    expect(run.outcomes[0]).toMatchObject({ status: 'applied' });
    expect(compacted(run.outgoing)).toBe(true);
    expect(run.outgoing.length).toBeLessThan(history(4).length);
    expect(compacted(run.persisted)).toBe(true);
    expect(run.persisted).toEqual(run.outgoing);
  });

  it('leaves the history alone when the model did not change', async () => {
    const messages = history(4);
    const run = await runTurn({ messages, model: 'test-model', nextModel: 'test-model' });

    expect(run.outcomes).toEqual([]);
    expect(run.outgoing).toEqual(messages);
    expect(compacted(run.persisted)).toBe(false);
  });
});
