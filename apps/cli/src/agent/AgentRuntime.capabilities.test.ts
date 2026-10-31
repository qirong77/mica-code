import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMicaConfig } from '@packages/mica-config/index.js';
import type { IAgent, ModelClientOptions } from '@packages/mica-agent/index.js';
import { micaSkills } from '@packages/mica-skills/index.js';
import { mcpToolNamePrefix } from '@packages/mica-tools/index.js';

const modelClient = createModelClientStub();

let configState: IMicaConfig | null = null;
let defaults = {
  version: 1 as const,
  disabledSkills: [] as string[],
  disabledTools: [] as string[],
  disabledMcpServers: [] as string[],
};

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
      readCapabilityDefaults: () => defaults,
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

describe('AgentRuntime capability selection', () => {
  beforeEach(() => {
    configState = { ...testConfig, providers: [...testConfig.providers] };
    defaults = { version: 1, disabledSkills: [], disabledTools: [], disabledMcpServers: [] };
  });

  it('starts from the configured defaults', async () => {
    defaults = { version: 1, disabledSkills: ['review'], disabledTools: ['run_shell'], disabledMcpServers: [] };
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    expect(agent.capabilitySelection.disabledSkills).toEqual(['review']);
    expect(agent.capabilitySelection.disabledTools).toEqual(['run_shell']);
  });

  it('filters tools and MCP servers for this agent only', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    const mcpToolName = `${mcpToolNamePrefix('docs')}search_abc`;
    agent.setCapabilities({
      version: 1,
      disabledSkills: [],
      disabledTools: ['run_shell'],
      disabledMcpServers: ['docs'],
    });

    const options = agent.createClientOptions();
    expect(options.toolFilter?.('run_shell')).toBe(false);
    expect(options.toolFilter?.(mcpToolName)).toBe(false);
    expect(options.toolFilter?.('read_file')).toBe(true);

    // 另一个 agent（另一条会话）不受影响。
    const other = new AgentRuntime();
    expect(other.createClientOptions().toolFilter?.('run_shell')).toBe(true);
  });

  it('keeps the caller filter in the intersection', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    const options = agent.createClientOptions({
      toolFilter: (name) => name !== 'skill',
    });
    expect(options.toolFilter?.('skill')).toBe(false);
    expect(options.toolFilter?.('read_file')).toBe(true);
  });

  it('hides disabled skills from the prompt but keeps the rest', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const getLoaded = vi.spyOn(micaSkills, 'getLoaded').mockReturnValue([
      { name: 'review', description: 'review code', content: '', baseDir: '/tmp/review' },
      { name: 'pdf', description: 'read pdf', content: '', baseDir: '/tmp/pdf' },
    ]);
    try {
      const agent = new AgentRuntime();
      agent.setCapabilities({ version: 1, disabledSkills: ['review'], disabledTools: [], disabledMcpServers: [] });
      expect(agent.availableSkills().map((skill) => skill.name)).toEqual(['pdf']);
      const prompt = agent.buildSystemPrompt();
      expect(prompt).toContain('pdf');
      expect(prompt).not.toContain('review code');
    } finally {
      getLoaded.mockRestore();
    }
  });

  it('follows the config defaults until the session customizes them', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    const agent = new AgentRuntime();
    expect(agent.capabilitySelection.disabledTools).toEqual([]);

    // 配置页改了默认值：没定制过的会话应该跟着变（默认值有 1s 短缓存，用假时钟跳过）。
    defaults = { version: 1, disabledSkills: [], disabledTools: ['run_shell'], disabledMcpServers: [] };
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 5_000);
      expect(agent.capabilitySelection.disabledTools).toEqual(['run_shell']);
      expect(agent.createClientOptions().toolFilter?.('run_shell')).toBe(false);
      expect(agent.getSnapshot()).toMatchObject({ capabilitiesCustomized: false });

      // 用户在会话里点过之后就不再跟随默认值了。
      agent.setCapabilities({ version: 1, disabledSkills: [], disabledTools: ['read_file'], disabledMcpServers: [] });
      defaults = { version: 1, disabledSkills: [], disabledTools: ['run_shell', 'todo_write'], disabledMcpServers: [] };
      vi.setSystemTime(Date.now() + 5_000);
      expect(agent.capabilitySelection.disabledTools).toEqual(['read_file']);
      expect(agent.getSnapshot()).toMatchObject({
        capabilitiesCustomized: true,
        capabilitySelection: { disabledTools: ['read_file'] },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a snapshot without the customized flag as following the defaults', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    defaults = { version: 1, disabledSkills: [], disabledTools: ['run_shell'], disabledMcpServers: [] };
    const agent = new AgentRuntime();

    // 旧快照：没有 capabilitiesCustomized，里面那份副本是「创建时的默认值」。
    agent.loadSnapshot({
      providerId: 'test-provider',
      protocol: 'openai_chat_completions',
      model: 'test-model',
      effort: 'none',
      role: 'default',
      capabilitySelection: { version: 1, disabledSkills: [], disabledTools: ['todo_write'], disabledMcpServers: [] },
      messages: [],
      usageHistory: [],
      lastUsage: undefined,
    });
    expect(agent.capabilitySelection.disabledTools).toEqual(['run_shell']);
    expect(agent.getSnapshot().capabilitiesCustomized).toBe(false);

    // 新快照：标志为 true 时用会话自己的选择。
    agent.loadSnapshot({
      providerId: 'test-provider',
      protocol: 'openai_chat_completions',
      model: 'test-model',
      effort: 'none',
      role: 'default',
      capabilitySelection: { version: 1, disabledSkills: [], disabledTools: ['todo_write'], disabledMcpServers: [] },
      capabilitiesCustomized: true,
      messages: [],
      usageHistory: [],
      lastUsage: undefined,
    });
    expect(agent.capabilitySelection.disabledTools).toEqual(['todo_write']);
    expect(agent.getSnapshot()).toMatchObject({
      capabilitiesCustomized: true,
      capabilitySelection: { disabledTools: ['todo_write'] },
    });
  });

  it('returns to the defaults for a new session', async () => {
    const { AgentRuntime } = await import('./AgentRuntime.js');
    defaults = { version: 1, disabledSkills: [], disabledTools: ['run_shell'], disabledMcpServers: [] };
    const agent = new AgentRuntime();
    agent.setCapabilities({ version: 1, disabledSkills: [], disabledTools: ['read_file'], disabledMcpServers: [] });
    expect(agent.capabilitySelection.disabledTools).toEqual(['read_file']);

    agent.resetCapabilitiesToDefaults();
    expect(agent.capabilitySelection.disabledTools).toEqual(['run_shell']);
    expect(agent.getSnapshot().capabilitiesCustomized).toBe(false);
  });
});
