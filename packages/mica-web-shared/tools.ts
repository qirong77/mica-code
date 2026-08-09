// Tool display vocabulary shared by apps/sync/web and apps/desktop renderer.
// Pure functions only, matching the desktop ChatView tool-row grammar so both
// UIs show the same icon/label for the same tool.

const TOOL_ICONS: Record<string, string> = {
  read_file: '📖',
  read_image: '📷',
  write_file: '✍️',
  apply_patch: '🩹',
  list_files: '📂',
  grep_search: '📊',
  run_shell: '⚡️',
  web_fetch: '🔗',
  web_search: '🌐',
  Skill: '✨',
  Agent: '🤖',
  TodoWrite: '📝',
  background_tasks: '📋',
  read_task_output: '📋',
  kill_task: '📋',
};

export function toolIcon(toolName: string | null | undefined): string {
  if (String(toolName || '').startsWith('mcp__')) return '🔌';
  return TOOL_ICONS[toolName ?? ''] || '⚙';
}

const TOOL_LABELS: Record<string, string> = {
  read_file: 'Read file',
  read_image: 'Read image',
  write_file: 'Write file',
  apply_patch: 'Apply patch',
  list_files: 'List files',
  grep_search: 'Search code',
  run_shell: 'Shell',
  web_fetch: 'Fetch web',
  web_search: 'Search web',
  Skill: 'Load skill',
  Agent: 'Subagent',
  TodoWrite: 'Plan',
  background_tasks: 'Background tasks',
  read_task_output: 'Task output',
  kill_task: 'Stop task',
};

/** Human label for a tool name; MCP tools render as `[MCP:server] tool` (hash suffix stripped). */
export function toolLabel(toolName: string | null | undefined): string {
  const name = String(toolName || '');
  if (name.startsWith('mcp__')) {
    const match = /^mcp__([^_]+)__(.+)$/.exec(name);
    if (match) {
      const server = match[1];
      const toolPart = String(match[2]).replace(/_[0-9a-f]{8}$/, '');
      return `[MCP:${server}] ${toolPart}`;
    }
  }
  return TOOL_LABELS[name] || name;
}
