import type { AgentUsageRecord } from '@packages/mica-agent/index.js';
import {
  chunkRunJsonText,
  emptyRunJsonTokenUsage,
  parseToolCallInput,
  truncateRunJsonToolOutput,
  type RunJsonEvent,
  type RunJsonTokenUsage,
  type RunJsonWriter,
} from '@packages/mica-runtime/index.js';
import type { AgentRuntime, AgentRuntimeEvents } from '../agent/AgentRuntime.js';

type ProjectorHandlers = {
  [K in keyof AgentRuntimeEvents]: (payload: AgentRuntimeEvents[K]) => void;
};

type PendingToolCall = {
  callID: string;
  name: string;
  input: Record<string, unknown>;
};

export type RunJsonProjector = {
  completeText(finalText: string): string;
  dispose(): void;
  getText(): string;
  getUsage(): RunJsonTokenUsage;
};

export function attachRunJsonProjector(
  agent: AgentRuntime,
  writer: RunJsonWriter,
  sessionID: string,
): RunJsonProjector {
  const pendingByID = new Map<string, PendingToolCall>();
  const pendingByName = new Map<string, PendingToolCall[]>();
  const textParts: string[] = [];
  const usage = emptyRunJsonTokenUsage();
  const handlers: ProjectorHandlers = {
    text: (text) => {
      if (!text) return;
      for (const chunk of chunkRunJsonText(text)) {
        textParts.push(chunk);
        writer.write({
          type: 'text',
          timestamp: Date.now(),
          sessionID,
          part: { type: 'text', text: chunk },
        });
      }
    },
    // The DevEco run-json dialect has no thinking event. Keeping reasoning off
    // the text channel prevents it from polluting Multica's final task output.
    thinking: () => undefined,
    toolCall: ({ name, args, id }) => {
      const call: PendingToolCall = {
        callID: id || `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        input: parseToolCallInput(args),
      };
      if (id) {
        pendingByID.set(id, call);
      } else {
        const queue = pendingByName.get(name) ?? [];
        queue.push(call);
        pendingByName.set(name, queue);
      }
    },
    toolResult: ({ name, result, id }) => {
      const call = takePendingTool(pendingByID, pendingByName, name, id) ?? {
        callID: id || `${name}-${Date.now()}`,
        name,
        input: {},
      };
      const event: RunJsonEvent = {
        type: 'tool_use',
        timestamp: Date.now(),
        sessionID,
        part: {
          type: 'tool',
          tool: call.name,
          callID: call.callID,
          state: {
            status: 'completed',
            input: call.input,
            output: truncateRunJsonToolOutput(result),
          },
        },
      };
      writer.write(event);
    },
    usage: (record) => addUsage(usage, record),
    status: () => undefined,
  };

  agent.events.on('text', handlers.text);
  agent.events.on('thinking', handlers.thinking);
  agent.events.on('toolCall', handlers.toolCall);
  agent.events.on('toolResult', handlers.toolResult);
  agent.events.on('usage', handlers.usage);

  return {
    completeText(finalText) {
      const streamed = textParts.join('');
      if (!finalText || finalText === streamed) return streamed || finalText;
      if (finalText.startsWith(streamed)) {
        const suffix = finalText.slice(streamed.length);
        if (suffix) handlers.text(suffix);
        return finalText;
      }
      // Provider callbacks are expected to stream the final answer. If a
      // provider emits no deltas at all, recover by publishing its final text.
      if (!streamed) {
        handlers.text(finalText);
        return finalText;
      }
      return streamed;
    },
    getText() {
      return textParts.join('');
    },
    getUsage() {
      return { ...usage };
    },
    dispose() {
      agent.events.off('text', handlers.text);
      agent.events.off('thinking', handlers.thinking);
      agent.events.off('toolCall', handlers.toolCall);
      agent.events.off('toolResult', handlers.toolResult);
      agent.events.off('usage', handlers.usage);
    },
  };
}

function takePendingTool(
  pendingByID: Map<string, PendingToolCall>,
  pendingByName: Map<string, PendingToolCall[]>,
  name: string,
  id?: string,
): PendingToolCall | undefined {
  if (id) {
    const exact = pendingByID.get(id);
    if (exact) pendingByID.delete(id);
    return exact;
  }
  const queue = pendingByName.get(name);
  const next = queue?.shift();
  if (queue?.length === 0) pendingByName.delete(name);
  return next;
}

function addUsage(total: RunJsonTokenUsage, usage: AgentUsageRecord): void {
  const cacheRead = Math.max(0, usage.cachedInputTokens ?? 0);
  total.input += Math.max(0, usage.inputTokens - cacheRead);
  total.output += Math.max(0, usage.outputTokens);
  total.cacheRead += cacheRead;
  // Mica's provider-neutral usage record currently has no cache-write field.
  total.total += Math.max(0, usage.totalTokens);
}
