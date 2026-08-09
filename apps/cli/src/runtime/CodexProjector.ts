import type { AgentRuntime, AgentRuntimeEvents } from '../agent/AgentRuntime.js';
import type { AgentUsageRecord } from '@packages/mica-agent/index.js';
import { micaTools } from '@packages/mica-tools/index.js';
import {
  CODEX_NOTIFICATIONS,
  type CodexThreadItem,
  type CodexThreadTokenUsage,
  type CodexTokenUsageBreakdown,
} from '@packages/mica-runtime/index.js';

export type CodexNotificationWriter = (method: string, params: unknown) => void;

type PendingCommandItem = {
  itemId: string;
  name: string;
  displayText: string;
};

type ProjectorContext = {
  threadId: string;
  turnId: string;
  cwd: string;
  /** Emit reasoning deltas. Off by default to keep noise down on protocol-only clients. */
  thinking?: boolean;
};

export type CodexProjector = {
  completeTurn(status: 'completed' | 'interrupted' | 'failed', errorMessage?: string): void;
  completeAgentMessage(): void;
  dispose(): void;
};

/** Mica tool display text (onToolUseDisplayText), same source the CLI turn log uses. */
function toolDisplayText(name: string, args: string): string {
  try {
    return micaTools.getDisplayText(name, JSON.parse(args));
  } catch {
    return name;
  }
}

type CodexHandlers = {
  [K in keyof AgentRuntimeEvents]: (payload: AgentRuntimeEvents[K]) => void;
};

