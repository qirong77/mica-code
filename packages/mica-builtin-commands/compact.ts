import { isCompactionNotNeededError, type CompactOptions, type CompactResult } from '@packages/mica-context/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from './services.js';

const MANUAL_COMPACT_OPTIONS: CompactOptions = {
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
) {
  return {
    name: 'compact',
    description: '压缩当前会话上下文为 checkpoint',
    action: async (rawArgs?: string) => {
      const ownerSessionId = services.getCurrentAgentSessionId();
      const targetAgent = services.getCurrentAgent() ?? agent;
      const targetSessionController = services.getCurrentSessionController() ?? sessionController;
      if ((rawArgs ?? '').trim()) {
        services.showMessage('compact: /compact 不支持参数，请直接运行 /compact', 5000, ownerSessionId);
        return;
      }

      if (services.isAgentBusy(targetAgent)) {
        services.showMessage('compact: agent is busy; wait or abort first', 5000, ownerSessionId);
        return;
      }

      micaLogger.logRuntime('plugin.compact', 'requested', {
        aggressive: MANUAL_COMPACT_OPTIONS.aggressive,
        force: MANUAL_COMPACT_OPTIONS.force,
        lightweightPrune: MANUAL_COMPACT_OPTIONS.lightweightPrune,
        pruneOnlyThresholdRatio: MANUAL_COMPACT_OPTIONS.pruneOnlyThresholdRatio,
        targetContextRatio: MANUAL_COMPACT_OPTIONS.targetContextRatio,
        contextWindowSize: targetAgent.config.provider.contextWindowSize,
      });

      try {
        const compactOptions: CompactOptions = {
          ...MANUAL_COMPACT_OPTIONS,
          contextWindowSize: targetAgent.config.provider.contextWindowSize,
        };
        const result = await services.runExclusiveTask(
          targetAgent,
          { ownerSessionId, statusText: 'compact: preparing context' },
          () => services.compact(targetAgent, targetSessionController, ownerSessionId, compactOptions),
        );
        micaLogger.logRuntime('plugin.compact', 'done', resultLog(result));
        services.showNotice(formatCompactNotice(result), ownerSessionId, { variant: 'compact', command: '/compact' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isCompactionNotNeededError(error)) {
          micaLogger.logRuntime('plugin.compact', 'not_needed', { message });
          services.showMessage(`compact: ${message}`, 5000, ownerSessionId);
          return;
        }
        micaLogger.logRuntime('plugin.compact', 'error', { message }, 'error');
        services.showMessage(`compact failed: ${message}`, 8000, ownerSessionId);
      }
    },
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

function formatCompactNotice(result: CompactResult): string {
  const prefix = result.preview ? 'compact preview' : 'compact';
  const saved = formatTokens(result.savedTokenEstimate);
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

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 100) / 10}k`;
  return String(tokens);
}

function resultLog(result: CompactResult) {
  return {
    mode: result.mode,
    strategy: result.strategy,
    beforeCount: result.beforeCount,
    afterCount: result.afterCount,
    summarizedCount: result.summarizedCount,
    keptCount: result.keptCount,
    beforeTokenEstimate: result.beforeTokenEstimate,
    afterTokenEstimate: result.afterTokenEstimate,
    savedTokenEstimate: result.savedTokenEstimate,
    savedRatio: result.savedRatio,
    promptTooLongRetries: result.promptTooLongRetries,
    forced: result.forced,
    preview: result.preview,
    contextWindowSize: result.contextWindowSize,
    contextUsageRatio: result.contextUsageRatio,
    lightweightTokenEstimate: result.lightweightTokenEstimate,
    targetContextRatio: result.targetContextRatio,
    pruneOnlyThresholdRatio: result.pruneOnlyThresholdRatio,
    recentTokenEstimate: result.recentTokenEstimate,
    summaryInputTokenEstimate: result.summaryInputTokenEstimate,
    reducedRecentRounds: result.reducedRecentRounds,
  };
}
