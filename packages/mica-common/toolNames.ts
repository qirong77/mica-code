/**
 * 工具命名规则：一律 snake_case 全小写，与内置工具（`read_file`、`run_shell`、
 * `background_tasks_*`、`pty_*`）和 MCP 工具前缀保持一致。终端里模型对
 * `session_notes` 这类名字的猜测成本，明显低于 `SessionNotes`。
 *
 * 这里只登记历史遗留的大驼峰名字：改名后旧会话保存的能力开关、旧对话里的工具行
 * 仍要能对上同一个工具，所以读取处统一过一遍 `normalizeToolName`。
 */
export const LEGACY_TOOL_NAMES: Record<string, string> = {
  Skill: 'skill',
  Agent: 'agent',
  TodoWrite: 'todo_write',
  SessionNotes: 'session_notes',
};

/** 把历史工具名映射到当前规范名；未登记的名字原样返回。 */
export function normalizeToolName(name: string | null | undefined): string {
  const value = String(name ?? '');
  return LEGACY_TOOL_NAMES[value] ?? value;
}
