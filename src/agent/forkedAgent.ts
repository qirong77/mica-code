import type { MessageParam, TextBlock, ToolResultBlockParam, Usage } from '@mica/llm';
import { getClient } from './client.js';
import { model, EFFORT_TOKENS } from '../store/config.js';
import { getToolDefinitions, executeTool } from '../tools/index.js';

export interface ForkedAgentParams {
  promptMessages: MessageParam[];
  systemPrompt: string;
  allowedTools?: string[] | null;
  maxTurns?: number;
  signal?: AbortSignal;
  thinkingDisabled?: boolean;
  maxTokens?: number;
}

export interface ForkedAgentResult {
  messages: MessageParam[];
  text: string;
  totalUsage: Required<Usage>;
  turnCount: number;
}

export function createForkedAgent(params: ForkedAgentParams) {
  return runForkedAgent(params);
}

export async function runForkedAgent(params: ForkedAgentParams): Promise<ForkedAgentResult> {
  const {
    promptMessages,
    systemPrompt,
    allowedTools = null,
    maxTurns,
    signal,
    thinkingDisabled = false,
    maxTokens = model.maxTokens.get(),
  } = params;

  const client = getClient();
  const modelName = model.name.get();
  const effort = model.effort.get();

  const allTools = getToolDefinitions();
  const tools = allowedTools
    ? allTools.filter(t => allowedTools.includes(t.name))
    : allTools;

  const messages: MessageParam[] = [...promptMessages];

  const totalUsage: Required<Usage> = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  let turnCount = 0;
  let finalText = '';

  while (true) {
    if (signal?.aborted) break;
    if (maxTurns !== undefined && turnCount >= maxTurns) break;
    turnCount++;

    const response = await client.messages.create({
      model: modelName,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages,
      thinking: thinkingDisabled
        ? { type: 'disabled' as const }
        : { type: 'enabled' as const, budget_tokens: EFFORT_TOKENS[effort] || 4000 },
      output_config: !thinkingDisabled && effort !== 'none' ? { effort } : undefined,
      tools: tools.length > 0 ? tools : undefined,
    });

    if (response.usage) {
      totalUsage.input_tokens += response.usage.input_tokens ?? 0;
      totalUsage.output_tokens += response.usage.output_tokens ?? 0;
      totalUsage.cache_read_input_tokens += response.usage.cache_read_input_tokens ?? 0;
      totalUsage.cache_creation_input_tokens += response.usage.cache_creation_input_tokens ?? 0;
    }

    messages.push({ role: 'assistant' as const, content: response.content });

    const toolUses = response.content.filter(block => block.type === 'tool_use');

    if (toolUses.length === 0) {
      finalText = response.content
        .filter(block => block.type === 'text')
        .map(b => (b as TextBlock).text)
        .join('\n');
      break;
    }

    const toolResults: ToolResultBlockParam[] = [];
    for (const block of toolUses) {
      if (signal?.aborted) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: '已中断',
        });
        continue;
      }
      const result = await executeTool(block.name, block.input as Record<string, any>, { signal });
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  return { messages, text: finalText, totalUsage, turnCount };
}
