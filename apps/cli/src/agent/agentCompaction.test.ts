import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { piAssistant, piUser } from './piMessageFixtures.js';
import { micaContext, type CompactResult } from '@packages/mica-context/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import type { AgentRuntime, AgentRuntimeSnapshot } from './AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import { compactIdleSessionHistory } from './agentCompaction.js';

afterEach(() => vi.restoreAllMocks());

describe('compactIdleSessionHistory display history', () => {
  it.each(['quick', 'model'] as const)(
    'persists the current %s result instead of freezing the old display',
    async (mode) => {
      let snapshot: AgentRuntimeSnapshot = {
        providerId: 'test',
        protocol: 'openai_responses',
        model: 'm',
        effort: 'none',
        role: 'default',
        messageFormat: 'pi-ai-v1',
        messages: [piUser('original task'), piAssistant('original answer')],
        usageHistory: [],
        lastUsage: undefined,
      };
      const replacement = [piUser('compacted history')];
      vi.spyOn(micaContext.CompactionService.prototype, 'compact').mockResolvedValue({
        messages: replacement,
        beforeCount: 2,
        afterCount: 1,
        beforeTokenEstimate: 100,
        afterTokenEstimate: 10,
        savedTokenEstimate: 90,
      } as CompactResult);
      let persisted = display(snapshot.messages);
      const notice: MicaUiConversationMessage = { role: 'notice', content: 'compaction completed' };
      const notices: MicaUiConversationMessage[] = [];
      const agent = {
        getSnapshot: () => snapshot,
        loadSnapshot: (next: AgentRuntimeSnapshot) => {
          snapshot = next;
        },
        getSubagentUsageHistory: () => [],
        estimateRequestOverheadTokens: () => 0,
      } as unknown as AgentRuntime;
      const sessionController = {
        getConversationMessages: () => persisted,
        saveCurrent: (options: { conversationMessages?: MicaUiConversationMessage[] }) => {
          persisted = options.conversationMessages ?? display(snapshot.messages);
          return true;
        },
      } as unknown as SessionController;
      const compose = () => [...display(snapshot.messages), ...notices];

      await compactIdleSessionHistory({
        agent,
        sessionController,
        mode,
        summarize: async () => 'summary',
        conversationMessages: compose,
        afterApply: () => {
          notices.push(notice);
        },
      });

      expect(snapshot.messages).toEqual(replacement);
      expect(persisted).toEqual([...display(replacement), notice]);
      expect(compose()).toEqual(persisted);
      expect(persisted.some((message) => message.content === 'original answer')).toBe(false);
    },
  );

  it('leaves the save projection unset when no display composer is supplied', async () => {
    const snapshot = { messageFormat: 'pi-ai-v1', messages: [piUser('old'), piAssistant('answer')] };
    vi.spyOn(micaContext.CompactionService.prototype, 'compact').mockResolvedValue({
      messages: [piUser('summary')],
      beforeCount: 2,
      afterCount: 1,
      beforeTokenEstimate: 100,
      afterTokenEstimate: 10,
      savedTokenEstimate: 90,
    } as CompactResult);
    const saveCurrent = vi.fn();
    await compactIdleSessionHistory({
      agent: {
        getSnapshot: () => snapshot,
        loadSnapshot: vi.fn(),
        getSubagentUsageHistory: () => [],
        estimateRequestOverheadTokens: () => 0,
      } as unknown as AgentRuntime,
      sessionController: { saveCurrent } as unknown as SessionController,
    });
    expect(saveCurrent.mock.calls[0]?.[0]).not.toHaveProperty('conversationMessages');
  });
});

function display(messages: Message[]): MicaUiConversationMessage[] {
  return messages.flatMap((message): MicaUiConversationMessage[] => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const content =
      typeof message.content === 'string'
        ? message.content
        : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
    return [{ role: message.role, content }];
  });
}
