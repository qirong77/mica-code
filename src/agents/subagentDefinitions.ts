import { micaAgent } from '@packages/mica-agent/index.js';

export type SubagentDefinition = {
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
  /** Whether the parent agent may select reasoning effort. Defaults to true. */
  effort?: boolean;
};

const SUBAGENT_INSTRUCTIONS = [
  '<subagent-instructions>',
  'You are running as a subagent for the primary Mica Code agent.',
  'Complete only the delegated task and return a concise, evidence-backed summary for the parent agent.',
  'Do not ask the user for follow-up unless the delegated task is impossible without it.',
  'If you read files or run commands, mention the key paths, commands, and outcomes that matter.',
  '</subagent-instructions>',
].join('\n');

export const BUILTIN_SUBAGENTS: SubagentDefinition[] = [
  {
    name: 'general-purpose',
    description:
      'General-purpose subagent for multi-step research, code investigation, and focused implementation help.',
    disallowedTools: ['Agent'],
    maxTurns: 30,
    effort: true,
    systemPrompt: [
      '<role>',
      'You are a general-purpose coding subagent. Use the available tools to finish the delegated task autonomously.',
      'Keep the final answer compact and useful to the parent agent.',
      '</role>',
    ].join('\n'),
  },
  {
    name: 'Explore',
    description:
      'Read-only code exploration subagent for searching, reading, and summarizing relevant project context.',
    allowedTools: [
      'read_file',
      'list_files',
      'grep_search',
      'background_tasks',
      'read_task_output',
      'web_fetch',
      'web_search',
      'Skill',
    ],
    disallowedTools: ['Agent'],
    maxTurns: 20,
    effort: true,
    systemPrompt: [
      '<role>',
      'You are a read-only exploration subagent. Find and summarize relevant context without modifying files or starting new agents.',
      'Prefer list_files, grep_search, and read_file. Do not run write, patch, shell, kill, or Agent tools.',
      'Return the key files, symbols, behavior, and any uncertainty. Do not include implementation unless explicitly asked.',
      '</role>',
    ].join('\n'),
  },
];

const subagentByName = new Map(BUILTIN_SUBAGENTS.map((agent) => [normalizeSubagentName(agent.name), agent]));

export function listSubagents(): SubagentDefinition[] {
  return [...BUILTIN_SUBAGENTS];
}

export function getSubagent(name: string | undefined): SubagentDefinition {
  const normalized = normalizeSubagentName(name || 'general-purpose');
  const definition = subagentByName.get(normalized);
  if (definition) return definition;
  throw new Error(
    `Unknown subagent_type: ${name}. Available types: ${BUILTIN_SUBAGENTS.map((agent) => agent.name).join(', ')}`,
  );
}

export function buildSubagentSystemPrompt(definition: SubagentDefinition): string {
  return [micaAgent.buildSystemPrompt(), '', SUBAGENT_INSTRUCTIONS, '', definition.systemPrompt].join('\n');
}

export function buildSubagentToolFilter(definition: SubagentDefinition): (toolName: string) => boolean {
  const allowed = new Set(definition.allowedTools ?? ['*']);
  const disallowed = new Set(definition.disallowedTools ?? []);
  return (toolName: string) => {
    if (disallowed.has(toolName)) return false;
    return allowed.has('*') || allowed.has(toolName);
  };
}

function normalizeSubagentName(name: string): string {
  return name.trim().toLowerCase();
}
