import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderDefinition, ProviderProtocol } from '@packages/mica-config/index.js';
import setupModelEffortContext from '@packages/mica-builtin-commands/startup/model-effort-context/index.js';
import { MicaTool, micaTools } from '@packages/mica-tools/index.js';
import { PiModelClient } from './PiModelClient.js';

/** Opt-in: MICA_PI_LIVE=1 MICA_PI_SOURCE_HOME=/path/to/.mica [MICA_PI_PROVIDER=id].
 * The normal test setup isolates MICA_HOME; this file only reads credentials from the explicit source.
 * Each selected protocol makes two tool-turn requests plus one persisted-history replay request.
 */
const enabled = process.env.MICA_PI_LIVE === '1';
const protocols = (process.env.MICA_PI_LIVE_PROTOCOLS ?? 'openai_responses').split(',') as ProviderProtocol[];
const live = describe.skipIf(!enabled);

live('pi real API smoke', () => {
  let provider: ProviderDefinition;
  let model: string;
  let disposeRules: () => void;
  let executions = 0;
  const result = 'MICA_PI_TOOL_VERIFIED_7429';
  const tool = new class extends MicaTool {
    constructor() { super('mica_pi_smoke_read', 'Return the verification string. This is a read-only test tool.', { type: 'object', properties: {}, additionalProperties: false }, { readOnly: true }); }
    async execute() { executions++; return result; }
    onToolUseDisplayText() { return 'pi API smoke read'; }
  }();

  beforeAll(() => {
    const source = process.env.MICA_PI_SOURCE_HOME;
    if (!source) throw new Error('MICA_PI_SOURCE_HOME must explicitly name the real configuration directory.');
    const config = JSON.parse(readFileSync(join(source, 'config.json'), 'utf8')) as { providers: ProviderDefinition[]; defaultModel?: { provider: string; model: string } };
    const selected = process.env.MICA_PI_PROVIDER ?? config.defaultModel?.provider;
    const found = config.providers.find((entry) => entry.id === selected);
    if (!found) throw new Error('Selected live provider is not configured.');
    provider = found;
    model = process.env.MICA_PI_MODEL ?? provider.models?.[0] ?? '';
    if (!model) throw new Error('Selected live model is missing.');
    disposeRules = setupModelEffortContext();
    micaTools.registerRuntime(tool);
  });
  afterAll(() => { micaTools.unregisterRuntime(tool); disposeRules?.(); });

  it.each(protocols)('%s streams a tool turn and resumes its serialized history', async (protocol) => {
    executions = 0;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 75_000);
    const options = {
      model, apiKey: provider.api_key, baseURL: provider.api_base,
      provider: { ...provider, protocol }, effort: 'high', systemPrompt: 'Follow the user instruction precisely.',
      toolFilter: (name: string) => name === tool.name,
    };
    const client = new PiModelClient(options);
    let text = '';
    let thinking = '';
    let requests = 0;
    const ends: string[] = [];
    client.onText = (delta) => { text += delta; };
    client.onThinking = (delta) => { thinking += delta; };
    const observation = {
      signal: controller.signal, maxTurns: 2,
      onRequestStart: () => { requests++; },
      onRequestEnd: (info: { outcome: string }) => { ends.push(info.outcome); },
      // Keep this a bounded smoke run: let the failure surface instead of spending on retries.
      onRetry: () => controller.abort(),
    };
    try {
      const answer = await client.query(`Call ${tool.name} with {} exactly once, then reply with its returned verification string.`, observation);
      expect(executions).toBe(1);
      expect(answer).toContain(result);
      expect(text).toBe(answer);
      expect(requests).toBe(2);
      expect(ends).toEqual(['completed', 'completed']);
      expect(client.usageHistory.length).toBe(2);
      expect(client.messages.some((message) => message.role === 'toolResult')).toBe(true);
      const snapshot = JSON.parse(JSON.stringify(client.getSnapshot({ includeConversation: false })));
      const resumed = new PiModelClient({ ...options, tools: false });
      resumed.loadSnapshot(snapshot);
      const replay = await resumed.query('Repeat only the verification string returned by the tool in our previous turn.', { ...observation, maxTurns: 1 });
      expect(replay).toContain(result);
      expect(executions).toBe(1);
      expect(requests).toBe(3);
      // Report presence, never credentials, model output, or raw request payloads.
      console.info(`[pi live] ${protocol}: 3 requests, tool execution and replay passed; thinking=${thinking.length > 0}; tokens=${client.usageHistory.reduce((sum, usage) => sum + usage.totalTokens, 0)}`);
    } finally { clearTimeout(timer); controller.abort(); }
  }, 90_000);
});
