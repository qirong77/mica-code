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
  args: string;
  displayText: string;
};

type ProjectorContext = {
  threadId: string;
  turnId: string;
  cwd: string;
  /** Emit reasoning deltas. Off by default to keep noise down on protocol-only clients. */
  thinking?: boolean;
  textRollback?: boolean;
  thinkingRollback?: boolean;
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
  [K in Exclude<
    keyof AgentRuntimeEvents,
    'textAttemptStart' | 'textRollback' | 'thinkingCheckpoint' | 'thinkingRollback' | 'thinkingReset'
      | 'thinkingTurnAttemptStart' | 'thinkingTurnAttemptRollback'
  >]: (payload: AgentRuntimeEvents[K]) => void;
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
  let agentMessageText = '';
  let attemptTextLength = 0;
  let attemptThinkingLength = 0;
  let uncheckpointedThinking: Array<{ attempt: string; length: number }> = [];
  let uncheckpointedAtAttemptStart: typeof uncheckpointedThinking = [];
  let turnAttemptThinking: typeof uncheckpointedThinking = [];
  let turnAttemptText: typeof uncheckpointedThinking = [];
  let textAttempt = 0;
  const attemptId = () => `${turnId}:${textAttempt}`;
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
      agentMessageText += text;
      attemptTextLength += text.length;
      if (context.textRollback) {
        const last = turnAttemptText.at(-1);
        if (last?.attempt === attemptId()) last.length += text.length;
        else turnAttemptText.push({ attempt: attemptId(), length: text.length });
      }
      emit(CODEX_NOTIFICATIONS.agentMessageDelta, {
        threadId,
        turnId,
        itemId: agentMessageItemId,
        delta: text,
        ...(context.textRollback ? { micaAttemptId: attemptId() } : {}),
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
      attemptThinkingLength += text.length;
      const currentAttempt = attemptId();
      const last = uncheckpointedThinking.at(-1);
      if (last?.attempt === currentAttempt) last.length += text.length;
      else uncheckpointedThinking.push({ attempt: currentAttempt, length: text.length });
      const lastTurnPart = turnAttemptThinking.at(-1);
      if (lastTurnPart?.attempt === currentAttempt) lastTurnPart.length += text.length;
      else turnAttemptThinking.push({ attempt: currentAttempt, length: text.length });
      emit(CODEX_NOTIFICATIONS.reasoningTextDelta, {
        threadId,
        turnId,
        itemId: reasoningItemId,
        delta: text,
        contentIndex: 0,
        ...(context.thinkingRollback ? { micaAttemptId: attemptId() } : {}),
      });
    },
    toolCall: ({ name, args, id }) => {
      const itemId = id || `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const displayText = toolDisplayText(name, args || '');
      pendingCommands.set(itemId, { itemId, name, args: args || '', displayText });
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
        // Keep the same `command` shape as item/started (name + JSON args) so
        // clients that re-derive the tool name/input from it see the same call,
        // and never feed the tool *result* back into the display-text formatter.
        command: formatCommand(pending?.name ?? name, pending?.args ?? ''),
        displayText: pending?.displayText ?? name,
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
  const forgetTurnParts = (parts: typeof turnAttemptThinking, attempt: string, length: number) => {
    for (let index = parts.length - 1; index >= 0 && length > 0; index--) {
      const part = parts[index]!;
      if (part.attempt !== attempt) continue;
      const removed = Math.min(part.length, length);
      part.length -= removed;
      length -= removed;
      if (!part.length) parts.splice(index, 1);
    }
  };
  const onTextAttemptStart = () => {
    attemptTextLength = 0;
    attemptThinkingLength = 0;
    uncheckpointedAtAttemptStart = uncheckpointedThinking.map((part) => ({ ...part }));
    textAttempt++;
  };
  const onTextRollback = () => {
    if (attemptThinkingLength && context.thinkingRollback) {
      emit('mica/reasoning/textRollback', {
        threadId, turnId, itemId: reasoningItemId, length: attemptThinkingLength, micaAttemptId: attemptId(),
      });
      forgetTurnParts(turnAttemptThinking, attemptId(), attemptThinkingLength);
    }
    attemptThinkingLength = 0;
    uncheckpointedThinking = uncheckpointedAtAttemptStart.map((part) => ({ ...part }));
    if (!attemptTextLength) return;
    agentMessageText = agentMessageText.slice(0, -attemptTextLength);
    forgetTurnParts(turnAttemptText, attemptId(), attemptTextLength);
    emit('mica/agentMessage/textRollback', {
      threadId, turnId, itemId: agentMessageItemId, length: attemptTextLength, micaAttemptId: attemptId(),
    });
    attemptTextLength = 0;
  };
  const onThinkingCheckpoint = () => {
    uncheckpointedThinking = [];
  };
  const onThinkingRollback = () => {
    // Usually all pending reasoning belongs to the current attempt. If it
    // spans requests, undo each part using the ID attached to its deltas.
    for (const part of uncheckpointedThinking.slice().reverse()) {
      emit('mica/reasoning/textRollback', {
        threadId, turnId, itemId: reasoningItemId, length: part.length, micaAttemptId: part.attempt,
      });
      forgetTurnParts(turnAttemptThinking, part.attempt, part.length);
      if (part.attempt === attemptId()) {
        attemptThinkingLength -= part.length;
      } else {
        uncheckpointedAtAttemptStart = uncheckpointedAtAttemptStart.flatMap((previous) => {
          if (previous.attempt !== part.attempt) return [previous];
          const length = previous.length - part.length;
          return length > 0 ? [{ ...previous, length }] : [];
        });
      }
    }
    uncheckpointedThinking = [];
  };
  const onThinkingReset = () => {
    emit('mica/reasoning/reset', { threadId, turnId });
  };
  const onThinkingTurnAttemptStart = () => {
    turnAttemptThinking = [];
    turnAttemptText = [];
  };
  const onThinkingTurnAttemptRollback = () => {
    // Completed requests belong to the discarded client snapshot too. Undo
    // each remaining part exactly once, using the ID attached to its delta.
    if (thinking && context.thinkingRollback) {
      for (const part of turnAttemptThinking.slice().reverse()) {
        emit('mica/reasoning/textRollback', {
          threadId, turnId, itemId: reasoningItemId, length: part.length, micaAttemptId: part.attempt,
        });
      }
    }
    if (context.textRollback) {
      for (const part of turnAttemptText.slice().reverse()) {
        agentMessageText = agentMessageText.slice(0, -part.length);
        emit('mica/agentMessage/textRollback', {
          threadId, turnId, itemId: agentMessageItemId, length: part.length, micaAttemptId: part.attempt,
        });
      }
    }
    turnAttemptThinking = [];
    turnAttemptText = [];
    uncheckpointedThinking = [];
    uncheckpointedAtAttemptStart = [];
    attemptThinkingLength = 0;
    attemptTextLength = 0;
  };
  let unregisterTextRollbackConsumer: (() => void) | undefined;
  if (context.textRollback || (thinking && context.thinkingRollback)) {
    agent.events.on('textAttemptStart', onTextAttemptStart);
  }
  if (context.textRollback) {
    agent.events.on('textRollback', onTextRollback);
    unregisterTextRollbackConsumer = agent.registerTextRollbackConsumer({
      text: handlers.text,
      ...(context.thinkingRollback || !thinking ? { thinking: handlers.thinking } : {}),
      start: onTextAttemptStart,
      rollback: onTextRollback,
    });
  }
  agent.events.on('thinking', handlers.thinking);
  if (context.textRollback || (thinking && context.thinkingRollback)) {
    agent.events.on('thinkingTurnAttemptStart', onThinkingTurnAttemptStart);
    agent.events.on('thinkingTurnAttemptRollback', onThinkingTurnAttemptRollback);
  }
  if (thinking && context.thinkingRollback) {
    agent.events.on('thinkingCheckpoint', onThinkingCheckpoint);
    agent.events.on('thinkingRollback', onThinkingRollback);
    agent.events.on('thinkingReset', onThinkingReset);
  }
  agent.events.on('toolCall', handlers.toolCall);
  agent.events.on('toolResult', handlers.toolResult);
  agent.events.on('usage', handlers.usage);

  const completeAgentMessage = () => {
    if (agentMessageStarted) {
      emitItemCompleted({
        type: 'agentMessage',
        id: agentMessageItemId,
        text: agentMessageText,
      });
      agentMessageStarted = false;
      agentMessageText = '';
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
      unregisterTextRollbackConsumer?.();
      unregisterTextRollbackConsumer = undefined;
      agent.events.off('text', handlers.text);
      agent.events.off('textAttemptStart', onTextAttemptStart);
      agent.events.off('textRollback', onTextRollback);
      agent.events.off('thinking', handlers.thinking);
      agent.events.off('thinkingTurnAttemptStart', onThinkingTurnAttemptStart);
      agent.events.off('thinkingTurnAttemptRollback', onThinkingTurnAttemptRollback);
      agent.events.off('thinkingCheckpoint', onThinkingCheckpoint);
      agent.events.off('thinkingRollback', onThinkingRollback);
      agent.events.off('thinkingReset', onThinkingReset);
      agent.events.off('toolCall', handlers.toolCall);
      agent.events.off('toolResult', handlers.toolResult);
      agent.events.off('usage', handlers.usage);
    },
  };
}
