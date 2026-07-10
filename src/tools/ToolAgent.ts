import { MicaTool, type ToolExecuteCallbacks, type ToolInput } from '@packages/mica-tools/index.js';
import type { ModelClientOptions } from '@packages/mica-agent/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { buildSubagentToolFilter, getSubagent, listSubagents } from '../agents/subagentDefinitions.js';

type AgentToolContext = {
  agent?: AgentRuntime;
  createClientOptions?: (overrides?: Partial<ModelClientOptions>) => ModelClientOptions;
};

type AgentToolInput = ToolInput & {
  description: string;
  prompt: string;
  subagent_type?: string;
  run_in_background?: boolean;
};

export class ToolAgent extends MicaTool {
  constructor(private readonly fallbackAgent: AgentRuntime) {
    super(
      'Agent',
      `启动一个 subagent 来完成独立任务。默认同步等待结果，也可通过 run_in_background 在后台运行。可用 subagent_type: ${listSubagents()
        .map((agent) => `${agent.name} (${agent.description})`)
        .join('; ')}。`,
      {
        type: 'object' as const,
        properties: {
          description: { type: 'string', description: '给父 agent 和 UI 看的简短任务描述。' },
          prompt: { type: 'string', description: '交给 subagent 执行的完整任务说明。' },
          subagent_type: { type: 'string', description: 'subagent 类型，默认 general-purpose。' },
          run_in_background: {
            type: 'boolean',
            description: '设为 true 在后台运行，不等待 subagent 完成。默认 false。',
          },
        },
        required: ['description', 'prompt'],
      },
    );
  }

  async execute(input: AgentToolInput, callbacks?: ToolExecuteCallbacks): Promise<string> {
    const prompt = String(input.prompt ?? '').trim();
    if (!prompt) return '错误：Agent 工具需要非空 prompt。';

    const definition = getSubagent(input.subagent_type);
    const context = isAgentToolContext(callbacks?.context) ? callbacks.context : undefined;
    const parentAgent = context?.agent ?? this.fallbackAgent;
    const createClientOptions = context?.createClientOptions ?? parentAgent.createClientOptions.bind(parentAgent);
    const toolFilter = buildSubagentToolFilter(definition);

    callbacks?.onChunk?.(`[Agent:${definition.name}] start ${input.description}\n`);
    const child = parentAgent.createSubAgent({
      ...createClientOptions({
        model: definition.model,
        systemPrompt: definition.systemPrompt,
        tools: true,
        toolFilter,
        toolContext: {
          agent: parentAgent,
          createClientOptions,
        } satisfies AgentToolContext,
      }),
      effort: 'none',
    });
    if (input.run_in_background) {
      void child.query(prompt, { signal: callbacks?.signal }).then(
        () => callbacks?.onChunk?.(`[Agent:${definition.name}] completed ${input.description}\n`),
        (error: unknown) =>
          callbacks?.onChunk?.(
            `[Agent:${definition.name}] failed ${input.description}: ${formatErrorMessage(error)}\n`,
          ),
      );
      return `Subagent ${definition.name} 已在后台启动：${input.description}`;
    }

    const result = await child.query(prompt, { signal: callbacks?.signal });
    return formatSubagentResult(definition.name, input.description, result);
  }

  onToolUseDisplayText(input: ToolInput): string {
    const type =
      typeof input.subagent_type === 'string' && input.subagent_type.trim() ? input.subagent_type : 'general-purpose';
    const description = typeof input.description === 'string' ? input.description : 'task';
    return `Agent ${type}: ${description}`;
  }
}

function isAgentToolContext(value: unknown): value is AgentToolContext {
  return Boolean(value && typeof value === 'object');
}

function formatSubagentResult(type: string, description: string, result: string): string {
  return [`Subagent: ${type}`, `Task: ${description}`, '', result.trim() || '(empty result)'].join('\n');
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
