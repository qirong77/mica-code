import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { PluginDataApi } from './PluginData.js';
import type { PluginSettingsStore } from './PluginSettings.js';

/** 随包插件 mcp.ts 的独立宿主；不提供会话、agent 或任意 HTTP 路由能力。 */
export type PluginMcpContext = {
  pluginId: string;
  data: PluginDataApi;
  settings: Pick<PluginSettingsStore, 'get'>;
};

/** 工具定义与执行共用一份契约，宿主负责 MCP 编解码和输入 schema 校验。 */
export type PluginMcpTool = Tool & {
  execute(input: Record<string, unknown>, context: { signal: AbortSignal }): unknown | Promise<unknown>;
};

/** default createMcp(context) 的返回值；插件停用或应用退出时释放。 */
export type PluginMcpHandler = {
  instructions?: string;
  tools: PluginMcpTool[];
  dispose?(): void | Promise<void>;
};

/** 应用只监听现有端口，每个插件占用自己的路径而不是另起服务。 */
export const PLUGIN_MCP_PREFIX = '/plugin';

export function pluginMcpPath(pluginId: string): string {
  return `${PLUGIN_MCP_PREFIX}/${encodeURIComponent(pluginId)}/mcp`;
}

export function pluginMcpServerName(pluginId: string): string {
  return `mica-plugin-${pluginId}`;
}

export function pluginMcpId(pathname: string): string | null {
  return /^\/plugin\/([a-z0-9][a-z0-9._-]*)\/mcp$/.exec(pathname)?.[1] ?? null;
}
