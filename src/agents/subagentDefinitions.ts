import { micaAgent } from '@packages/mica-agent/index.js';

export type SubagentContextMode = 'none' | 'brief' | 'recent' | 'files';
export type SubagentWriteMode = 'none' | 'owned_paths' | 'proposal' | 'unrestricted';

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
  /** Default delegated context mode when parent omits context_mode. */
  contextModeDefault?: SubagentContextMode;
  /**
   * Write policy for mutable tools.
   * - none: writes disallowed by tool filter
   * - owned_paths: writes allowed only within owned_paths
   * - proposal: do not write; return patch proposals for parent apply
   * - unrestricted: existing general-purpose behavior
   */
  writeMode?: SubagentWriteMode;
  /** When true, parent must provide owned_paths for writable/proposal subagents. */
  requireOwnedPaths?: boolean;
};

const SUBAGENT_INSTRUCTIONS = [
  '<subagent-instructions>',
  'You are running as a subagent for the primary Mica Code agent.',
  'Complete only the delegated task and return a concise, evidence-backed summary for the parent agent.',
  'Do not ask the user for follow-up unless the delegated task is impossible without it.',
  'If you read files or run commands, mention the key paths, commands, and outcomes that matter.',
  'Prefer a final answer that includes: summary, findings, files_touched, risks, and next_actions_for_parent.',
  'JSON object output is preferred when practical.',
  '</subagent-instructions>',
].join('\n');

const READ_ONLY_TOOLS = [
  'read_file',
  'read_image',
  'list_files',
  'grep_search',
  'background_tasks',
  'read_task_output',
  'web_fetch',
  'web_search',
  'Skill',
];

export const BUILTIN_SUBAGENTS: SubagentDefinition[] = [
  {
    name: 'general-purpose',
    description:
      'General-purpose subagent for multi-step research, code investigation, and focused implementation help.',
    disallowedTools: ['Agent'],
    maxTurns: 30,
    effort: true,
    contextModeDefault: 'brief',
    writeMode: 'unrestricted',
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
    allowedTools: READ_ONLY_TOOLS,
    disallowedTools: ['Agent'],
    maxTurns: 20,
    effort: true,
    contextModeDefault: 'brief',
    writeMode: 'none',
    systemPrompt: [
      '<role>',
      'You are a read-only exploration subagent. Find and summarize relevant context without modifying files or starting new agents.',
      'Prefer list_files, grep_search, and read_file. Do not run write, patch, shell, kill, or Agent tools.',
      'Return the key files, symbols, behavior, and any uncertainty. Do not include implementation unless explicitly asked.',
      '</role>',
    ].join('\n'),
  },
  {
    name: 'Implementer',
    description:
      'Writable implementation subagent for scoped code changes. Requires owned_paths and only writes inside that lease.',
    disallowedTools: ['Agent'],
    maxTurns: 30,
    effort: true,
    contextModeDefault: 'files',
    writeMode: 'owned_paths',
    requireOwnedPaths: true,
    systemPrompt: [
      '<role>',
      'You are an implementation subagent. Make focused code changes only within the provided owned_paths.',
      'Do not modify files outside owned_paths. Prefer apply_patch for multi-hunk edits.',
      'Return what changed, verification performed, residual risks, and what the parent should do next.',
      '</role>',
    ].join('\n'),
  },
  {
    name: 'Reviewer',
    description: 'Read-only code review subagent for diffs, risks, and missing tests.',
    allowedTools: READ_ONLY_TOOLS,
    disallowedTools: ['Agent'],
    maxTurns: 20,
    effort: true,
    contextModeDefault: 'files',
    writeMode: 'none',
    systemPrompt: [
      '<role>',
      'You are a review subagent. Inspect the relevant code or diff and report bugs, regressions, risks, and missing tests.',
      'Do not modify files. Rank findings by severity and include concrete file paths.',
      '</role>',
    ].join('\n'),
  },
  {
    name: 'Tester',
    description: 'Verification subagent that can run tests/typecheck within owned_paths and report outcomes.',
    allowedTools: [...READ_ONLY_TOOLS, 'run_shell', 'background_tasks', 'read_task_output', 'kill_task'],
    disallowedTools: ['Agent', 'write_file', 'apply_patch'],
    maxTurns: 20,
    effort: true,
    contextModeDefault: 'brief',
    writeMode: 'owned_paths',
    requireOwnedPaths: true,
    systemPrompt: [
      '<role>',
      'You are a verification subagent. Run the smallest relevant tests, typecheck, or commands inside owned_paths.',
      'Do not modify source files. Return pass/fail, key command outputs, and next fixes for the parent.',
      '</role>',
    ].join('\n'),
  },
  {
    name: 'Planner',
    description: 'Planning subagent that returns a task graph and ownership plan without modifying files.',
    allowedTools: READ_ONLY_TOOLS,
    disallowedTools: ['Agent'],
    maxTurns: 15,
    effort: true,
    contextModeDefault: 'recent',
    writeMode: 'none',
    systemPrompt: [
      '<role>',
      'You are a planning subagent. Produce a concrete execution plan with parallelizable tasks, owned_paths, dependencies, and risks.',
      'Do not modify files. Prefer JSON with tasks[{id,description,subagent_type,owned_paths,depends_on}].',
      '</role>',
    ].join('\n'),
  },
  {
    name: 'Proposal',
    description:
      'Proposal-mode implementation subagent. Requires owned_paths, cannot write files, and must return patch proposals for parent apply.',
    allowedTools: READ_ONLY_TOOLS,
    disallowedTools: ['Agent', 'write_file', 'apply_patch', 'run_shell', 'kill_task'],
    maxTurns: 25,
    effort: true,
    contextModeDefault: 'files',
    writeMode: 'proposal',
    requireOwnedPaths: true,
    systemPrompt: [
      '<role>',
      'You are a proposal subagent. Analyze code inside owned_paths and return one or more Codex-style patches.',
      'Do not write files or run shell. Put each patch in a fenced code block starting with *** Begin Patch.',
      'Also summarize intent, touched files, risks, and apply order for the parent agent.',
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
  const writePolicy = [
    '<write-policy>',
    `write_mode: ${definition.writeMode ?? 'unrestricted'}`,
    definition.requireOwnedPaths
      ? 'owned_paths are required and must be respected for any mutable action.'
      : 'owned_paths may be provided to further restrict mutable actions.',
    definition.writeMode === 'proposal'
      ? 'Do not write files. Return patch proposals only.'
      : definition.writeMode === 'none'
        ? 'Do not write files or run mutating shell commands.'
        : 'Prefer minimal, reversible changes.',
    '</write-policy>',
  ].join('\n');
  return [micaAgent.buildSystemPrompt(), '', SUBAGENT_INSTRUCTIONS, '', writePolicy, '', definition.systemPrompt].join(
    '\n',
  );
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
