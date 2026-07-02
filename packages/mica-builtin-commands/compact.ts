import { isCompactionNotNeededError, type CompactOptions, type CompactResult } from '@packages/mica-context/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from './services.js';

const MANUAL_COMPACT_OPTIONS: CompactOptions = {
  aggressive: true,
  force: true,
  keepRecentRounds: 3,
  lightweightPrune: true,
  summarizeThresholdRatio: 0.3,
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
        keepRecentRounds: MANUAL_COMPACT_OPTIONS.keepRecentRounds,
        lightweightPrune: MANUAL_COMPACT_OPTIONS.lightweightPrune,
        summarizeThresholdRatio: MANUAL_COMPACT_OPTIONS.summarizeThresholdRatio,
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
        services.showMessage(formatCompactResult(result), 8000, ownerSessionId);
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

function formatCompactResult(result: CompactResult): string {
  const prefix = result.preview ? 'compact preview' : 'compact';
  const saved = formatTokens(result.savedTokenEstimate);
  const ratio = Math.round(result.savedRatio * 100);
  const mode = result.mode === 'pruned' ? 'pruned' : 'summarized';
  const contextRatio =
    result.contextUsageRatio !== undefined ? `, context ${Math.round(result.contextUsageRatio * 100)}%` : '';
  const retries = result.promptTooLongRetries > 0 ? `, retries ${result.promptTooLongRetries}` : '';
  return `${prefix}: ${mode}, ${result.beforeCount} -> ${result.afterCount} messages, saved ~${saved} tokens (${ratio}%), kept ${result.keptCount}${contextRatio}${retries}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 100) / 10}k`;
  return String(tokens);
}

function resultLog(result: CompactResult) {
  return {
    mode: result.mode,
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
  };
}
