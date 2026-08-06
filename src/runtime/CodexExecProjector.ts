import type { AgentUsageRecord } from '@packages/mica-agent/index.js';
import { emptyCodexExecUsage, type CodexExecEventWriter, type CodexExecUsage } from '@packages/mica-runtime/index.js';
import type { AgentRuntime, AgentRuntimeEvents } from '../agent/AgentRuntime.js';

type ProjectorHandlers = {
  [K in keyof AgentRuntimeEvents]: (payload: AgentRuntimeEvents[K]) => void;
};

export type CodexExecProjector = {
  completeText(finalText: string): string;
  dispose(): void;
  getText(): string;
  getUsage(): CodexExecUsage;
};

export function attachCodexExecProjector(
  agent: AgentRuntime,
  writer: CodexExecEventWriter,
  threadId: string,
  options: { thinking?: boolean } = {},
): CodexExecProjector {
  const textParts: string[] = [];
  const usage = emptyCodexExecUsage();
  const handlers: ProjectorHandlers = {
    text: (text) => {
      if (!text) return;
      textParts.push(text);
      writer.write({
        type: 'item.updated',
        item: { id: 'agent-message', type: 'agent_message', text: textParts.join('') },
      });
    },
    thinking: (text) => {
      if (!options.thinking || !text) return;
      writer.write({
        type: 'item.updated',
        item: { id: 'reasoning', type: 'reasoning', text },
      });
    },
    toolCall: ({ name, args, id }) => {
      writer.write({
        type: 'item.started',
        item: {
          id: id || `command-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'command_execution',
          command: `${name} ${truncateToolArgs(args)}`.trim(),
          aggregated_output: '',
          exit_code: null,
          status: 'in_progress',
        },
      });
    },
    toolResult: ({ name, result, id }) => {
      writer.write({
        type: 'item.completed',
        item: {
          id: id || `command-${Date.now()}`,
          type: 'command_execution',
          command: name,
          aggregated_output: truncateToolOutput(result),
          exit_code: 0,
          status: 'completed',
        },
      });
    },
    usage: (record) => addUsage(usage, record),
    // Subagent usage is persisted with the session snapshot; the exec event
    // protocol has no subagent event shape, so projection ignores it.
    subagentUsage: () => undefined,
    status: () => undefined,
  };

  agent.events.on('text', handlers.text);
  agent.events.on('thinking', handlers.thinking);
  agent.events.on('toolCall', handlers.toolCall);
  agent.events.on('toolResult', handlers.toolResult);
  agent.events.on('usage', handlers.usage);

  writer.write({ type: 'thread.started', thread_id: threadId });
  writer.write({ type: 'turn.started' });

  return {
    completeText(finalText) {
      const streamed = textParts.join('');
      if (!finalText || finalText === streamed) {
        const text = streamed || finalText;
        if (text) {
          writer.write({ type: 'item.completed', item: { id: 'agent-message', type: 'agent_message', text } });
        }
        return text;
      }
      if (finalText.startsWith(streamed)) {
        const suffix = finalText.slice(streamed.length);
        if (suffix) handlers.text(suffix);
        const full = streamed + suffix;
        writer.write({ type: 'item.completed', item: { id: 'agent-message', type: 'agent_message', text: full } });
        return full;
      }
      if (!streamed) {
        handlers.text(finalText);
        writer.write({
          type: 'item.completed',
          item: { id: 'agent-message', type: 'agent_message', text: finalText },
        });
        return finalText;
      }
      writer.write({ type: 'item.completed', item: { id: 'agent-message', type: 'agent_message', text: streamed } });
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

function addUsage(total: CodexExecUsage, usage: AgentUsageRecord): void {
  const cacheRead = Math.max(0, usage.cachedInputTokens ?? 0);
  total.input_tokens += Math.max(0, usage.inputTokens - cacheRead);
  total.cached_input_tokens += cacheRead;
  total.output_tokens += Math.max(0, usage.outputTokens);
  // Mica's provider-neutral usage record currently has no cache-write field.
  total.cache_write_input_tokens += 0;
}

function truncateToolArgs(args: string, maxChars = 512): string {
  return args.length <= maxChars ? args : `${args.slice(0, maxChars)}...`;
}

function truncateToolOutput(result: string, maxChars = 256 * 1024): string {
  if (result.length <= maxChars) return result;
  return `${result.slice(0, maxChars)}\n...[truncated by Mica: ${result.length - maxChars} chars omitted]`;
}
