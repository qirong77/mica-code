import type Anthropic from '@anthropic-ai/sdk';
import { getClient } from './client.js';
import { model, EFFORT_TOKENS } from '../store/config.js';
import { executeTool } from '../tools/index.js';

export interface SubAgentOptions {
  /** 自定义 system prompt */
  systemPrompt: string;
  /** 可用工具定义，默认不传工具 */
  tools?: Anthropic.Tool[];
  /** 是否关闭 thinking，默认关闭 */
  thinkingDisabled?: boolean;
  /** max_tokens，默认 4096 */
  maxTokens?: number;
}

export interface SubAgentResult {
  text: string;
  messages: Anthropic.MessageParam[];
}

/**
 * 创建一个独立 sub-agent，不经过主 agent 会话/中间件链。
 * 返回一个 run(messages) 函数，内部闭环 tool 调用直到无 tool_use 为止。
 */
export function createSubAgent(options: SubAgentOptions) {
  const {
    systemPrompt,
    tools = [],
    thinkingDisabled = true,
    maxTokens = 4096,
  } = options;

  return async function run(
    userMessages: Anthropic.MessageParam[],
  ): Promise<SubAgentResult> {
    const client = getClient();
    const modelName = model.name.get();
    const effort = model.effort.get();

    const messages: Anthropic.MessageParam[] = [...userMessages];

    while (true) {
      const response = await client.messages.create({
        model: modelName,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages,
        thinking: thinkingDisabled
          ? { type: 'disabled' }
          : { type: 'enabled', budget_tokens: EFFORT_TOKENS[effort] || 4000 },
        output_config: !thinkingDisabled && effort !== 'none' ? { effort } : undefined,
        tools: tools.length > 0 ? tools : undefined,
      });

      const assistantBlock: Anthropic.MessageParam = {
        role: 'assistant' as const,
        content: response.content,
      };
      messages.push(assistantBlock);

      const toolUses = response.content.filter((block) => block.type === 'tool_use');

      if (toolUses.length === 0) {
        const textBlocks = response.content.filter((block) => block.type === 'text');
        const text = textBlocks.map((b) => (b as Anthropic.TextBlock).text).join('\n');
        return { text, messages };
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUses) {
        const result = await executeTool(block.name, block.input as Record<string, any>);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }
  };
}