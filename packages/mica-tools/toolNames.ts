/**
 * MCP 工具名统一为 `mcp__<server>__<tool>_<hash>`。能力选择按 server 关闭时，
 * 用同一个前缀判断即可，不依赖 server 侧的工具清单是否已刷新。
 */
export function sanitizeToolNamePart(value: string, maxLength: number): string {
  const sanitized = value
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const fallback = sanitized || 'tool';
  return fallback.slice(0, maxLength);
}

export function mcpToolNamePrefix(serverName: string): string {
  return `mcp__${sanitizeToolNamePart(serverName, 20)}__`;
}
