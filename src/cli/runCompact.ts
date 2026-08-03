import { resolve } from 'node:path';
import setupModelEffortContext from '../../buildin-plugins/model-effort-context/index.mjs';
import { micaConfig } from '@packages/mica-config/index.js';
import { micaContext } from '@packages/mica-context/index.js';
import type { MicaUiConversationMessage } from '@packages/mica-ui/index.js';
import { AgentRuntime } from '../agent/AgentRuntime.js';
import { SessionController } from '../session/SessionController.js';
import { toCompactedConversationDisplay } from '../plugins/commands/compactConversation.js';

export type CompactCliOptions = {
  sessionId: string;
  cwd?: string;
  force?: boolean;
  pruneOnly?: boolean;
  signal?: AbortSignal;
};

export type CompactCliResult = {
  ok: boolean;
  sessionId: string;
  code?: 'not_needed' | 'error';
  error?: string;
  mode?: string;
  strategy?: string;
  beforeCount?: number;
  afterCount?: number;
  beforeTokenEstimate?: number;
  afterTokenEstimate?: number;
  savedRatio?: number;
  summary?: string;
};

const SUMMARIZE_INSTRUCTIONS = [
  'Summarize this conversation into a compact checkpoint for the next coding agent.',
  'Preserve concrete paths, commands, validation results, user constraints, and pending work.',
  'Return only the requested <analysis> and <summary> blocks.',
].join('\n');

export async function runCompact(options: CompactCliOptions): Promise<CompactCliResult> {
  if (options.cwd) process.chdir(resolve(options.cwd));
  const disposeModelEffortContext = setupModelEffortContext();
  let agent: AgentRuntime | null = null;
  try {
    if (!options.pruneOnly) await ensureCompactModelRule(micaConfig.get().model, options.signal);
    agent = new AgentRuntime({});
    let sessionCwd: string | null = null;
    const sessionController = new SessionController({
      agent,
      // Do not write daemon/headless-selected config into user-level last-used
      // preferences while compacting; mirrors headless run.
      config: { apply() {} },
      ui: {
        restore() {
          // Headless compact has no interactive UI to restore.
        },
      },
    });
    const resumed = sessionController.resume(options.sessionId);
    if (!resumed.ok) {
      return { ok: false, sessionId: options.sessionId, code: 'error', error: resumed.message };
    }
    sessionCwd = resumed.session?.cwd ?? null;
    // 调用方未显式指定 --dir 时，把进程切回会话自己的工作目录，避免
    // saveCurrent 把无关的 process.cwd() 覆盖进会话文件。
    if (!options.cwd && sessionCwd) {
      try {
        process.chdir(resolve(sessionCwd));
      } catch {
        // Best-effort: an unreachable session cwd must not fail compact.
      }
    }
    if (!options.pruneOnly) {
      await ensureCompactModelRule(agent.config.model, options.signal);
      agent.configureForRun(
        {
          providerId: agent.config.provider.id,
          model: agent.config.model,
          effort: agent.config.effort,
        },
        true,
      );
    }

    const snapshot = agent.getSnapshot();
    if (snapshot.messages.length < 2) {
      return {
        ok: false,
        sessionId: options.sessionId,
        code: 'not_needed',
        error: '当前会话内容较少，暂不需要 compact',
      };
    }

    const service = new micaContext.CompactionService();
    const result = await service.compact({
      messages: snapshot.messages,
      options: {
        force: options.pruneOnly === true || options.force === true,
        pruneOnly: options.pruneOnly === true,
        lightweightPrune: options.pruneOnly === true,
        ...(options.pruneOnly
          ? snapshot.contextWindowSize
            ? { contextWindowSize: snapshot.contextWindowSize }
            : {}
          : { contextWindowSize: micaConfig.getModelRule(agent.config.model).contextSize }),
      },
      summarize: async (transcript, prompt) => {
        if (!agent) throw new Error('Agent is not available for summarization');
        const subAgent = agent.createSubAgent({ systemPrompt: prompt });
        return subAgent.query([SUMMARIZE_INSTRUCTIONS, '', transcript].join('\n'));
      },
    });

    if (result.preview) {
      return {
        ok: true,
        sessionId: sessionController.getCurrentSessionId(),
        mode: result.mode,
        strategy: result.strategy,
        beforeCount: result.beforeCount,
        afterCount: result.afterCount,
        beforeTokenEstimate: result.beforeTokenEstimate,
        afterTokenEstimate: result.afterTokenEstimate,
        savedRatio: result.savedRatio,
        summary: result.summary,
      };
    }

    if (result.messages.length === 0) {
      return {
        ok: false,
        sessionId: sessionController.getCurrentSessionId(),
        code: 'error',
        error: 'Compact produced an empty model history; the original session was preserved',
      };
    }

    try {
      agent.loadSnapshot({
        ...snapshot,
        messages: result.messages,
        // Keep usage statistics across compact so Stats stays continuous.
        usageHistory: snapshot.usageHistory,
        lastUsage: snapshot.lastUsage,
      });
    } catch (error) {
      agent.loadSnapshot(snapshot);
      throw error;
    }

    const conversationMessages = toCompactedConversationDisplay(agent.toConversationMessages());
    if (conversationMessages.length === 0) {
      agent.loadSnapshot(snapshot);
      return {
        ok: false,
        sessionId: sessionController.getCurrentSessionId(),
        code: 'error',
        error: 'Compact removed all usable conversation content; the original session was restored',
      };
    }

    sessionController.saveCurrent({
      preserveTitle: true,
      turnState: 'completed',
      conversationMessages: conversationMessages as MicaUiConversationMessage[],
    });
    return {
      ok: true,
      sessionId: sessionController.getCurrentSessionId(),
      mode: result.mode,
      strategy: result.strategy,
      beforeCount: result.beforeCount,
      afterCount: result.afterCount,
      beforeTokenEstimate: result.beforeTokenEstimate,
      afterTokenEstimate: result.afterTokenEstimate,
      savedRatio: result.savedRatio,
      summary: result.summary,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const notNeeded =
      error instanceof micaContext.CompactionNotNeededError ||
      (typeof message === 'string' && message.includes('暂不需要 compact'));
    return {
      ok: false,
      sessionId: options.sessionId,
      code: notNeeded ? 'not_needed' : 'error',
      error: message,
    };
  } finally {
    disposeModelEffortContext();
  }
}

async function ensureCompactModelRule(model: string, signal?: AbortSignal): Promise<void> {
  try {
    await micaConfig.ensureModelRule(model, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error(
      `Model metadata unavailable for ${model}; using generic defaults: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
