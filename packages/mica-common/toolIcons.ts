import { normalizeToolName } from './toolNames.js';

/**
 * 没有声明 emoji 的工具用这个兜底：工具行左侧不能空着，否则各行的文字起点会错位。
 *
 * 它只该出现在「真没声明」的工具上——每个内置工具在自己的类里写死 `icon`，
 * 插件在 `ctx.tools.register(tool, { icon })` 里声明。别的地方不要再抄一份名字→emoji
 * 的表：两份表迟早漂移，缺的那一行就退化成这个齿轮。
 */
export const DEFAULT_TOOL_ICON = '⚙️';

/** MCP server 提供的工具：图标表达的是「来源」，不是单个工具，所以统一一个插头。 */
export const MCP_TOOL_ICON = '🔌';

/** 按工具名查已声明的 emoji（注册表用）；查不到返回 undefined。 */
export type ToolIconLookup = (name: string) => string | undefined;

/**
 * 工具行左侧的 emoji。
 *
 * 事实来源是工具自己的声明（`MicaTool.icon`），这里只做三件展示层的事：
 *
 * - 历史工具名归一：`Skill` / `TodoWrite` 这些改名前留下的记录仍要画对（`normalizeToolName`）。
 * - MCP 前缀统一成插头：`mcp__server__tool` 的图标与名字无关。
 * - 查不到时兜底 `DEFAULT_TOOL_ICON`，绝不返回空串。
 */
export function toolIcon(name: string | null | undefined, lookup?: ToolIconLookup): string {
  const raw = String(name ?? '').trim();
  if (!raw) return DEFAULT_TOOL_ICON;
  const normalized = normalizeToolName(raw);
  if (normalized.startsWith('mcp__')) return MCP_TOOL_ICON;
  const declared = lookup?.(normalized) ?? (normalized === raw ? undefined : lookup?.(raw));
  const icon = (declared ?? '').trim();
  return icon || DEFAULT_TOOL_ICON;
}