function emptyTokenUsage(): CodexTokenUsageBreakdown {
  return {
    total_tokens: 0,
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
}

function addTokenUsage(target: CodexTokenUsageBreakdown, record: AgentUsageRecord): void {
  target.total_tokens += record.totalTokens || 0;
  target.input_tokens += record.inputTokens || 0;
  target.cached_input_tokens += record.cachedInputTokens || 0;
  target.output_tokens += record.outputTokens || 0;
}

function usageFromRecord(record: AgentUsageRecord): CodexTokenUsageBreakdown {
  return {
    total_tokens: record.totalTokens || 0,
    input_tokens: record.inputTokens || 0,
    cached_input_tokens: record.cachedInputTokens || 0,
    cache_write_input_tokens: 0,
    output_tokens: record.outputTokens || 0,
    reasoning_output_tokens: 0,
  };
}

function formatCommand(name: string, args: string): string {
  let parsed = '';
  const trimmed = (args || '').trim();
  if (trimmed) {
    try {
      parsed = JSON.stringify(JSON.parse(trimmed));
    } catch {
      parsed = trimmed;
    }
  }
  return parsed ? `${name} ${parsed}` : name;
}

/**
 * Projects AgentRuntime events onto the Codex v2 app-server notification
 * stream consumed by `mica app-server` clients:
 *
 *   text       -> item/agentMessage/delta
 *   thinking   -> item/reasoning/textDelta
 *   toolCall   -> item/started  (commandExecution, inProgress)
 *   toolResult -> item/commandExecution/outputDelta + item/completed
 *   usage      -> thread/tokenUsage/updated
 */
export function attachCodexProjector(
  agent: AgentRuntime,
  writer: CodexNotificationWriter,
  context: ProjectorContext,
  options: { thinking?: boolean } = {},
): CodexProjector {
  const { threadId, turnId, cwd } = context;
  const thinking = context.thinking ?? options.thinking ?? false;
  const agentMessageItemId = `${turnId}-agent`;
  const reasoningItemId = `${turnId}-reasoning`;
  const pendingCommands = new Map<string, PendingCommandItem>();
  let agentMessageStarted = false;
  let reasoningStarted = false;
  const totalUsage = emptyTokenUsage();

  const emit = (method: string, params: unknown) => writer(method, params);

  const emitItemStarted = (item: CodexThreadItem) => {
    emit(CODEX_NOTIFICATIONS.itemStarted, {
      item,
      threadId,
      turnId,
      startedAtMs: Date.now(),
    });
  };

  const emitItemCompleted = (item: CodexThreadItem) => {
    emit(CODEX_NOTIFICATIONS.itemCompleted, {
      item,
      threadId,
      turnId,
      completedAtMs: Date.now(),
    });
  };

  const handlers: CodexHandlers = {
    text: (text) => {
      if (!text) return;
      if (!agentMessageStarted) {
        agentMessageStarted = true;
        emitItemStarted({
          type: 'agentMessage',
          id: agentMessageItemId,
          text: '',
        });
      }
      emit(CODEX_NOTIFICATIONS.agentMessageDelta, {
        threadId,
        turnId,
        itemId: agentMessageItemId,
        delta: text,
      });
    },
    thinking: (text) => {
      if (!thinking || !text) return;
      if (!reasoningStarted) {
        reasoningStarted = true;
        emitItemStarted({
          type: 'reasoning',
          id: reasoningItemId,
          summary: [],
          content: [],
        });
      }
      emit(CODEX_NOTIFICATIONS.reasoningTextDelta, {
        threadId,
        turnId,
        itemId: reasoningItemId,
        delta: text,
        contentIndex: 0,
      });
    },
    toolCall: ({ name, args, id }) => {
      const itemId = id || `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const displayText = toolDisplayText(name, args || '');
      pendingCommands.set(itemId, { itemId, name, displayText });
      emitItemStarted({
        type: 'commandExecution',
        id: itemId,
        command: formatCommand(name, args || ''),
        displayText,
        cwd,
        status: 'inProgress',
      });
    },
    toolResult: ({ name, result, id }) => {
      const pending = id ? pendingCommands.get(id) : undefined;
      const itemId = pending?.itemId || id || `${name}-${Date.now()}`;
      const truncated =
        (result || '').length > 256 * 1024
          ? `${(result || '').slice(0, 256 * 1024)}\n...[truncated by Mica]`
          : result || '';
      if (pending && id) {
        emit(CODEX_NOTIFICATIONS.commandExecutionOutputDelta, {
          threadId,
          turnId,
          itemId,
          delta: truncated,
        });
      }
      pendingCommands.delete(id || itemId);
      emitItemCompleted({
        type: 'commandExecution',
        id: itemId,
        command: pending?.name || name,
        displayText: pending?.displayText ?? toolDisplayText(name, result || ''),
        cwd,
        status: 'completed',
        aggregatedOutput: truncated,
        exitCode: 0,
      });
    },
    usage: (record: AgentUsageRecord) => {
      addTokenUsage(totalUsage, record);
      const last = usageFromRecord(record);
      const tokenUsage: CodexThreadTokenUsage = {
        total: { ...totalUsage },
        last,
        model_context_window: null,
      };
      emit(CODEX_NOTIFICATIONS.threadTokenUsageUpdated, {
        threadId,
        turnId,
        tokenUsage,
      });
    },
    subagentUsage: () => undefined,
    status: () => undefined,
  };

  agent.events.on('text', handlers.text);
  agent.events.on('thinking', handlers.thinking);
  agent.events.on('toolCall', handlers.toolCall);
  agent.events.on('toolResult', handlers.toolResult);
  agent.events.on('usage', handlers.usage);

  const completeAgentMessage = () => {
    if (agentMessageStarted) {
      emitItemCompleted({
        type: 'agentMessage',
        id: agentMessageItemId,
        text: '',
      });
      agentMessageStarted = false;
    }
    if (reasoningStarted) {
      emitItemCompleted({
        type: 'reasoning',
        id: reasoningItemId,
        summary: [],
        content: [],
      });
      reasoningStarted = false;
    }
  };

  return {
    completeTurn(status, errorMessage) {
      completeAgentMessage();
      emit(CODEX_NOTIFICATIONS.turnCompleted, {
        threadId,
        turnId,
        turn: {
          id: turnId,
          items: [],
          itemsView: 'full',
          status,
          error: errorMessage ? { message: errorMessage } : null,
          startedAt: null,
          completedAt: Math.floor(Date.now() / 1000),
          durationMs: null,
        },
      });
    },
    completeAgentMessage,
    dispose() {
      agent.events.off('text', handlers.text);
      agent.events.off('thinking', handlers.thinking);
      agent.events.off('toolCall', handlers.toolCall);
      agent.events.off('toolResult', handlers.toolResult);
      agent.events.off('usage', handlers.usage);
    },
  };
}
