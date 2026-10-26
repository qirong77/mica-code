import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMicaConfig } from '@packages/mica-config/index.js';
import type { IAgent, ModelClientOptions } from '@packages/mica-agent/index.js';

const modelClient = createModelClientStub();

let configState: IMicaConfig | null = null;

const testConfig: IMicaConfig = {
  provider: 'test-provider',
  model: 'test-model',
  effort: 'none',
  contextWindowSize: 1000,
  providers: [
    {
      id: 'test-provider',
      name: 'Test Provider',
      api_base: 'https://example.com/v1',
      api_key: 'test-key',
      protocol: 'openai_chat_completions',
      models: ['test-model'],
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
      get: () => configState,
      readCapabilityDefaults: () => ({
        version: 1,
        disabledSkills: [],
        disabledTools: [],
        disabledMcpServers: [],
      }),
      getModelRule: () => ({ contextSize: 1000 }),
    },
  };
});

vi.mock('@packages/mica-agent/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@packages/mica-agent/index.js')>();
  return {
    ...actual,
    micaAgent: {
      ...actual.micaAgent,
      createModelClient: vi.fn(() => modelClient),
    },
  };
});

function createModelClientStub(): IAgent<ModelClientOptions> {
  return {
    messages: [],
    usageHistory: [],
    lastUsage: undefined,
    query: vi.fn(async () => ''),
    reset: vi.fn(),
    getSnapshot: () => ({
      model: 'test-model',
      messages: [],
      usageHistory: [],
      lastUsage: undefined,
      conversationMessages: [],
    }),
    loadSnapshot: vi.fn(),
    preserveAbortedTurn: vi.fn(() => false),
    toConversationMessages: () => [],
  } as unknown as IAgent<ModelClientOptions>;
}

describe('AgentRuntime session notes', () => {
  beforeEach(() => {
    configState = { ...testConfig, providers: [...testConfig.providers] };
  });

  it('starts empty and keeps nothing in the prompt until something is written', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    expect(agent.sessionNotes).toBe('');
    expect(agent.buildSystemPrompt()).not.toContain('<session-notes>');
  });

  it('appends the notes as the last prompt section', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    agent.setSessionNotes('# 决策\n\n- 用 Bun 跑测试');

    const prompt = agent.buildSystemPrompt();
    expect(prompt).toContain('<session-notes>');
    expect(prompt).toContain('- 用 Bun 跑测试');
    // 追加在末尾：前面稳定的 system / 项目说明 / skills 段不会跟着笔记改动来回失效
    expect(prompt.trimEnd().endsWith('</session-notes>')).toBe(true);
  });

  it('normalizes what it stores so a trailing newline is not a change', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    expect(agent.setSessionNotes('  a  \r\n\r\n')).toBe('  a');
    expect(agent.setSessionNotes(null)).toBe('');
    expect(agent.setSessionNotes(123)).toBe('');
  });

  it('round-trips through the session snapshot', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    agent.setSessionNotes('# 结论\n- 压缩不会动笔记');

    const snapshot = agent.getSnapshot();
    expect(snapshot.notes).toBe('# 结论\n- 压缩不会动笔记');

    const restored = new AgentRuntime();
    restored.loadSnapshot(snapshot);
    expect(restored.sessionNotes).toBe('# 结论\n- 压缩不会动笔记');
  });

  it('treats a missing or broken notes field as empty on load', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    agent.setSessionNotes('# 旧内容');

    const snapshot = agent.getSnapshot();
    agent.loadSnapshot({ ...snapshot, notes: undefined });
    expect(agent.sessionNotes).toBe('');
    agent.loadSnapshot({ ...snapshot, notes: { content: 'x' } as unknown as string });
    expect(agent.sessionNotes).toBe('');
  });

  it('carries notes into a fork but not into a brand-new session', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    agent.setSessionNotes('# 继承');
    expect(agent.getForkSnapshot().notes).toBe('# 继承');

    agent.clearSession();
    expect(agent.sessionNotes).toBe('');
  });
});
