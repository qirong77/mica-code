import type { PluginSubagentType } from '@packages/mica-plugin/index.js';

/**
 * 内置子代理类型。
 *
 * 类型是策略而不是机制：宿主只管「怎么建、怎么跑、怎么写盘」，具体有哪几种、每种能给
 * 哪些工具、默认塞多少上下文，全在这里声明，内核里没有一处写死 `Explore` 之类的名字。
 */

const READ_ONLY_TOOLS = [
  'read_file',
  'read_image',
  'list_files',
  'grep_search',
  'background_tasks_list',
  'background_tasks_read',
  'web_fetch',
  'web_search',
  'skill',
];

/**
 * 子代理默认的迭代上限。
 *
 * 它只是「跑不完就别再烧钱」的护栏，不是目标值——正常任务会在远低于它的轮次里收尾，
 * 定低了则会让长任务（多文件重构、需要反复验证的实现）在中途被 `AgentMaxTurnsError`
 * 掐断，父代理只能拿到半成品再重开一个子代理、把已完成的工作重做一遍。所以这里给得
 * 比「一般够用」更宽：真正限制成本的是任务本身的形状，而不是这条上限。
 */
export const DEFAULT_SUBAGENT_MAX_TURNS = 100;

export const BUILTIN_SUBAGENTS: PluginSubagentType[] = [
  {
    name: 'general-purpose',
    description:
      'General-purpose subagent for multi-step research, code investigation, and focused implementation help.',
    disallowedTools: ['agent'],
    maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
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
    disallowedTools: ['agent'],
    maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
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
    disallowedTools: ['agent'],
    maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
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
    disallowedTools: ['agent'],
    maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
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
    allowedTools: [
      ...READ_ONLY_TOOLS,
      'run_shell',
      'background_tasks_start',
      'background_tasks_list',
      'background_tasks_read',
      'background_tasks_kill',
      'wait_for',
    ],
    disallowedTools: ['agent', 'write_file', 'apply_patch'],
    maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
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
    disallowedTools: ['agent'],
    maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
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
    disallowedTools: [
      'agent',
      'write_file',
      'apply_patch',
      'run_shell',
      'background_tasks_start',
      'background_tasks_kill',
    ],
    maxTurns: DEFAULT_SUBAGENT_MAX_TURNS,
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

/**
 * 按名字找类型。
 *
 * 大小写不敏感：模型经常把 `Explore` 写成 `explore`，为此拒绝一整次委派没有意义。
 * 找不到就抛错并列出可用类型——这比静默回退到 general-purpose 好，后者会让
 * 「只读调研」悄悄变成一次可写委派。
 */
export function getBuiltinSubagent(types: readonly PluginSubagentType[], name: string | undefined): PluginSubagentType {
  const normalized = normalizeSubagentName(name || 'general-purpose');
  const definition = types.find((type) => normalizeSubagentName(type.name) === normalized);
  if (definition) return definition;
  throw new Error(`Unknown subagent_type: ${name}. Available types: ${types.map((type) => type.name).join(', ')}`);
}

function normalizeSubagentName(name: string): string {
  return name.trim().toLowerCase();
}
