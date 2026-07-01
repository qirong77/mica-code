import { isCompactionNotNeededError, type CompactOptions, type CompactResult } from '@packages/mica-context/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandAgent, CommandRuntimeServices, CommandSessionController } from './services.js';

type CompactArgs = CompactOptions & {
  customInstructions?: string;
};

export function createCompactCommand(
  agent: CommandAgent,
  sessionController: CommandSessionController,
  services: CommandRuntimeServices,
) {
  return {
    name: 'compact',
    description: '压缩当前会话上下文为 checkpoint',
    hiddenMenuItems: [
      { arg: '--preview', label: 'preview' },
      { arg: '--aggressive', label: 'aggressive' },
      { arg: '--keep-recent 4', label: 'keep recent 4 rounds' },
    ],
    action: async (rawArgs?: string) => {
      const ownerSessionId = services.getCurrentAgentSessionId();
      const targetAgent = services.getCurrentAgent() ?? agent;
      const targetSessionController = services.getCurrentSessionController() ?? sessionController;
      const args = parseCompactArgs(rawArgs);

      if (services.isAgentBusy(targetAgent)) {
        services.showMessage('compact: agent is busy; wait or abort first', 5000, ownerSessionId);
        return;
      }

      micaLogger.logRuntime('plugin.compact', 'requested', {
        preview: Boolean(args.preview),
        aggressive: Boolean(args.aggressive),
        keepRecentRounds: args.keepRecentRounds,
        hasCustomInstructions: Boolean(args.customInstructions),
      });

      try {
        const result = await services.runExclusiveTask(
          targetAgent,
          { ownerSessionId, statusText: 'compact: preparing context' },
          () => services.compact(targetAgent, targetSessionController, ownerSessionId, args),
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

function parseCompactArgs(rawArgs?: string): CompactArgs {
  const tokens = tokenizeArgs(rawArgs ?? '');
  const instructions: string[] = [];
  const result: CompactArgs = {};

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === '--preview') {
      result.preview = true;
      continue;
    }
    if (token === '--aggressive') {
      result.aggressive = true;
      continue;
    }
    if (token === '--keep-recent' || token === '--keep-last') {
      const next = tokens[index + 1];
      const value = next ? Number.parseInt(next, 10) : Number.NaN;
      if (Number.isFinite(value) && value > 0) {
        result.keepRecentRounds = value;
        index++;
      }
      continue;
    }
    if (token.startsWith('--keep-recent=')) {
      const value = Number.parseInt(token.slice('--keep-recent='.length), 10);
      if (Number.isFinite(value) && value > 0) result.keepRecentRounds = value;
      continue;
    }
    instructions.push(token);
  }

  const customInstructions = instructions.join(' ').trim();
  if (customInstructions) result.customInstructions = customInstructions;
  return result;
}

function tokenizeArgs(value: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens;
}

function formatCompactResult(result: CompactResult): string {
  const prefix = result.preview ? 'compact preview' : 'compact';
  const saved = formatTokens(result.savedTokenEstimate);
  const ratio = Math.round(result.savedRatio * 100);
  const retries = result.promptTooLongRetries > 0 ? `, retries ${result.promptTooLongRetries}` : '';
  return `${prefix}: ${result.beforeCount} -> ${result.afterCount} messages, saved ~${saved} tokens (${ratio}%), kept ${result.keptCount}${retries}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${Math.round(tokens / 100) / 10}k`;
  return String(tokens);
}

function resultLog(result: CompactResult) {
  return {
    beforeCount: result.beforeCount,
    afterCount: result.afterCount,
    summarizedCount: result.summarizedCount,
    keptCount: result.keptCount,
    beforeTokenEstimate: result.beforeTokenEstimate,
    afterTokenEstimate: result.afterTokenEstimate,
    savedTokenEstimate: result.savedTokenEstimate,
    savedRatio: result.savedRatio,
    promptTooLongRetries: result.promptTooLongRetries,
    preview: result.preview,
  };
}
