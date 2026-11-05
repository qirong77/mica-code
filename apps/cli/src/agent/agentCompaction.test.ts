import { afterEach, describe, expect, it, vi } from 'vitest';
import { micaContext, type CompactResult } from '@packages/mica-context/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import type { AgentRuntime, AgentRuntimeSnapshot } from './AgentRuntime.js';
import type { SessionController } from '../session/SessionController.js';
import { compactIdleSessionHistory } from './agentCompaction.js';

afterEach(() => vi.restoreAllMocks());

describe('compactIdleSessionHistory display history', () => {
  it.each(['quick', 'model'] as const)('persists the current %s result instead of freezing the old display', async (mode) => {
    let snapshot: AgentRuntimeSnapshot = {
      providerId: 'test', protocol: 'openai_responses', model: 'm', effort: 'none', role: 'default',
      messages: [{ role: 'user', content: 'original task' }, { role: 'assistant', content: 'original answer' }],
      usageHistory: [], lastUsage: undefined,
    };
    const replacement = [{ role: 'user', content: 'compacted history' }];
    vi.spyOn(micaContext.CompactionService.prototype, 'compact').mockResolvedValue({
      messages: replacement, beforeCount: 2, afterCount: 1,
      beforeTokenEstimate: 100, afterTokenEstimate: 10, savedTokenEstimate: 90,
    } as CompactResult);
    let persisted = snapshot.messages as MicaUiConversationMessage[];
    const notice: MicaUiConversationMessage = { role: 'notice', content: 'compaction completed' };
    const notices: MicaUiConversationMessage[] = [];
    const agent = {
      getSnapshot: () => snapshot,
      loadSnapshot: (next: AgentRuntimeSnapshot) => { snapshot = next; },
      getSubagentUsageHistory: () => [],
      estimateRequestOverheadTokens: () => 0,
    } as unknown as AgentRuntime;
    const sessionController = {
      getConversationMessages: () => persisted,
      saveCurrent: (options: { conversationMessages?: MicaUiConversationMessage[] }) => {
        persisted = options.conversationMessages ?? snapshot.messages as MicaUiConversationMessage[];
        return true;
      },
    } as unknown as SessionController;
    const compose = () => [...snapshot.messages as MicaUiConversationMessage[], ...notices];

    await compactIdleSessionHistory({
      agent, sessionController, mode,
      summarize: async () => 'summary',
      conversationMessages: compose,
      afterApply: () => { notices.push(notice); },
    });

    expect(snapshot.messages).toEqual(replacement);
    expect(persisted).toEqual([...replacement, notice]);
    expect(compose()).toEqual(persisted);
    expect(persisted.some((message) => message.content === 'original answer')).toBe(false);
  });

  it('leaves the save projection unset when no display composer is supplied', async () => {
    const snapshot = { messages: [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'answer' }] };
    vi.spyOn(micaContext.CompactionService.prototype, 'compact').mockResolvedValue({
      messages: [{ role: 'user', content: 'summary' }], beforeCount: 2, afterCount: 1,
      beforeTokenEstimate: 100, afterTokenEstimate: 10, savedTokenEstimate: 90,
    } as CompactResult);
    const saveCurrent = vi.fn();
    await compactIdleSessionHistory({
      agent: {
        getSnapshot: () => snapshot, loadSnapshot: vi.fn(), getSubagentUsageHistory: () => [],
        estimateRequestOverheadTokens: () => 0,
      } as unknown as AgentRuntime,
      sessionController: { saveCurrent } as unknown as SessionController,
    });
    expect(saveCurrent.mock.calls[0]?.[0]).not.toHaveProperty('conversationMessages');
  });
});
