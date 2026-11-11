import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PersistedSession, SessionStoreLike } from '@packages/mica-session/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import type { AgentRuntimeEvents, AgentRuntimeSnapshot } from '../agent/AgentRuntime.js';
import type { SessionAgentAdapter } from './SessionController.js';
import type { AssistantMessageEvent, UserMessage } from '@earendil-works/pi-ai';
import type { PiRequest } from '@packages/mica-agent/providers/piTransport.js';
import { piAssistant, piFromConversation, piUser } from './piTestMessages.js';
import { buildSubagentUsageRecord } from '@packages/mica-agent/index.js';

const transportMocks = vi.hoisted(() => ({ stream: vi.fn<(request: PiRequest) => AsyncIterable<AssistantMessageEvent>>() }));
vi.mock('@packages/mica-agent/providers/piTransport.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('@packages/mica-agent/providers/piTransport.js')>(),
  streamPiRequest: transportMocks.stream,
}));

const previousHome = process.env.HOME;
const previousMicaHome = process.env.MICA_HOME;
const tempHome = mkdtempSync(join(tmpdir(), 'mica-session-controller-'));

beforeAll(() => {
  process.env.HOME = tempHome;
  process.env.MICA_HOME = tempHome;
});

afterAll(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousMicaHome === undefined) {
    delete process.env.MICA_HOME;
  } else {
    process.env.MICA_HOME = previousMicaHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

const baseSnapshot: AgentRuntimeSnapshot = {
  providerId: 'test',
  protocol: 'openai_responses',
  model: 'm',
  effort: 'none',
  role: 'default',
        messageFormat: 'pi-ai-v1' as const,
  messages: [piUser('work')],
  usageHistory: [],
  lastUsage: undefined,
};

function persistedSession(id: string, extra: Partial<PersistedSession> = {}): PersistedSession {
  return {
    version: 1,
    revision: 1,
    id,
    title: 'work',
    titleSource: 'derived',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: tempHome,
    turnState: 'completed',
    snapshot: { ...baseSnapshot, conversationMessages: [{ role: 'user', content: 'work' }] },
    ...extra,
  };
}

async function sessionController(store: Pick<SessionStoreLike, 'load' | 'save'> & Pick<Partial<SessionStoreLike>, 'statSignature'>) {
  const { SessionController } = await import('./SessionController.js');
  const agent: SessionAgentAdapter = {
    getSnapshot: () => baseSnapshot,
    loadSnapshot: vi.fn(),
    reloadConfig: vi.fn(),
    toConversationMessages: () => [{ role: 'user', content: 'work' }],
  };
  return new SessionController({
    agent,
    store: { list: () => [], listRecent: () => [], delete: () => false, ...store },
    config: { apply: () => undefined },
    ui: { restore: vi.fn() },
  });
}

describe('SessionController', () => {
  it('preserves an unpublished plugin role through resume, refresh and save', async () => {
    const { SessionController } = await import('./SessionController.js');
    const { micaAgent } = await import('@packages/mica-agent/index.js');
    const role = 'unpublished-review-plugin-role';
    expect(micaAgent.roles.get(role)).toBeUndefined();
    let disk = persistedSession('plugin-role', {
      snapshot: { ...baseSnapshot, role, conversationMessages: [{ role: 'user', content: 'work' }] },
    });
    let snapshot: AgentRuntimeSnapshot = { ...baseSnapshot };
    const controller = new SessionController({
      agent: {
        getSnapshot: () => snapshot,
        loadSnapshot: (value) => {
          snapshot = value;
        },
        reloadConfig: vi.fn(),
        toConversationMessages: () => [{ role: 'user', content: 'work' }],
      },
      store: {
        list: () => [],
        listRecent: () => [],
        delete: () => false,
        load: () => disk,
        save: (value) => {
          disk = value;
        },
      },
      config: { apply: () => undefined },
      ui: { restore: vi.fn() },
    });
    expect(controller.resume(disk.id)).toMatchObject({ ok: true });
    expect(snapshot.role).toBe(role);
    disk = { ...disk, revision: 2 };
    expect(controller.refreshFromStore()).toMatchObject({ ok: true });
    controller.saveCurrent();
    expect(snapshot.role).toBe(role);
    expect(disk.snapshot.role).toBe(role);
  });

  it('rolls back the process directory when persisting a cwd change fails', async () => {
    const original = process.cwd();
    const next = mkdtempSync(join(tmpdir(), 'mica-cwd-fail-'));
    const controller = await sessionController({
      load: () => persistedSession('test'),
      save: () => { throw new Error('save failed'); },
    });
    try {
      expect(() => controller.setCurrentCwd(next)).toThrow('save failed');
      expect(process.cwd()).toBe(original);
    } finally {
      process.chdir(original);
      rmSync(next, { recursive: true, force: true });
    }
  });

  it('applies an externally changed cwd when refreshing an idle session', async () => {
    const original = process.cwd();
    const next = mkdtempSync(join(tmpdir(), 'mica-cwd-refresh-'));
    let disk = persistedSession('test', { cwd: original });
    const controller = await sessionController({ load: () => disk, save: (value) => { disk = value; } });
    try {
      expect(controller.resume('test').ok).toBe(true);
      disk = { ...disk, cwd: next, revision: 2 };
      expect(controller.refreshFromStore()?.ok).toBe(true);
      expect(process.cwd()).toBe(realpathSync(next));
      controller.saveCurrent();
      expect(disk.cwd).toBe(realpathSync(next));
      disk = { ...disk, cwd: original, revision: (disk.revision ?? 0) + 1 };
      expect(controller.resumeLoaded(disk).ok).toBe(true);
      expect(process.cwd()).toBe(original);
    } finally {
      process.chdir(original);
      rmSync(next, { recursive: true, force: true });
    }
  });

  it('round-trips an interrupted thinking display checkpoint without adding it to model messages', async () => {
    const { SessionController } = await import('./SessionController.js');
    const thinking = {
      providerId: 'test',
      protocol: 'openai_responses' as const,
      model: 'm',
      apiBase: 'https://test',
      text: 'complete',
    };
    const snapshot: AgentRuntimeSnapshot = {
      providerId: 'test',
      protocol: 'openai_responses',
      model: 'm',
      effort: 'none',
      role: 'default',
        messageFormat: 'pi-ai-v1' as const,
      messages: [piUser('work')],
      usageHistory: [],
      lastUsage: undefined,
      interruptedThinking: thinking,
    };
    const loadSnapshot = vi.fn();
    const agent: SessionAgentAdapter = {
      getSnapshot: () => snapshot,
      loadSnapshot,
      reloadConfig: vi.fn(),
      toConversationMessages: () => [{ role: 'user', content: 'work' }],
    };
    let saved: PersistedSession | null = null;
    const store: SessionStoreLike = {
      list: () => [],
      listRecent: () => [],
      load: () => saved,
      save: (session) => {
        saved = session;
      },
      delete: () => false,
    };
    const controller = new SessionController({
      agent,
      store,
      config: { apply: () => undefined },
      ui: { restore: vi.fn() },
    });
    expect(controller.saveCurrent({ turnState: 'aborted' })).toBe(true);
    expect(saved!.snapshot.interruptedThinking).toEqual(thinking);
    expect(saved!.snapshot.messages).toEqual(snapshot.messages);
    expect(controller.resumeLoaded(saved!).ok).toBe(true);
    expect(loadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ interruptedThinking: thinking, messages: snapshot.messages }),
    );
  });

  it('saves completed progress and retry rollbacks without replacing the conversation', async () => {
    const { default: mitt } = await import('mitt');
    const { SessionController } = await import('./SessionController.js');
    const { micaSession } = await import('@packages/mica-session/index.js');
    const events = mitt<AgentRuntimeEvents>();
    const thinking = {
      providerId: 'test',
      protocol: 'openai_responses' as const,
      model: 'm',
      apiBase: 'https://test',
      text: 'complete',
    };
    let snapshot: AgentRuntimeSnapshot = {
      providerId: 'test',
      protocol: 'openai_responses',
      model: 'm',
      effort: 'none',
      role: 'default',
        messageFormat: 'pi-ai-v1' as const,
      messages: [piUser('work')],
      usageHistory: [],
      lastUsage: undefined,
    };
    let running = false;
    const agent: SessionAgentAdapter = {
      events,
      get isRunning() {
        return running;
      },
      getSnapshot: () => snapshot,
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: () => [{ role: 'user', content: 'work' }],
    };
    let saved: PersistedSession | null = null;
    const store: SessionStoreLike = {
      list: () => [],
      listRecent: () => [],
      load: () => saved,
      save: (session) => {
        saved = session;
      },
      delete: () => false,
    };
    const controller = new SessionController({
      agent,
      store,
      config: { apply: () => undefined },
      ui: { restore: vi.fn() },
    });
    const lease = micaSession.acquireTurnLease(controller.getCurrentSessionId());
    expect(lease).not.toBeNull();
    try {
      expect(controller.saveCurrent({ turnState: 'running' })).toBe(true);
      const messages = saved!.snapshot.conversationMessages;
      running = true;
      snapshot = { ...snapshot, activeThinking: thinking };
      events.emit('thinkingCheckpoint', undefined);
      expect(saved!.snapshot.activeThinking).toEqual(thinking);
      expect(saved!.snapshot.conversationMessages).toEqual(messages);
      snapshot = { ...snapshot, activeThinking: undefined };
      events.emit('textRollback', undefined);
      expect(saved!.snapshot.activeThinking).toBeUndefined();
      snapshot = { ...snapshot, activeThinking: thinking };
      events.emit('thinkingCheckpoint', undefined);
      running = false;
    } finally {
      lease?.release();
    }
    expect(controller.resumeLoaded(saved!).ok).toBe(true);
    expect(agent.loadSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ activeThinking: thinking }), {
      recoverActiveThinking: true,
    });
  });

  it.each([
    { name: 'first request', iterations: 0, queued: false, mismatch: false, repeated: false, rewrite: false },
    { name: 'two committed tool iterations', iterations: 2, queued: false, mismatch: false, repeated: false, rewrite: false },
    { name: 'queued input after a tool iteration', iterations: 1, queued: true, mismatch: false, repeated: false, rewrite: false },
    { name: 'different restored model', iterations: 0, queued: false, mismatch: true, repeated: false, rewrite: false },
    { name: 'identical preceding user input', iterations: 0, queued: false, mismatch: false, repeated: true, rewrite: false },
    { name: 'history rewritten before the first response', iterations: 0, queued: false, mismatch: false, repeated: false, rewrite: true },
  ])('recovers the exact provider history after a crash: $name', async ({ iterations, queued, mismatch, repeated, rewrite }) => {
    const { AgentRuntime } = await import('../agent/AgentRuntime.js');
    const { SessionController } = await import('./SessionController.js');
    const { micaSession } = await import('@packages/mica-session/index.js');
    const { micaConfig } = await import('@packages/mica-config/index.js');
    const { registerIterationRewrite } = await import('../agent/iterationRewrite.js');
    const provider = {
      id: 'recovery-test', api_base: 'https://example.com/v1', api_key: 'test-key',
      protocol: 'openai_responses' as const, models: ['test-model', 'other-model'], supportsEffort: false,
    };
    const configSpy = vi.spyOn(micaConfig, 'get').mockReturnValue({
      provider: provider.id, model: 'test-model', effort: 'none', contextWindowSize: 1000, providers: [provider],
    });
    const ruleSpy = vi.spyOn(micaConfig, 'getModelRule').mockReturnValue({ contextSize: 1000, supportsVision: true } as ReturnType<typeof micaConfig.getModelRule>);
    const rewriter = rewrite ? registerIterationRewrite('recovery-test', (messages) => [...messages]) : undefined;
    transportMocks.stream.mockReset();
    const input = [
      { type: 'text' as const, text: 'What is in this picture?' },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'YWJj' } },
    ];
    const expectedContent: UserMessage['content'] = [
      { type: 'text', text: 'What is in this picture?' },
      { type: 'image', mimeType: 'image/png', data: 'YWJj' },
    ];
    const completed = piAssistant('', { provider: provider.id });
    const store = micaSession.createStore();
    const agent = new AgentRuntime();
    if (repeated) {
      agent.loadSnapshot({
        ...agent.getSnapshot(), messages: [piUser(expectedContent)],
      });
    }
    const controller = new SessionController({ agent, store, config: { apply: () => undefined }, ui: { restore: vi.fn() } });
    const lease = micaSession.acquireTurnLease(controller.getCurrentSessionId());
    expect(lease).not.toBeNull();
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let checkpoint!: () => void;
    const checkpointReached = new Promise<void>((resolve) => { checkpoint = resolve; });
    let running: Promise<unknown> | undefined;
    try {
      controller.saveCurrent({ allowEmpty: true, turnState: 'running', conversationMessages: [{ role: 'user', content: 'display' }] });
      for (let index = 0; index < iterations; index++) {
        transportMocks.stream.mockImplementationOnce(async function* (request) {
          // The real transport reports the encoded payload before the first event.
          request.onPayload({ model: 'test-model', messages: request.context.messages });
          const message = piAssistant([
            { type: 'toolCall', id: `call_${index}`, name: 'missing_test_tool', arguments: {} },
          ], { provider: provider.id, stopReason: 'toolUse' });
          yield { type: 'done', reason: 'toolUse', message };
        });
      }
      transportMocks.stream.mockImplementationOnce(async function* (request) {
        request.onPayload({ model: 'test-model', messages: request.context.messages });
        const partial = piAssistant([{ type: 'thinking', thinking: 'complete' }], { provider: provider.id });
        yield { type: 'thinking_start', contentIndex: 0, partial };
        yield { type: 'thinking_delta', contentIndex: 0, delta: 'complete', partial };
        yield { type: 'thinking_end', contentIndex: 0, content: 'complete', partial };
        await blocked;
      });
      agent.events.on('thinkingCheckpoint', () => {
        if (agent.getSnapshot().activeThinking?.text === 'complete') checkpoint();
      });
      let completedIterations = 0;
      running = agent.run(input, { onIterationComplete: () => {
        completedIterations++;
        controller.saveCurrent({ allowEmpty: true, turnState: 'running' });
        return queued && completedIterations === 1 ? 'queued follow-up' : null;
      } }).catch((error) => error);
      await checkpointReached;
      const saved = store.load(controller.getCurrentSessionId())!;
      expect(saved.snapshot.activeThinking?.text).toBe('complete');
      expect(saved.snapshot.activeTurn).toEqual({
        input: queued ? 'queued follow-up' : input,
        committed: (iterations > 0 && !queued) || rewrite,
      });
      expect(saved.snapshot.messages).toEqual(agent.getSnapshot().messages);
      expect(saved.snapshot.messageFormat).toBe('pi-ai-v1');
      const preCrashInput = structuredClone(transportMocks.stream.mock.calls.at(-1)![0].context.messages);

      // The persisted running state remains as if the process had disappeared.
      agent.abort();
      unblock();
      await running;
      lease?.release();
      const restored = new AgentRuntime();
      const next = new SessionController({
        agent: restored, store,
        config: { apply: (snapshot) => mismatch ? { ...snapshot, model: 'other-model' } : snapshot },
        ui: { restore: vi.fn() },
      });
      expect(next.resume(saved.id).ok).toBe(true);
      expect(restored.getSnapshot().interruptedThinking?.text).toBe(mismatch ? undefined : 'complete');
      transportMocks.stream.mockImplementationOnce(async function* () {
        yield { type: 'done', reason: 'stop', message: completed };
      });
      await restored.run('continue');
      const request = transportMocks.stream.mock.calls.at(-1)![0];
      // Every committed message, including native assistant/tool metadata, survives the disk round trip.
      // Timestamps are local bookkeeping (pi never sends them) and the crash checkpoint re-creates
      // the pending turn input, so compare the replayable payload without them.
      const wire = (messages: readonly { timestamp?: number }[]) =>
        messages.map(({ timestamp: _timestamp, ...rest }) => rest);
      expect(wire(request.context.messages.slice(0, preCrashInput.length))).toEqual(wire(preCrashInput));
      expect(request.context.messages[preCrashInput.length]).toMatchObject({ role: 'user', content: 'continue' });
      const users = request.context.messages.filter((item) => item.role === 'user');
      // The pasted image is carried by the multimodal user message(s), not re-sent as text.
      const mediaUsers = users.filter((item) => typeof item.content !== 'string');
      expect(mediaUsers).toHaveLength(repeated ? 2 : 1);
      expect(mediaUsers[0]?.content).toEqual(expectedContent);
      expect(users.at(-1)?.content).toEqual('continue');
      expect(users.some((item) => item.content === 'queued follow-up')).toBe(queued);
      expect(request.context.messages.filter((item) => item.role === 'toolResult')).toHaveLength(iterations);
      expect(request.context.messages).not.toContainEqual(expect.objectContaining({ content: 'complete' }));
    } finally {
      agent.abort();
      unblock();
      if (running) await running;
      lease?.release();
      transportMocks.stream.mockReset();
      rewriter?.dispose();
      configSpy.mockRestore();
      ruleSpy.mockRestore();
    }
  });

  it('does not recover a live writer and recovers its unchanged checkpoint after acquiring the turn lease', async () => {
    const { SessionController } = await import('./SessionController.js');
    const { micaSession } = await import('@packages/mica-session/index.js');
    const thinking = {
      providerId: 'test',
      protocol: 'openai_responses' as const,
      model: 'm',
      apiBase: 'https://test',
      text: 'complete',
    };
    const runtimeSnapshot: AgentRuntimeSnapshot = {
      providerId: 'test',
      protocol: 'openai_responses',
      model: 'm',
      effort: 'none',
      role: 'default',
        messageFormat: 'pi-ai-v1' as const,
      messages: [piUser('work')],
      usageHistory: [],
      lastUsage: undefined,
    };
    const loadSnapshot = vi.fn();
    const agent: SessionAgentAdapter = {
      getSnapshot: () => runtimeSnapshot,
      loadSnapshot,
      reloadConfig: vi.fn(),
      toConversationMessages: () => [{ role: 'user', content: 'work' }],
    };
    const session: PersistedSession = {
      version: 1,
      id: 'live-thinking',
      title: 'work',
      cwd: '/tmp',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      turnState: 'running',
      snapshot: {
        ...runtimeSnapshot,
        activeThinking: thinking,
        conversationMessages: [{ role: 'user', content: 'work' }],
      },
    };
    const store: SessionStoreLike = {
      list: () => [],
      listRecent: () => [],
      load: (id) => (id === session.id ? session : null),
      save: vi.fn(),
      delete: () => false,
    };
    const controller = new SessionController({
      agent,
      store,
      config: { apply: () => undefined },
      ui: { restore: vi.fn() },
    });
    const liveLease = micaSession.acquireTurnLease(session.id);
    expect(liveLease).not.toBeNull();
    try {
      expect(controller.resumeLoaded(session).ok).toBe(true);
      expect(loadSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ activeThinking: thinking }));
    } finally {
      liveLease?.release();
    }
    const nextLease = micaSession.acquireTurnLease(session.id);
    expect(nextLease).not.toBeNull();
    try {
      expect(controller.refreshFromStore()?.ok).toBe(true);
      expect(loadSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ activeThinking: thinking }), {
        recoverActiveThinking: true,
      });
      expect(controller.refreshFromStore()).toBeNull();
    } finally {
      nextLease?.release();
    }
  });

  it('re-reads a stale running snapshot under the lease before deciding whether to recover', async () => {
    const { SessionController } = await import('./SessionController.js');
    const thinking = {
      providerId: 'test',
      protocol: 'openai_responses' as const,
      model: 'm',
      apiBase: 'https://test',
      text: 'old progress',
    };
    const stale = persistedSession('finished-during-resume', {
      turnState: 'running',
      snapshot: { ...baseSnapshot, activeThinking: thinking, conversationMessages: [] },
    });
    const current = persistedSession(stale.id, { revision: 2, turnState: 'completed' });
    const loadSnapshot = vi.fn();
    const agent: SessionAgentAdapter = {
      getSnapshot: () => baseSnapshot,
      loadSnapshot,
      reloadConfig: vi.fn(),
      toConversationMessages: () => [{ role: 'user', content: 'work' }],
    };
    const store: SessionStoreLike = {
      list: () => [],
      listRecent: () => [],
      load: (id) => (id === stale.id ? current : null),
      save: vi.fn(),
      delete: () => false,
    };
    const controller = new SessionController({
      agent,
      store,
      config: { apply: () => undefined },
      ui: { restore: vi.fn() },
    });
    expect(controller.resumeLoaded(stale)).toMatchObject({
      ok: true,
      session: { revision: 2, turnState: 'completed' },
    });
    expect(loadSnapshot).toHaveBeenCalledWith(expect.objectContaining({ activeThinking: undefined }));
  });

  it('lets a no-save refresh recover only after the live lease is released', async () => {
    const { SessionController } = await import('./SessionController.js');
    const { micaSession } = await import('@packages/mica-session/index.js');
    const thinking = {
      providerId: 'test',
      protocol: 'openai_responses' as const,
      model: 'm',
      apiBase: 'https://test',
      text: 'complete',
    };
    const runtimeSnapshot: AgentRuntimeSnapshot = {
      providerId: 'test',
      protocol: 'openai_responses',
      model: 'm',
      effort: 'none',
      role: 'default',
        messageFormat: 'pi-ai-v1' as const,
      messages: [piUser('work')],
      usageHistory: [],
      lastUsage: undefined,
    };
    const loadSnapshot = vi.fn();
    const agent: SessionAgentAdapter = {
      getSnapshot: () => runtimeSnapshot,
      loadSnapshot,
      reloadConfig: vi.fn(),
      toConversationMessages: () => [{ role: 'user', content: 'work' }],
    };
    const session: PersistedSession = {
      version: 1,
      id: 'no-save-live-thinking',
      title: 'work',
      cwd: '/tmp',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      turnState: 'running',
      snapshot: {
        ...runtimeSnapshot,
        activeThinking: thinking,
        conversationMessages: [{ role: 'user', content: 'work' }],
      },
    };
    const store: SessionStoreLike = {
      list: () => [],
      listRecent: () => [],
      load: (id) => (id === session.id ? session : null),
      save: vi.fn(),
      delete: () => false,
    };
    const controller = new SessionController({
      agent,
      store,
      config: { apply: () => undefined },
      ui: { restore: vi.fn() },
    });
    controller.setTodoPersistenceEnabled(false);
    const lease = micaSession.acquireTurnLease(session.id);
    expect(lease).not.toBeNull();
    try {
      expect(controller.resumeLoaded(session).ok).toBe(true);
      expect(controller.refreshFromStore()).toBeNull();
      expect(loadSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      lease?.release();
    }
    expect(controller.refreshFromStore()?.ok).toBe(true);
    expect(loadSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ activeThinking: thinking }), {
      recoverActiveThinking: true,
    });
  });

  it.each([false, true])(
    'records late plugin usage in the original persisted session (deleted: %s)',
    async (deleted) => {
      const { SessionController } = await import('./SessionController.js');
      const original = {
        version: 1,
        revision: 3,
        id: 'original',
        title: '原会话',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        snapshot: { messages: [piUser('保留这段对话')], subagentUsageHistory: [] },
      } as unknown as PersistedSession;
      const recordSubagentUsage = vi.fn();
      const agent = { recordSubagentUsage, isRunning: false } as unknown as SessionAgentAdapter;
      const store: SessionStoreLike = {
        list: () => [],
        listRecent: () => [],
        load: (id) => (id === original.id && !deleted ? original : null),
        save: vi.fn(),
        delete: () => false,
      };
      const controller = new SessionController({ agent, store });
      const record = buildSubagentUsageRecord({
        taskId: 'plugin:memory',
        origin: 'plugin',
        pluginId: 'memory',
        subagentType: 'plugin:memory',
        description: '整理记忆',
        model: 'mini',
        status: 'completed',
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(1).toISOString(),
        requests: [],
      });

      expect(controller.recordSubagentUsageForSession(original.id, record)).toBe(!deleted);

      expect(recordSubagentUsage).not.toHaveBeenCalled();
      if (deleted) expect(store.save).not.toHaveBeenCalled();
      else
        expect(store.save).toHaveBeenCalledWith({
          ...original,
          revision: 4,
          updatedAt: expect.any(String),
          snapshot: { ...original.snapshot, subagentUsageHistory: [record] },
        });
    },
  );

  it.each([false, true])(
    'records current-session plugin usage and saves only when idle (running: %s)',
    async (running) => {
      const { SessionController } = await import('./SessionController.js');
      const recordSubagentUsage = vi.fn();
      const controller = new SessionController({
        agent: { recordSubagentUsage, isRunning: running } as unknown as SessionAgentAdapter,
      });
      const save = vi.spyOn(controller, 'saveCurrent').mockReturnValue(true);
      const record = buildSubagentUsageRecord({
        taskId: 'plugin:memory',
        origin: 'plugin',
        pluginId: 'memory',
        subagentType: 'plugin:memory',
        description: '整理记忆',
        model: 'mini',
        status: 'completed',
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(1).toISOString(),
        requests: [],
      });

      expect(controller.recordSubagentUsageForSession(controller.getCurrentSessionId(), record)).toBe(true);

      expect(recordSubagentUsage).toHaveBeenCalledWith(record);
      if (running) expect(save).not.toHaveBeenCalled();
      else expect(save).toHaveBeenCalledWith({ allowEmpty: true });
    },
  );

  it('keeps the parent another process wrote instead of the value loaded into memory', async () => {
    let saved = persistedSession('session', { parentSessionId: 'loaded-parent' });
    const controller = await sessionController({
      load: () => saved,
      save: (session) => {
        saved = session;
      },
    });
    expect(controller.resumeLoaded(saved).ok).toBe(true);

    // 用户在侧栏把这条会话拖到另一个父会话下：桌面端直接改盘，宿主内存里仍是旧值
    saved = { ...saved, parentSessionId: 'dragged-parent', revision: (saved.revision ?? 0) + 1 };
    controller.saveCurrent({ turnState: 'aborted' });
    expect(saved.parentSessionId).toBe('dragged-parent');

    // 解除父子关系同样以盘上为准，不能被内存里的旧值顶回去
    const { parentSessionId: dropped, ...root } = saved;
    expect(dropped).toBe('dragged-parent');
    saved = root as PersistedSession;
    controller.saveCurrent({ turnState: 'error' });
    expect('parentSessionId' in saved).toBe(false);
  });

  it('writes the parent given to a brand-new session and then follows the file', async () => {
    let saved: PersistedSession | null = null;
    const controller = await sessionController({
      load: () => saved,
      save: (session) => {
        saved = session;
      },
    });
    controller.startNewSession({ parentSessionId: 'spawned-by' });
    expect(controller.saveCurrent()).toBe(true);
    expect(saved!.parentSessionId).toBe('spawned-by');

    // 落盘之后改成跟随文件：另一条进程把父子关系拆掉，宿主不该再写回去
    const { parentSessionId: dropped, ...root } = saved!;
    expect(dropped).toBe('spawned-by');
    saved = root as PersistedSession;
    controller.saveCurrent({ turnState: 'aborted' });
    expect('parentSessionId' in saved!).toBe(false);
  });

  it('falls back to the active provider and model when a resumed session references removed config', async () => {
    const { micaConfig } = await import('@packages/mica-config/index.js');
    const { applySessionConfig } = await import('./SessionController.js');
    micaConfig.update(() => ({
      provider: 'available',
      model: 'current-model',
      effort: 'high',
      contextWindowSize: 1000000,
      providers: [
        {
          id: 'available',
          api_base: 'https://example.com',
          api_key: 'test-key',
          protocol: 'openai_responses',
          models: ['current-model'],
        },
      ],
    }));

    const resolved = applySessionConfig({
      providerId: 'removed',
      protocol: 'openai_chat_completions',
      model: 'removed-model',
      effort: 'medium',
      role: 'default',
        messageFormat: 'pi-ai-v1' as const,
      messages: [],
      conversationMessages: [],
      usageHistory: [],
      lastUsage: undefined,
    });

    expect(resolved).toEqual(
      expect.objectContaining({
        providerId: 'available',
        protocol: 'openai_responses',
        model: 'current-model',
        effort: 'medium',
      }),
    );
    expect(micaConfig.get()).toEqual(
      expect.objectContaining({ provider: 'available', model: 'current-model', effort: 'medium' }),
    );
  });

  it('falls back to an available model when a resumed session model was removed', async () => {
    const { micaConfig } = await import('@packages/mica-config/index.js');
    const { applySessionConfig } = await import('./SessionController.js');
    micaConfig.update(() => ({
      provider: 'available',
      model: 'current-model',
      effort: 'medium',
      contextWindowSize: 1000000,
      providers: [
        {
          id: 'available',
          api_base: 'https://example.com',
          api_key: 'test-key',
          protocol: 'openai_responses',
          models: ['current-model'],
        },
      ],
    }));

    const resolved = applySessionConfig({
      providerId: 'available',
      protocol: 'openai_responses',
      model: 'removed-model',
      effort: 'high',
      role: 'default',
        messageFormat: 'pi-ai-v1' as const,
      messages: [],
      conversationMessages: [],
      usageHistory: [],
      lastUsage: undefined,
    });

    expect(resolved.model).toBe('current-model');
    expect(resolved.providerId).toBe('available');
  });

  it('retains an empty session the user named by hand', async () => {
    const { SessionController } = await import('./SessionController.js');
    let persisted: PersistedSession | null = null;
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({
        providerId: 'openai',
        protocol: 'openai_chat_completions' as const,
        model: 'test-model',
        effort: 'none' as const,
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        messages: [],
        usageHistory: [],
        lastUsage: undefined,
      })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => []),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn(() => persisted),
      save: vi.fn((session: PersistedSession) => {
        persisted = session;
      }),
      delete: vi.fn(() => {
        const deleted = persisted !== null;
        persisted = null;
        return deleted;
      }),
    };
    const controller = new SessionController({ agent, store });

    controller.renameCurrent('Named before chatting');
    expect((persisted as PersistedSession | null)?.title).toBe('Named before chatting');
    expect((persisted as PersistedSession | null)?.titleSource).toBe('manual');
    // 重命名就是「这条会话要留下」：还没有任何消息时存盘也不能把它删掉，
    // 否则侧栏里那条刚命名好的会话会在下一次落盘时凭空消失。
    expect(controller.saveCurrent()).toBe(true);
    expect(store.delete).not.toHaveBeenCalled();
    expect(persisted).not.toBeNull();
  });

  it('drops an empty session that was never named', async () => {
    const { SessionController } = await import('./SessionController.js');
    let persisted: PersistedSession | null = null;
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({
        providerId: 'openai',
        protocol: 'openai_chat_completions' as const,
        model: 'test-model',
        effort: 'none' as const,
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        messages: [],
        usageHistory: [],
        lastUsage: undefined,
      })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => []),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn(() => persisted),
      save: vi.fn((session: PersistedSession) => {
        persisted = session;
      }),
      delete: vi.fn(() => {
        const deleted = persisted !== null;
        persisted = null;
        return deleted;
      }),
    };
    const controller = new SessionController({ agent, store });

    expect(controller.saveCurrent()).toBe(false);
    expect(store.delete).toHaveBeenCalledWith(controller.getCurrentSessionId());
  });

  it('keeps a named empty session when switching sessions', async () => {
    const { SessionController } = await import('./SessionController.js');
    let persisted: PersistedSession | null = null;
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({
        providerId: 'openai',
        protocol: 'openai_chat_completions' as const,
        model: 'test-model',
        effort: 'none' as const,
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        messages: [],
        usageHistory: [],
        lastUsage: undefined,
      })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => []),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn(() => persisted),
      save: vi.fn((session: PersistedSession) => {
        persisted = session;
      }),
      delete: vi.fn(() => {
        const deleted = persisted !== null;
        persisted = null;
        return deleted;
      }),
    };
    const controller = new SessionController({ agent, store });

    controller.renameCurrent('Named before chatting');
    // `/new`、resume 另一条会话都会先把当前会话当草稿丢掉；手动命名过的不能丢。
    controller.startNewSession();
    expect(store.delete).not.toHaveBeenCalled();
    expect(persisted).toMatchObject({ title: 'Named before chatting', titleSource: 'manual' });
  });

  it('keeps persisting after an empty save removed the session file', async () => {
    const { SessionController } = await import('./SessionController.js');
    let messages: Array<{ role: 'user'; content: string }> = [];
    let persisted: PersistedSession | null = null;
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({
        providerId: 'openai',
        protocol: 'openai_chat_completions' as const,
        model: 'test-model',
        effort: 'none' as const,
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        messages: piFromConversation(messages),
        usageHistory: [],
        lastUsage: undefined,
      })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(
        () =>
          messages.map((message) => ({ role: message.role, content: message.content })),
      ),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn(() => persisted),
      save: vi.fn((session: PersistedSession) => {
        persisted = session;
      }),
      delete: vi.fn(() => {
        const deleted = persisted !== null;
        persisted = null;
        return deleted;
      }),
    };
    const controller = new SessionController({ agent, store });

    messages = [{ role: 'user', content: 'before the switch' }];
    expect(controller.saveCurrent({ allowEmpty: true, turnState: 'running' })).toBe(true);
    expect(persisted).not.toBeNull();

    // `/model` and `/role` save without allowEmpty; on a momentarily empty
    // conversation that removes the file (see the empty-session test above).
    messages = [];
    expect(controller.saveCurrent()).toBe(false);
    expect(persisted).toBeNull();

    // The session is still the live one, so later saves must write again:
    // returning early here left the whole conversation in memory only, and an
    // unexpected termination lost it (the reported "session disappeared").
    messages = [{ role: 'user', content: 'after the switch' }];
    expect(controller.saveCurrent({ allowEmpty: true, turnState: 'running' })).toBe(true);
    expect((persisted as PersistedSession | null)?.title).toBe('after the switch');
  });

  it('never wipes a persisted conversation through an allowEmpty save', async () => {
    const { SessionController } = await import('./SessionController.js');
    // 文件里有历史，但 agent 里是空的（resume 没把历史装进来）：面板动作、能力开关这类
    // 不跑 turn 的入口调 allowEmpty 存盘时，不能把这份历史写成空。
    const persisted = {
      version: 1 as const,
      id: 'session-under-test',
      title: 'kept',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      cwd: '/tmp',
      turnState: 'completed' as const,
      snapshot: {
        providerId: 'openai',
        protocol: 'openai_chat_completions' as const,
        model: 'test-model',
        effort: 'none' as const,
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        messages: [],
        conversationMessages: [{ role: 'user', content: 'history that must survive' }],
        usageHistory: [],
        lastUsage: undefined,
      },
    };
    const save = vi.fn();
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({
        providerId: 'openai',
        protocol: 'openai_chat_completions' as const,
        model: 'test-model',
        effort: 'none' as const,
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        messages: [],
        usageHistory: [],
        lastUsage: undefined,
      })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => []),
    };
    const controller = new SessionController({
      agent,
      store: {
        list: () => [],
        listRecent: () => [],
        load: () => persisted,
        save,
        delete: () => false,
      },
    });

    expect(controller.saveCurrent({ allowEmpty: true })).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('still allows an explicit empty crash-recovery checkpoint', async () => {
    const { SessionController } = await import('./SessionController.js');
    const save = vi.fn();
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({
        providerId: 'openai',
        protocol: 'openai_chat_completions' as const,
        model: 'test-model',
        effort: 'none' as const,
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        messages: [],
        usageHistory: [],
        lastUsage: undefined,
      })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => []),
    };
    const controller = new SessionController({
      agent,
      store: {
        list: () => [],
        listRecent: () => [],
        load: () => null,
        save,
        delete: () => false,
      },
    });

    expect(controller.saveCurrent({ allowEmpty: true })).toBe(true);
    expect(save).toHaveBeenCalledOnce();
  });

  it('preserves a manually renamed current session across later saves', async () => {
    const { SessionController } = await import('./SessionController.js');
    const saves: PersistedSession[] = [];
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({
        providerId: 'openai',
        protocol: 'openai_chat_completions' as const,
        model: 'test-model',
        effort: 'none' as const,
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        messages: [piUser('original prompt')],
        usageHistory: [],
        lastUsage: undefined,
      })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => [{ role: 'user' as const, content: 'original prompt' }]),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn((id: string) => saves.findLast((session) => session.id === id) ?? null),
      save: vi.fn((session: PersistedSession) => {
        saves.push(session);
      }),
      delete: vi.fn(() => false),
    };
    const controller = new SessionController({ agent, store });

    controller.renameCurrent('Manual title');
    controller.saveCurrent({ turnState: 'running' });
    controller.saveCurrent();

    expect(saves.at(-1)?.title).toBe('Manual title');
    expect(saves.at(-1)?.turnState).toBe('running');
    expect(saves.at(-1)?.snapshot.conversationMessages).toEqual([{ role: 'user', content: 'original prompt' }]);
    expect(controller.getCurrentTitle()).toBe('Manual title');

    controller.saveCurrent({ turnState: 'completed' });
    expect(saves.at(-1)?.turnState).toBe('completed');
  });

  it('moves the current session to a new cwd and keeps it across later saves', async () => {
    // 换项目目录：进程真的 chdir（下一轮的工具与 prompt 读的是 live cwd），盘上那份
    // 立刻跟上，而且之后的保存不会把它写回旧目录。
    const originalCwd = process.cwd();
    const nextDir = mkdtempSync(join(tmpdir(), 'mica-session-cwd-'));
    try {
      const saved: PersistedSession[] = [];
      const controller = await sessionController({
        load: (id) => saved.findLast((session) => session.id === id) ?? null,
        save: (session) => {
          saved.push(session);
        },
      });
      controller.saveCurrent();
      const before = saved.at(-1)!;

      expect(controller.setCurrentCwd(nextDir)).toBe(true);
      const moved = saved.at(-1)!;
      expect(moved.cwd).toBe(realpathSync(nextDir));
      expect(moved.revision).toBe((before.revision ?? 0) + 1);
      // 换目录不是会话活动：动 updatedAt 会把它顶到 Recent 最前面。
      expect(moved.updatedAt).toBe(before.updatedAt);
      expect(moved.snapshot.conversationMessages).toEqual(before.snapshot.conversationMessages);

      // 之后的保存（每一轮都写）必须继续用新目录。
      controller.saveCurrent();
      expect(saved.at(-1)!.cwd).toBe(realpathSync(nextDir));
    } finally {
      process.chdir(originalCwd);
      rmSync(nextDir, { recursive: true, force: true });
    }
  });

  it('does not rewrite a resumed session when nothing changed', async () => {
    const { SessionController } = await import('./SessionController.js');
    const persisted: PersistedSession = {
      version: 1,
      id: 'resumed-session',
      title: 'Existing conversation',
      titleSource: 'derived',
      createdAt: '2026-07-20T01:00:00.000Z',
      updatedAt: '2026-07-20T02:00:00.000Z',
      cwd: process.cwd(),
      turnState: 'completed',
      snapshot: {
        providerId: 'openai',
        protocol: 'openai_chat_completions',
        model: 'test-model',
        effort: 'none',
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        messages: [piUser('Existing conversation')],
        conversationMessages: [{ role: 'user', content: 'Existing conversation' }],
        usageHistory: [],
        lastUsage: undefined,
      },
    };
    const save = vi.fn();
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({ ...persisted.snapshot })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => [{ role: 'user' as const, content: 'Existing conversation' }]),
    };
    const controller = new SessionController({
      agent,
      store: {
        list: () => [],
        listRecent: () => [],
        load: () => persisted,
        save,
        delete: () => false,
      },
      config: { apply: vi.fn() },
      ui: { restore: vi.fn() },
    });

    expect(controller.resume('resumed-session').ok).toBe(true);
    expect(controller.saveCurrent()).toBe(true);

    expect(save).not.toHaveBeenCalled();
    expect(persisted.updatedAt).toBe('2026-07-20T02:00:00.000Z');
  });

  it('stats idle sessions without loading them, but checks contents after a metadata change', async () => {
    const initial = persistedSession('polled');
    let disk = initial;
    let identity = 'inode-1';
    const load = vi.fn(() => disk);
    const controller = await sessionController({ load, save: vi.fn(), statSignature: () => identity });
    expect(controller.resume('polled').ok).toBe(true);

    expect(controller.peekExternalChange()).toMatchObject({ changed: false });
    load.mockClear();
    expect(controller.peekExternalChange()).toBeNull();
    expect(load).not.toHaveBeenCalled();

    identity = 'inode-2';
    expect(controller.peekExternalChange()).toMatchObject({ changed: false });
    expect(load).toHaveBeenCalledOnce();
    load.mockClear();
    expect(controller.peekExternalChange()).toBeNull();

    disk = { ...initial, title: 'changed in another process' };
    identity = 'inode-3';
    expect(controller.peekExternalChange()).toMatchObject({ changed: true, session: disk });
    expect(load).toHaveBeenCalledOnce();
  });

  it('does not cache a file identity if an atomic replacement happens during the load', async () => {
    const initial = persistedSession('racing');
    let identity = 'inode-1';
    let disk = initial;
    let replaceDuringRead = false;
    const load = vi.fn(() => {
      const loaded = disk;
      if (replaceDuringRead) {
        identity = 'inode-3';
        disk = { ...initial, title: 'newer' };
        replaceDuringRead = false;
      }
      return loaded;
    });
    const controller = await sessionController({ load, save: vi.fn(), statSignature: () => identity });
    expect(controller.resume('racing').ok).toBe(true);
    expect(controller.peekExternalChange()?.changed).toBe(false);

    identity = 'inode-2';
    replaceDuringRead = true;
    expect(controller.peekExternalChange()).toBeNull();
    expect(controller.peekExternalChange()).toMatchObject({ changed: true, session: disk });
  });

  it('keeps the post-compact context figure until a newer usage record replaces it', async () => {
    const { SessionController } = await import('./SessionController.js');
    const compactedAt = '2026-08-01T10:00:00.000Z';
    const usage = {
      provider: 'openai',
      turnId: 1,
      requestIndex: 0,
      messageCount: 1,
      inputTokens: 200_000,
      outputTokens: 100,
      totalTokens: 200_100,
      paidTokenRate: 0,
      durationMs: 1234,
      firstTokenMs: 321,
      occurredAt: '2026-08-01T09:00:00.000Z',
    };
    let lastUsage = usage;
    const saved: PersistedSession[] = [];
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(
        (): AgentRuntimeSnapshot => ({
          providerId: 'openai',
          protocol: 'openai_chat_completions',
          model: 'test-model',
          effort: 'none',
          role: 'default',
        messageFormat: 'pi-ai-v1' as const,
          messages: [piUser('my prompt')],
          usageHistory: [usage],
          lastUsage,
        }),
      ),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => [{ role: 'user' as const, content: 'my prompt' }]),
    };
    const controller = new SessionController({
      agent,
      store: {
        list: () => [],
        listRecent: () => [],
        load: () => saved.at(-1) ?? null,
        save: (session) => {
          saved.push(session);
        },
        delete: () => false,
      },
      config: { apply: vi.fn() },
      ui: { restore: vi.fn() },
    });

    controller.saveCurrent({ displayUsage: { totalTokens: 20_000, compactedAt } });
    expect(saved.at(-1)?.snapshot.displayUsage).toEqual({ totalTokens: 20_000, compactedAt });
    // 压缩不改变对账口径：真实用量记录原样保留
    expect(saved.at(-1)?.snapshot.lastUsage).toEqual(usage);
    expect(saved.at(-1)?.snapshot.usageHistory).toEqual([usage]);

    // 之后再存（没有新的真实请求）：压缩后的展示值继续生效
    controller.saveCurrent();
    expect(saved.at(-1)?.snapshot.displayUsage).toEqual({ totalTokens: 20_000, compactedAt });

    // 下一次真实请求产生了更晚的用量 → 丢弃展示值
    lastUsage = { ...usage, occurredAt: '2026-08-01T11:00:00.000Z' };
    controller.saveCurrent();
    expect(saved.at(-1)?.snapshot.displayUsage).toBeUndefined();
  });

  it('keeps saving when another process rewrote the session file (no permanent skip)', async () => {
    const { SessionController } = await import('./SessionController.js');
    let disk: PersistedSession | null = null;
    const saves: PersistedSession[] = [];
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({
        providerId: 'openai',
        protocol: 'openai_chat_completions' as const,
        model: 'test-model',
        effort: 'none' as const,
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        messages: [piUser('my prompt')],
        usageHistory: [],
        lastUsage: undefined,
      })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => [{ role: 'user' as const, content: 'my prompt' }]),
    };
    const controller = new SessionController({
      agent,
      store: {
        list: () => [],
        listRecent: () => [],
        load: () => disk,
        save: (session) => {
          saves.push(session);
          disk = session;
        },
        delete: () => false,
      },
    });

    expect(controller.saveCurrent()).toBe(true);
    expect(saves).toHaveLength(1);

    // Another host rewrote the file while we were idle (stale signature).
    disk = {
      ...saves[0]!,
      turnState: 'running',
      snapshot: {
        ...saves[0]!.snapshot,
        messages: [piUser('written by another host')],
      },
    };

    // Our next save must write the in-memory snapshot instead of skipping
    // forever (regression: the headless host would silently lose every later
    // turn of its session otherwise).
    expect(controller.saveCurrent({ turnState: 'completed' })).toBe(true);
    expect(saves).toHaveLength(2);
    expect(saves[1]!.snapshot.messages).toEqual([piUser('my prompt')]);
    expect(saves[1]!.turnState).toBe('completed');
    expect(saves[1]!.revision).toBe((saves[0]!.revision ?? 0) + 1);
  });

  it('ignores compact metadata messages when deriving the session title', async () => {
    const { SessionController } = await import('./SessionController.js');
    const saves: PersistedSession[] = [];
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({
        providerId: 'openai',
        protocol: 'openai_chat_completions' as const,
        model: 'test-model',
        effort: 'none' as const,
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        messages: [piUser('[Mica compact boundary]\n\n{"mode":"pruned"}')],
        usageHistory: [],
        lastUsage: undefined,
      })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => [
        { role: 'user' as const, content: '[Mica compact boundary]\n\n{"mode":"pruned"}' },
        { role: 'user' as const, content: '[Mica compact checkpoint]\n\nsummary' },
        { role: 'user' as const, content: 'Fix the resume session title' },
      ]),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn((id: string) => saves.find((session) => session.id === id) ?? null),
      save: vi.fn((session: PersistedSession) => {
        saves.push(session);
      }),
      delete: vi.fn(() => false),
    };
    const controller = new SessionController({ agent, store });

    controller.saveCurrent();

    expect(saves.at(-1)?.title).toBe('Fix the resume session title');
  });

  it('derives the session title from the latest user message', async () => {
    const { SessionController } = await import('./SessionController.js');
    const saves: PersistedSession[] = [];
    const messages = [
      { role: 'user' as const, content: 'First task' },
      { role: 'assistant' as const, content: 'done' },
      { role: 'user' as const, content: 'Latest task' },
    ];
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({
        providerId: 'openai',
        protocol: 'openai_chat_completions' as const,
        model: 'test-model',
        effort: 'none' as const,
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        messages: piFromConversation(messages),
        usageHistory: [],
        lastUsage: undefined,
      })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => messages),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn((id: string) => saves.find((session) => session.id === id) ?? null),
      save: vi.fn((session: PersistedSession) => {
        saves.push(session);
      }),
      delete: vi.fn(() => false),
    };
    const controller = new SessionController({ agent, store });

    controller.saveCurrent();

    expect(saves.at(-1)?.title).toBe('Latest task');
  });

  it('skips plugin-injected user messages when deriving the session title', async () => {
    const { SessionController } = await import('./SessionController.js');
    const saves: PersistedSession[] = [];
    const messages = [
      { role: 'user' as const, content: 'Real user task' },
      { role: 'assistant' as const, content: 'working' },
      {
        role: 'user' as const,
        content: 'Auto reminder: context is full',
        displayContent: 'Reminder: compact now',
      },
    ];
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({
        providerId: 'openai',
        protocol: 'openai_chat_completions' as const,
        model: 'test-model',
        effort: 'none' as const,
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        messages: piFromConversation(messages),
        usageHistory: [],
        lastUsage: undefined,
      })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => messages),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn((id: string) => saves.find((session) => session.id === id) ?? null),
      save: vi.fn((session: PersistedSession) => {
        saves.push(session);
      }),
      delete: vi.fn(() => false),
    };
    const controller = new SessionController({ agent, store });

    controller.saveCurrent();

    expect(saves.at(-1)?.title).toBe('Real user task');
  });

  it('rewrites the persisted title when later user messages arrive', async () => {
    const { SessionController } = await import('./SessionController.js');
    const saves: PersistedSession[] = [];
    const messages: MicaUiConversationMessage[] = [{ role: 'user', content: 'First task' }];
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({
        providerId: 'openai',
        protocol: 'openai_chat_completions' as const,
        model: 'test-model',
        effort: 'none' as const,
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        messages: piFromConversation(messages),
        usageHistory: [],
        lastUsage: undefined,
      })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => messages),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn((id: string) => saves.findLast((session) => session.id === id) ?? null),
      save: vi.fn((session: PersistedSession) => {
        saves.push(session);
      }),
      delete: vi.fn(() => false),
    };
    const controller = new SessionController({ agent, store });

    controller.saveCurrent();
    expect(saves.at(-1)?.title).toBe('First task');

    messages.push(
      { role: 'assistant' as const, content: 'done' },
      { role: 'user' as const, content: 'Follow-up task' },
    );
    controller.saveCurrent();

    expect(saves.at(-1)?.title).toBe('Follow-up task');
    expect(saves.at(-1)?.titleSource).toBe('derived');
  });

  it('preserves the persisted title when compact replaces the visible conversation', async () => {
    const { SessionController } = await import('./SessionController.js');
    const saves: PersistedSession[] = [];
    let compacted = false;
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({
        providerId: 'openai',
        protocol: 'openai_chat_completions' as const,
        model: 'test-model',
        effort: 'none' as const,
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        messages: compacted
          ? [piUser('[Mica compact checkpoint]\n\nsummary')]
          : [piUser('Original task title')],
        usageHistory: [],
        lastUsage: undefined,
      })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() =>
        compacted
          ? [
              { role: 'user' as const, content: '[Mica compact checkpoint]\n\nsummary' },
              { role: 'user' as const, content: 'Recent follow-up' },
            ]
          : [{ role: 'user' as const, content: 'Original task title' }],
      ),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn((id: string) => saves.find((session) => session.id === id) ?? null),
      save: vi.fn((session: PersistedSession) => {
        saves.push(session);
      }),
      delete: vi.fn(() => false),
    };
    const controller = new SessionController({ agent, store });

    controller.saveCurrent();
    compacted = true;
    controller.saveCurrent({ preserveTitle: true });

    expect(saves.at(-1)?.title).toBe('Original task title');
    expect(saves.at(-1)?.snapshot.conversationMessages).toEqual([
      { role: 'user', content: '[Mica compact checkpoint]\n\nsummary' },
      { role: 'user', content: 'Recent follow-up' },
    ]);
  });

  it('repairs previously persisted compact metadata titles in session lists', async () => {
    const { SessionController } = await import('./SessionController.js');
    const session: PersistedSession = {
      version: 1,
      id: 'compacted-session',
      title: '[Mica compact boundary] {"mode":"pruned"}',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      cwd: process.cwd(),
      turnState: 'completed',
      snapshot: {
        providerId: 'openai',
        protocol: 'openai_chat_completions',
        model: 'test-model',
        effort: 'none',
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        messages: [],
        conversationMessages: [{ role: 'user', content: 'Original user prompt' }],
        usageHistory: [],
        lastUsage: undefined,
      },
    };
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({ ...session.snapshot, messages: [] })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => []),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => [
        {
          id: session.id,
          title: session.title,
          updatedAt: session.updatedAt,
          cwd: session.cwd,
          providerId: session.snapshot.providerId,
          model: session.snapshot.model,
          uncompleted: false,
          hasConversation: true,
          hasUsage: false,
        },
      ]),
      listRecent: vi.fn(() => []),
      load: vi.fn(() => session),
      save: vi.fn(),
      delete: vi.fn(() => false),
    };

    const controller = new SessionController({ agent, store });

    expect(controller.list()).toEqual([expect.objectContaining({ title: 'Original user prompt' })]);
  });

  it('restores persisted UI conversation messages without loading notices into agent history', async () => {
    const { SessionController } = await import('./SessionController.js');
    const snapshot = {
      providerId: 'openai',
      protocol: 'openai_chat_completions' as const,
      model: 'test-model',
      effort: 'none' as const,
      role: 'default',
        messageFormat: 'pi-ai-v1' as const,
      messages: [piUser('model prompt')],
      conversationMessages: [
        { role: 'user' as const, content: 'model prompt' },
        { role: 'notice' as const, content: 'saved notice' },
        {
          role: 'notice' as const,
          content: 'saved compact',
          variant: 'compact' as const,
          command: '/compact',
          status: 'info' as const,
        },
        {
          role: 'notice' as const,
          content: 'saved retry',
          variant: 'error' as const,
          command: '/error',
          status: 'error' as const,
        },
      ],
      usageHistory: [],
      lastUsage: undefined,
    };
    const session: PersistedSession = {
      version: 1,
      id: 'session-with-notice',
      title: 'model prompt',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      cwd: process.cwd(),
      turnState: 'completed',
      snapshot,
    };
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(
        (): AgentRuntimeSnapshot => ({
          providerId: snapshot.providerId,
          protocol: snapshot.protocol,
          model: snapshot.model,
          effort: snapshot.effort,
          role: snapshot.role,
      messageFormat: snapshot.messageFormat,
          messages: snapshot.messages,
          usageHistory: snapshot.usageHistory,
          lastUsage: snapshot.lastUsage,
        }),
      ),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => [{ role: 'user' as const, content: 'model prompt' }]),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn((id: string) => (id === session.id ? session : null)),
      save: vi.fn(),
      delete: vi.fn(() => false),
    };
    const restore = vi.fn();

    const controller = new SessionController({
      agent,
      store,
      config: { apply: vi.fn() },
      ui: { restore },
    });
    const result = controller.resume(session.id);

    expect(result.ok).toBe(true);
    expect(agent.loadSnapshot).toHaveBeenCalledWith({
      providerId: snapshot.providerId,
      protocol: snapshot.protocol,
      model: snapshot.model,
      effort: snapshot.effort,
      role: snapshot.role,
      messageFormat: snapshot.messageFormat,
      messages: snapshot.messages,
      usageHistory: snapshot.usageHistory,
      lastUsage: snapshot.lastUsage,
    });
    expect(restore).toHaveBeenCalledWith(agent, undefined, snapshot.conversationMessages);
  });

  it('clamps restored session effort before reloading config', async () => {
    const { micaConfig } = await import('@packages/mica-config/index.js');
    const { SessionController } = await import('./SessionController.js');
    const provider = {
      id: 'deepseek',
      name: 'DeepSeek',
      api_base: 'https://api.deepseek.com',
      api_key: 'test-key',
      protocol: 'openai_chat_completions' as const,
      models: ['deepseek-v4-pro'],
    };
    micaConfig.update(() => ({
      provider: provider.id,
      model: 'deepseek-v4-pro',
      effort: 'high',
      contextWindowSize: 1000000,
      providers: [provider],
    }));

    const session: PersistedSession = {
      version: 1,
      id: 'session-1',
      title: 'Old DeepSeek session',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      cwd: process.cwd(),
      turnState: 'completed',
      snapshot: {
        providerId: provider.id,
        protocol: provider.protocol,
        model: 'deepseek-v4-pro',
        effort: 'low',
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        messages: [],
        conversationMessages: [],
        usageHistory: [],
        lastUsage: undefined,
      },
    };
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(
        (): AgentRuntimeSnapshot => ({
          providerId: session.snapshot.providerId,
          protocol: session.snapshot.protocol,
          model: session.snapshot.model,
          effort: session.snapshot.effort,
          role: session.snapshot.role ?? 'default',
          messages: session.snapshot.messages,
          usageHistory: session.snapshot.usageHistory,
          lastUsage: session.snapshot.lastUsage,
        }),
      ),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(() => {
        expect(micaConfig.get().effort).toBe('low');
      }),
      toConversationMessages: vi.fn(() => []),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn((id: string) => (id === session.id ? session : null)),
      save: vi.fn(),
      delete: vi.fn(() => false),
    };
    const restore = vi.fn();

    const controller = new SessionController({
      agent,
      store,
      ui: { restore },
    });
    const result = controller.resume(session.id);

    expect(result.ok).toBe(true);
    expect(micaConfig.get().effort).toBe('low');
    expect(agent.reloadConfig).toHaveBeenCalledWith(false);
    expect(agent.loadSnapshot).toHaveBeenCalledWith({
      providerId: session.snapshot.providerId,
      protocol: session.snapshot.protocol,
      model: session.snapshot.model,
      effort: session.snapshot.effort,
      role: session.snapshot.role,
      messageFormat: session.snapshot.messageFormat,
      messages: session.snapshot.messages,
      usageHistory: session.snapshot.usageHistory,
      lastUsage: session.snapshot.lastUsage,
    });
    expect(restore).toHaveBeenCalled();
  });

  it('restores legacy sessions without a role as default', async () => {
    const { SessionController } = await import('./SessionController.js');
    const snapshot = {
      providerId: 'openai',
      protocol: 'openai_chat_completions' as const,
      model: 'test-model',
      effort: 'none' as const,
      messages: [],
      conversationMessages: [],
      usageHistory: [],
      lastUsage: undefined,
    };
    const session = {
      version: 1 as const,
      id: 'legacy-without-role',
      title: 'legacy',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      cwd: process.cwd(),
      snapshot,
    };
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(() => ({ ...snapshot, role: 'default' })),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => []),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn(() => session as unknown as PersistedSession),
      save: vi.fn(),
      delete: vi.fn(() => false),
    };
    const controller = new SessionController({
      agent,
      store,
      config: { apply: vi.fn() },
      ui: { restore: vi.fn() },
    });

    expect(controller.resume(session.id).ok).toBe(true);
    expect(agent.loadSnapshot).toHaveBeenCalledWith(expect.objectContaining({ role: 'default' }));
  });

  /**
   * 自己刚写下的会话文件不能被当成「别的进程改过」：签名用整份 JSON 算，所以
   * `toPersistedSnapshot` 写下去的字段必须在 `parsePersistedSession` 里原样读回来。
   * 之前 `capabilitiesCustomized: false` 写出、读回成 `undefined`，于是每个 turn
   * 都触发一次 resume，把刚应用的 role 盖回快照里的旧角色。
   */
  it('does not read its own save back as an external change', async () => {
    const { SessionController } = await import('./SessionController.js');
    const { micaSession } = await import('@packages/mica-session/index.js');
    const store = micaSession.createStore();
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(
        (): AgentRuntimeSnapshot => ({
          providerId: 'openai',
          protocol: 'openai_chat_completions',
          model: 'test-model',
          effort: 'none',
          role: 'default',
        messageFormat: 'pi-ai-v1' as const,
          capabilitySelection: { version: 1, disabledSkills: [], disabledTools: [], disabledMcpServers: [] },
          capabilitiesCustomized: false,
          messages: [piUser('my prompt')],
          usageHistory: [],
          lastUsage: undefined,
        }),
      ),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => [{ role: 'user' as const, content: 'my prompt' }]),
    };
    const controller = new SessionController({ agent, store });

    expect(controller.saveCurrent()).toBe(true);
    expect(controller.refreshFromStore()).toBeNull();
  });

  /**
   * 插件读会话正文（右键导出、旁问背景）要的是「用户眼前那份对话」，不是 provider history：
   * 刚 resume 的会话在进程里还没跑过轮次，history 是空的；compact 之后它又只剩摘要。
   */
  it('reports the persisted conversation instead of the empty provider history', async () => {
    const { SessionController } = await import('./SessionController.js');
    const persisted = {
      version: 1,
      revision: 1,
      id: 'resumed-session',
      title: '旧会话',
      titleSource: 'auto',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      cwd: '/tmp/work',
      turnState: 'completed',
      snapshot: {
        providerId: 'openai',
        protocol: 'openai_chat_completions',
        model: 'test-model',
        effort: 'none',
        role: 'default',
        messageFormat: 'pi-ai-v1' as const,
        contextWindowSize: 128000,
        messages: [],
        conversationMessages: [
          { role: 'user', content: '你好' },
          { role: 'assistant', content: '你好，有什么可以帮你？' },
        ],
        usageHistory: [],
        subagentUsageHistory: [],
      },
    } as unknown as PersistedSession;
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(
        (): AgentRuntimeSnapshot => ({
          providerId: 'openai',
          protocol: 'openai_chat_completions',
          model: 'test-model',
          effort: 'none',
          role: 'default',
        messageFormat: 'pi-ai-v1' as const,
          capabilitySelection: { version: 1, disabledSkills: [], disabledTools: [], disabledMcpServers: [] },
          capabilitiesCustomized: false,
          messages: [],
          usageHistory: [],
          lastUsage: undefined,
        }),
      ),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => []),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn(() => persisted),
      save: vi.fn(),
      delete: vi.fn(() => false),
    };
    const controller = new SessionController({ agent, store });

    expect(controller.resume('resumed-session').ok).toBe(true);
    expect(controller.getConversationMessages()).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你？' },
    ]);
  });

  /** 还没落盘的新会话（含 `mica exec`）没有快照可读，退回这个进程里的那一份。 */
  it('falls back to this process conversation when nothing is persisted yet', async () => {
    const { SessionController } = await import('./SessionController.js');
    const agent: SessionAgentAdapter = {
      getSnapshot: vi.fn(
        (): AgentRuntimeSnapshot => ({
          providerId: 'openai',
          protocol: 'openai_chat_completions',
          model: 'test-model',
          effort: 'none',
          role: 'default',
        messageFormat: 'pi-ai-v1' as const,
          capabilitySelection: { version: 1, disabledSkills: [], disabledTools: [], disabledMcpServers: [] },
          capabilitiesCustomized: false,
          messages: [],
          usageHistory: [],
          lastUsage: undefined,
        }),
      ),
      loadSnapshot: vi.fn(),
      reloadConfig: vi.fn(),
      toConversationMessages: vi.fn(() => [{ role: 'user' as const, content: '刚打的字' }]),
    };
    const store: SessionStoreLike = {
      list: vi.fn(() => []),
      listRecent: vi.fn(() => []),
      load: vi.fn(() => null),
      save: vi.fn(),
      delete: vi.fn(() => false),
    };
    const controller = new SessionController({ agent, store });

    expect(controller.getConversationMessages()).toEqual([{ role: 'user', content: '刚打的字' }]);
  });
});
