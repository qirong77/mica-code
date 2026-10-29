import type { McpServerConfig } from './config.js';

export type McpCatalogEntry = {
  name: string;
  /** `connected` / `connecting` / `failed`，没连过（或还没开始连）的是 `configured`。 */
  status: string;
  toolCount: number;
};

export type McpCatalogInput = {
  /** `$MICA_HOME/config.json` 里的 server。 */
  configured?: Record<string, McpServerConfig>;
  /** 会话显式带的 `--mcp-config`（桌面端的受控浏览器 / 终端走这条路，从不写用户配置）。 */
  extra?: Record<string, McpServerConfig>;
  /** 已连上（或连接失败）的 server，用于补状态。 */
  statuses?: ReadonlyMap<string, { status: string; toolCount: number }>;
};

/**
 * 会话能力目录的 MCP 一栏。
 *
 * 名字来自三处，合并后按名字排序：
 * 1. 用户配置；
 * 2. 会话自己的 `--mcp-config`——内置能力（浏览器 / 终端）挂在会话上，只在这一份里，
 *    漏掉它界面上就看不到、也关不掉；
 * 3. 已经连上的 server（配置读不出但连上了的情况，例如启动后配置被改写）。
 *
 * 状态只跟着连接结果走：没连过就是 `configured`，界面上仍然可开关。
 */
export function buildMcpCatalog(input: McpCatalogInput = {}): McpCatalogEntry[] {
  const names = new Set<string>([
    ...Object.keys(input.configured ?? {}),
    ...Object.keys(input.extra ?? {}),
    ...(input.statuses?.keys() ?? []),
  ]);

  return [...names]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const status = input.statuses?.get(name);
      return {
        name,
        status: status?.status ?? 'configured',
        toolCount: status?.toolCount ?? 0,
      };
    });
}
