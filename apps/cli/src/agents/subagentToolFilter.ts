import { micaTools } from '@packages/mica-tools/index.js';
import type { PluginSubagentType } from '@packages/mica-plugin/index.js';

/**
 * 插件子代理 / 旁问线程的工具边界：唯一实现在这里，两种调用方共用。
 *
 * - 主会话专属工具（`primaryAgentOnly`：`session_*`、loop 等）一律不给。它们在
 *   `toolContext` 里拿不到主 agent，运行期那道护栏对子代理不生效，只能在工具集
 *   这一层排除；
 * - `skills` 与 MCP 是进程级能力，不该被某个类型的白名单削弱；
 * - 其余按类型声明的白 / 黑名单收窄。
 */
export function buildSubagentToolFilter(
  policy: Pick<PluginSubagentType, 'allowedTools' | 'disallowedTools'>,
): (toolName: string) => boolean {
  const allowed = new Set(policy.allowedTools ?? ['*']);
  const disallowed = new Set(policy.disallowedTools ?? []);
  return (toolName: string) => {
    if (micaTools.isPrimaryAgentOnly(toolName)) return false;
    if (disallowed.has(toolName)) return false;
    if (toolName === 'skill' || toolName.startsWith('mcp__')) return true;
    return allowed.has('*') || allowed.has(toolName);
  };
}
