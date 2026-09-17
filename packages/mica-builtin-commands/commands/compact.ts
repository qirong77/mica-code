import { formatTokenCount } from '@packages/mica-common/format.js';
import { isCompactionNotNeededError, type CompactResult } from '@packages/mica-context/index.js';
import type { BuiltInCommandItem } from '../commandHost.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from '../services.js';

// `/compact llm`：显式要求生成 LLM 摘要 checkpoint（会重写历史，默认路径不用它）。
const LLM_COMPACT_OPTIONS = {
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
    description: '把工具结果替换为占位符，不改动对话内容；使用 `llm` 参数改为生成摘要 checkpoint',
    completionItems: [{ arg: 'llm', description: '生成 LLM 摘要 checkpoint（会重写历史）' }],
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
        const compactOptions =
          mode === 'llm'
            ? {
                ...LLM_COMPACT_OPTIONS,
                contextWindowSize: targetAgent.config.provider.contextWindowSize,
                forceSummary: true,
              }
            : {
                toolResultsOnly: true,
                contextWindowSize: targetAgent.config.provider.contextWindowSize,
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
  const lines = [`**${prefix} complete**`, '', `- Mode: ${mode} (${strategy})`];
  if (result.strategy === 'tool_results_only') {
    lines.push(`- Tool results replaced: ${result.toolResultsReplaced ?? 0}`);
    // 失效的 Responses reasoning 条目会被一并丢弃（不再发送也不再落盘），
    // 它们本来就不算对话内容，所以条数变化时不用 "unchanged" 误导用户。
    if (result.reasoningItemsDropped) {
      lines.push(`- Stale reasoning items dropped: ${result.reasoningItemsDropped}`);
    }
    lines.push(
      result.afterCount === result.beforeCount
        ? `- Messages: ${result.beforeCount} (unchanged)`
        : `- Messages: ${result.beforeCount} -> ${result.afterCount}`,
    );
  } else {
    lines.push(`- Messages: ${result.beforeCount} -> ${result.afterCount}`);
  }
  lines.push(`- Saved: ~${saved} tokens (${ratio}%)`);
  if (result.strategy !== 'tool_results_only') {
    lines.push(`- Recent kept: ${result.keptCount} messages`);
  }
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
