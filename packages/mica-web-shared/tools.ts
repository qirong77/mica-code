import { normalizeToolName } from '@packages/mica-common/toolNames.js';
import { toolIcon as resolveToolIcon } from '@packages/mica-common/toolIcons.js';

// Tool display vocabulary shared by the desktop renderer and runtime.
// Pure functions only, matching the desktop ChatView tool-row grammar so both
// UIs show the same icon/label for the same tool.

/**
 * 工具行左侧的 emoji。
 *
 * `icons` 是宿主给的「已注册工具的图标」投影（`$MICA_HOME/tool-icons.json`，
 * 桌面经 `chat:tool-icons` 拿到）。**这里不存静态表**：emoji 的事实来源是工具自己的
 * 声明，抄一份到界面就会漂移，缺的那些行只能显示默认齿轮。
 */
export function toolIcon(
  toolName: string | null | undefined,
  icons?: Record<string, string> | null,
): string {
  return resolveToolIcon(toolName, (name) => icons?.[name]);
}

const TOOL_LABELS: Record<string, string> = {
  read_file: 'Read file',
  read_image: 'Read image',
  write_file: 'Write file',
  apply_patch: 'Apply patch',
  list_files: 'List files',
  grep_search: 'Search code',
  run_shell: 'Shell',
  background_tasks_start: 'Start task',
  web_fetch: 'Fetch web',
  web_search: 'Search web',
  skill: 'Load skill',
  agent: 'Subagent',
  todo_write: 'Plan',
  session_notes: 'Session notes',
  background_tasks_list: 'List tasks',
  background_tasks_kill: 'Stop task',
  background_tasks_read: 'Task output',
  wait_for: 'Wait for',
};

/** Human label for a tool name; MCP tools render as `[MCP:server] tool` (hash suffix stripped). */
export function toolLabel(toolName: string | null | undefined): string {
  const name = normalizeToolName(toolName);
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
