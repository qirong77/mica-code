export const COMPACT_TASK_KIND_WIDTH = 12;
export const COMPACT_TASK_STATUS_WIDTH = 8;

export const SUBAGENT_TASK_KIND = '🤖(subagent)';
export const SESSION_TASK_KIND = '# (session)';

export function formatShellTaskKind(shell: string): string {
  return `$ (${formatShellName(shell)})`;
}

export function formatShellName(shell: string): string {
  const normalized = shell.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  const name = normalized.split('/').pop()?.trim();
  return name || 'shell';
}
