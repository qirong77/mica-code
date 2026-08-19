import { formatTokenCount } from '@packages/mica-common/format.js';
import { isCompactionNotNeededError, type CompactResult } from '@packages/mica-context/index.js';
import type { BuiltInCommandItem } from '../commandHost.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from '../services.js';

const MANUAL_COMPACT_OPTIONS = {
  aggressive: true,
  force: true,
  lightweightPrune: true,
  pruneOnlyThresholdRatio: 0.3,
  targetContextRatio: 0.35,
  maxPromptTooLongRetries: 4,
  minRecentRounds: 1,
  maxRecentRounds: 3,
};

export function createCompactCommand(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
): BuiltInCommandItem {
  return {
    name: 'compact',
    description: '压缩当前会话上下文为 checkpoint；使用 `llm` 参数固定生成摘要',
    completionItems: [{ arg: 'llm', description: '固定使用 LLM 生成摘要' }],
    async action(rawArgs) {
      const ownerSessionId = services.getCurrentAgentSessionId();
      const targetAgent = services.getCurrentAgent() ?? agent;
      const targetSessionController = services.getCurrentSessionController() ?? sessionController;
      const mode = (rawArgs ?? '').trim().toLowerCase();
      if (mode && mode !== 'llm') {
        showCompactPanelMessage(
          services,
          `compact: 不支持参数 ${rawArgs}；请使用 /compact 或 /compact llm`,
          ownerSessionId,
          'warning',
        );
        return;
      }

      if (services.isAgentBusy(targetAgent)) {
        showCompactPanelMessage(services, 'compact: agent is busy; wait or abort first', ownerSessionId, 'warning');
        return;
      }

      try {
        const compactOptions = {
          ...MANUAL_COMPACT_OPTIONS,
          contextWindowSize: targetAgent.config.provider.contextWindowSize,
          ...(mode === 'llm' ? { forceSummary: true } : {}),
        };
        const result = await services.runExclusiveTask(
          targetAgent,
          {
            ownerSessionId,
            statusText: 'compact: preparing context',
            surface: 'command_panel',
            command: '/compact',
            variant: 'compact',
          },
          () => services.compact(targetAgent, targetSessionController, ownerSessionId, compactOptions),
        );
        services.showNotice(formatCompactNotice(result), ownerSessionId, {
          variant: 'compact',
          command: '/compact',
          status: 'success',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isCompactionNotNeededError(error)) {
          showCompactPanelMessage(services, `compact: ${message}`, ownerSessionId, 'info');
          return;
        }
        showCompactPanelMessage(services, `compact failed: ${message}`, ownerSessionId, 'error');
      }
    },
  };
}

function showCompactPanelMessage(
  services: CommandRuntimeServices,
  text: string,
  ownerSessionId: string | undefined,
  status: 'success' | 'warning' | 'error' | 'info',
) {
  services.showNotice(text, ownerSessionId, {
    variant: 'compact',
    command: '/compact',
    status,
  });
}

function formatCompactNotice(result: CompactResult) {
  const prefix = result.preview ? 'compact preview' : 'compact';
  const saved = formatTokenCount(result.savedTokenEstimate, { compactLowercase: true });
  const ratio = Math.round(result.savedRatio * 100);
  const mode = result.mode === 'pruned' ? 'pruned' : 'summarized';
  const strategy = result.strategy.replace(/_/g, ' ');
  const lines = [
    `**${prefix} complete**`,
    '',
    `- Mode: ${mode} (${strategy})`,
    `- Messages: ${result.beforeCount} -> ${result.afterCount}`,
    `- Saved: ~${saved} tokens (${ratio}%)`,
    `- Recent kept: ${result.keptCount} messages`,
  ];
  if (result.contextUsageRatio !== undefined) {
    lines.push(`- Context after compact: ${Math.round(result.contextUsageRatio * 100)}%`);
  }
  if (result.promptTooLongRetries > 0) {
    lines.push(`- Prompt-too-long retries: ${result.promptTooLongRetries}`);
  }
  if (result.reducedRecentRounds && result.reducedRecentRounds > 0) {
    lines.push(`- Recent rounds reduced: ${result.reducedRecentRounds}`);
  }
  return lines.join('\n');
}
