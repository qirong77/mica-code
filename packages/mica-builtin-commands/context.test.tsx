import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandAgent } from './services.js';
import type { AgentUsageRecord } from '@packages/mica-agent/index.js';

const mocks = {
  logRuntime: vi.fn(),
  upsertPluginUI: vi.fn(),
  removePluginUI: vi.fn(),
  terminalTextGet: vi.fn(() => ''),
  modelWindowGet: vi.fn(() => 256000),
  buildSystemPrompt: vi.fn(() => '<system>prompt</system>'),
  getLoadedSkills: vi.fn(() => []),
  getDefinitions: vi.fn(() => [
    { name: 'read_file', description: 'read file', input_schema: { type: 'object' } },
    { name: 'run_shell', description: 'run shell', input_schema: { type: 'object' } },
  ]),
  summarizeUsageHistory: vi.fn(() => ({ inputTokens: 1000, cachedInputTokens: 100 })),
  calculateUsageCachedTokenRate: vi.fn(() => 0.2),
};

vi.mock('@packages/mica-logger/index.js', () => ({
  micaLogger: {
    logRuntime: mocks.logRuntime,
  },
}));

vi.mock('@packages/mica-ui/index.js', () => ({
  micaUi: {
    Dialog: ({ children }: { children: unknown }) => children,
    BottomScrollBox: ({ children }: { children: unknown }) => children,
    KeyHints: () => null,
    theme: {
      colors: {
        dim: 'gray',
        textSecondary: 'white',
        subtle: 'gray',
        error: 'red',
        warning: 'yellow',
        info: 'blue',
        accent: 'magenta',
        toolNetwork: 'cyan',
        toolShell: 'green',
        toolDefault: 'white',
      },
    },
    panels: {
      upsertPluginUI: mocks.upsertPluginUI,
      removePluginUI: mocks.removePluginUI,
      modelDisplay: {
        contextWindowSize: { get: mocks.modelWindowGet },
      },
    },
    terminalInput: {
      text: { get: mocks.terminalTextGet },
    },
  },
}));

vi.mock('@packages/mica-agent/index.js', () => ({
  micaAgent: { buildSystemPrompt: mocks.buildSystemPrompt },
  summarizeUsageHistory: mocks.summarizeUsageHistory,
  calculateUsageCachedTokenRate: mocks.calculateUsageCachedTokenRate,
}));

vi.mock('@packages/mica-skills/index.js', () => ({
  micaSkills: { getLoaded: mocks.getLoadedSkills },
}));

vi.mock('@packages/mica-tools/index.js', () => ({
  micaTools: { getDefinitions: mocks.getDefinitions },
}));

const { createContextCommand } = await import('./context.js');

describe('context command', () => {
  beforeEach(() => {
    mocks.logRuntime.mockReset();
    mocks.upsertPluginUI.mockReset();
    mocks.removePluginUI.mockReset();
  });

  it('does not expose completion items', () => {
    const command = createContextCommand(makeAgent());
    expect('completionItems' in command).toBe(false);
  });

  it('opens the detail panel when invoked with detail', () => {
    const command = createContextCommand(makeAgent());
    command.action('detail');

    expect(mocks.upsertPluginUI).toHaveBeenCalledWith(expect.objectContaining({ id: 'context-panel' }));
    expect(mocks.logRuntime).toHaveBeenCalledWith(
      'plugin.context',
      'opened',
      expect.objectContaining({ detail: true }),
    );
  });
});

function makeAgent(): CommandAgent {
  return {
    config: {
      model: 'gpt-5',
      effort: 'medium',
      provider: {
        api_base: 'http://localhost',
        id: 'test',
        protocol: 'openai_chat_completions',
        contextWindowSize: 256000,
        supportsEffort: true,
      },
    },
    currentRunId: 0,
    isRunning: false,
    reloadConfig() {},
    createSubAgent() {
      return { query: async () => '' };
    },
    getSnapshot() {
      const lastUsage = {
        provider: 'test',
        turnId: 1,
        requestIndex: 0,
        messageCount: 3,
        inputTokens: 1000,
        outputTokens: 100,
        totalTokens: 1100,
        cachedInputTokens: 200,
        paidTokenRate: 1,
      } satisfies AgentUsageRecord;
      return {
        providerId: 'test',
        model: 'gpt-5',
        effort: 'medium',
        usageHistory: [lastUsage],
        lastUsage,
        messages: [
          { type: 'user', content: [{ type: 'text', text: 'inspect context' }] },
          {
            type: 'tool_call',
            id: '1',
            name: 'read_file',
            args: { file_path: 'a.ts', offset: 1 },
            argsText: '{"file_path":"a.ts"}',
          },
          { type: 'tool_result', id: '1', name: 'read_file', content: '1 | a\n2 | b\n3 | c' },
        ],
      };
    },
  };
}
