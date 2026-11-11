import type { Message } from '@earendil-works/pi-ai';
import type { AgentUsageRecord } from '@packages/mica-agent/index.js';
import type { ProviderProtocol } from '@packages/mica-config/index.js';
import { estimateContextTokens, estimateTextTokens } from '@packages/mica-context/tokenEstimate.js';
import { assistant, image, text, toolCall, toolResult, user } from '@packages/mica-context/testFixtures.js';
import type { Tool } from '@packages/mica-tools/index.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandAgent } from '../services.js';

const mocks = vi.hoisted(() => ({ tools: [] as Tool[] }));
vi.mock('@packages/mica-agent/index.js', async () => await import('@packages/mica-agent/core/Usage.js'));
vi.mock('@packages/mica-skills/index.js', () => ({ micaSkills: { getLoaded: () => [] } }));
vi.mock('@packages/mica-tools/index.js', () => ({ micaTools: { getDefinitions: () => mocks.tools } }));
vi.mock('@packages/mica-ui/index.js', () => ({ micaUi: { panels: { modelDisplay: { contextWindowSize: { get: () => 100_000 } } } } }));

const { buildContextOverview } = await import('./context.js');

function agent(messages: Message[], protocol: ProviderProtocol = 'openai_responses', lastUsage?: AgentUsageRecord): CommandAgent {
  return {
    config: { provider: { id: 'test', api_base: 'https://example.invalid', protocol, contextWindowSize: 100_000 }, model: 'test-model', effort: 'medium' },
    buildSystemPrompt: () => 'system prompt',
    getSnapshot: () => ({ providerId: 'test', model: 'test-model', effort: 'medium', role: 'default', messages, usageHistory: lastUsage ? [lastUsage] : [], lastUsage }),
  } as CommandAgent;
}
const bucket = (overview: ReturnType<typeof buildContextOverview>, key: string) => overview.buckets.find((bucket) => bucket.key === key)!.tokens;

describe('context overview from pi history', () => {
  beforeEach(() => { mocks.tools = []; });

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages', 'google_generative_ai'] as const)(
    'projects the same unified history for %s, counting structured calls and image-only turns', (protocol) => {
      const messages = [
        user([image()]),
        assistant([
          { type: 'thinking', thinking: 'do not count '.repeat(10_000), thinkingSignature: 'opaque' },
          text('reading'), toolCall('a', 'read_file', { file_path: 'src/a.ts' }), toolCall('b', 'run_shell', { command: 'bun test' }),
        ]),
        toolResult('a', 'read_file', 'file contents'), toolResult('b', 'run_shell', [text('passed'), image()]),
        assistant('done'),
      ];
      const overview = buildContextOverview(agent(messages, protocol));
      expect(overview).toMatchObject({ turns: 1, toolCalls: 2, filesRead: 1, shellCommands: 1, messageCount: 5 });
      expect(bucket(overview, 'conversation')).toBeGreaterThan(1000);
      expect(bucket(overview, 'conversation')).toBeLessThan(1100);
      expect(bucket(overview, 'toolOutputs')).toBeGreaterThan(1000);
      expect(bucket(overview, 'toolOutputs')).toBeLessThan(1100);
      expect(overview.largestToolOutputs[0]).toMatchObject({ toolName: 'run_shell', argSummary: 'bun test' });
      expect(bucket(overview, 'toolCalls')).toBeGreaterThan(0);
    },
  );

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages', 'google_generative_ai'] as const)(
    'estimates tool schemas in the native %s shape', (protocol) => {
      const tool: Tool = { name: 'read_file', description: 'read a source file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } };
      mocks.tools = [tool];
      const shape = protocol === 'openai_chat_completions'
        ? { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }
        : protocol === 'openai_responses'
          ? { type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema, strict: false }
          : protocol === 'google_generative_ai'
            ? { functionDeclarations: [{ name: tool.name, description: tool.description, parametersJsonSchema: tool.input_schema }] }
            : tool;
      const overview = buildContextOverview(agent([], protocol));
      expect(bucket(overview, 'toolSchemas')).toBe(estimateTextTokens(JSON.stringify(shape)));
      expect(overview.toolSchemaSources).toEqual([{ name: 'read_file', tokens: bucket(overview, 'toolSchemas'), kind: 'builtin' }]);
    },
  );

  it('keeps embedded pi usage and signatures out of estimates while attributing Skill results', () => {
    const messages = [user('request'), assistant([text('answer'), toolCall('a', 'Skill', { name: 'review' })]), toolResult('a', 'Skill', 'skill instructions')];
    const plain = buildContextOverview(agent(messages));
    const decorated = structuredClone(messages);
    const reply = decorated[1]!;
    if (reply.role !== 'assistant') throw new Error('fixture');
    reply.usage = { ...reply.usage, input: 9_000_000, totalTokens: 9_000_000 };
    reply.content.push({ type: 'thinking', thinking: 'x'.repeat(100_000), thinkingSignature: 'opaque' });
    const result = buildContextOverview(agent(decorated));
    expect(result.usedTokens).toBe(plain.usedTokens);
    expect(bucket(result, 'skills')).toBe(estimateTextTokens('skill instructions'));
    expect(bucket(result, 'toolOutputs')).toBe(0);
  });

  it('counts tool names and structured arguments consistently with the shared message estimate', () => {
    const call = assistant([toolCall('a', 'read_file_with_a_long_descriptive_name', { file_path: 'src/a.ts' })]);
    const overview = buildContextOverview(agent([call]));
    expect(bucket(overview, 'toolCalls')).toBe(estimateContextTokens([call]) - 2);
  });

  it('continues to scale buckets to actual request usage', () => {
    const usage = { inputTokens: 12_000, cachedInputTokens: 3000, outputTokens: 100, totalTokens: 12_100, provider: 'openai_responses' } as AgentUsageRecord;
    const overview = buildContextOverview(agent([user('request'), assistant('answer')], 'openai_responses', usage));
    expect(overview.usedTokens).toBe(12_000);
    expect(overview.latestCacheRate).toBe(0.25);
    expect(overview.totalCacheRate).toBe(0.25);
    expect(overview.buckets.reduce((sum, bucket) => sum + bucket.tokens, 0)).toBeCloseTo(12_000, -1);
  });
});
