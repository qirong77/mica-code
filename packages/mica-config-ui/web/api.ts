import type {
  ConfigWebAutoCompactDetails,
  ConfigWebAutoCompactSettings,
  ConfigWebContextAnalysis,
  ConfigWebConversationItem,
  ConfigWebConversationPage,
  ConfigWebFilePayload,
  ConfigWebMcpDetails,
  ConfigWebPluginsDetails,
  ConfigWebRolesDetails,
  ConfigWebSessionDetails,
  ConfigWebSessionsDetails,
  ConfigWebSkillsDetails,
} from '../src/shared/types.js';

/**
 * 配置页用到的全部数据操作。
 *
 * 页面只认这个接口：浏览器里的实现走 HTTP（apps/config-web），桌面端的实现走运行时 IPC
 * （apps/desktop），所以同一个页面组件能在两个宿主里跑，不需要知道谁在给它数据。
 * `connectHeartbeat` 只有 HTTP 宿主需要（用长连接表示「还有人在看」，没有连接就退出）。
 */
export type ConfigWebClient = {
  readConfigFile(): Promise<ConfigWebFilePayload>;
  writeConfigFile(content: string): Promise<ConfigWebFilePayload>;

  readMcpDetails(): Promise<ConfigWebMcpDetails>;
  createMcpServer(name: string, content?: string): Promise<ConfigWebMcpDetails>;
  writeMcpServer(name: string, content: string): Promise<ConfigWebMcpDetails>;
  deleteMcpServer(name: string): Promise<ConfigWebMcpDetails>;

  readSkillsDetails(): Promise<ConfigWebSkillsDetails>;
  createSkill(name: string, content?: string): Promise<ConfigWebSkillsDetails>;
  writeSkill(name: string, content: string): Promise<ConfigWebSkillsDetails>;
  deleteSkill(name: string): Promise<ConfigWebSkillsDetails>;

  readRolesDetails(): Promise<ConfigWebRolesDetails>;
  createRole(name: string, content?: string): Promise<ConfigWebRolesDetails>;
  writeRole(name: string, content: string): Promise<ConfigWebRolesDetails>;
  deleteRole(name: string): Promise<ConfigWebRolesDetails>;

  readPluginsDetails(): Promise<ConfigWebPluginsDetails>;

  /**
   * 自动压缩（输入框上方那个齿轮曾经管的东西）现在只在这台机器的运行时里：设置与按会话
   * 记账的计数都在运行时的 userData 目录下。浏览器宿主（apps/config-web）没有这份数据，
   * 所以这三个方法是可选的，缺了就不显示这一节。
   */
  readAutoCompactDetails?(): Promise<ConfigWebAutoCompactDetails>;
  writeAutoCompactSettings?(settings: ConfigWebAutoCompactSettings): Promise<ConfigWebAutoCompactDetails>;
  resetAutoCompactCounters?(sessionId?: string): Promise<ConfigWebAutoCompactDetails>;

  readSessionsDetails(): Promise<ConfigWebSessionsDetails>;
  readSessionDetails(id: string): Promise<ConfigWebSessionDetails>;
  readSessionContent(id: string): Promise<{ content: string }>;
  readSessionConversationPage(
    id: string,
    offset: number,
    limit: number,
    tail?: boolean,
  ): Promise<ConfigWebConversationPage>;
  readSessionItem(id: string, sequence: number): Promise<ConfigWebConversationItem>;
  readSessionContextAnalysis(id: string): Promise<ConfigWebContextAnalysis>;
  writeSession(id: string, content: string): Promise<unknown>;

  connectHeartbeat?(onEvent?: (event: { type?: string }) => void): { close(): void } | null;
};

let client: ConfigWebClient | null = null;

/** 宿主在挂载页面组件之前注册实现（一个页面只有一个宿主，所以是模块级单例）。 */
export function setConfigWebClient(next: ConfigWebClient | null): void {
  client = next;
}

function requireClient(): ConfigWebClient {
  if (!client) throw new Error('配置页数据源尚未注册：请在渲染前调用 setConfigWebClient()');
  return client;
}

export function readConfigFile(): Promise<ConfigWebFilePayload> {
  return requireClient().readConfigFile();
}

export function writeConfigFile(content: string): Promise<ConfigWebFilePayload> {
  return requireClient().writeConfigFile(content);
}

export function readMcpDetails(): Promise<ConfigWebMcpDetails> {
  return requireClient().readMcpDetails();
}

export function writeMcpServer(name: string, content: string): Promise<ConfigWebMcpDetails> {
  return requireClient().writeMcpServer(name, content);
}

export function createMcpServer(name: string, content = ''): Promise<ConfigWebMcpDetails> {
  return requireClient().createMcpServer(name, content);
}

export function deleteMcpServer(name: string): Promise<ConfigWebMcpDetails> {
  return requireClient().deleteMcpServer(name);
}

export function readSkillsDetails(): Promise<ConfigWebSkillsDetails> {
  return requireClient().readSkillsDetails();
}

export function writeSkill(name: string, content: string): Promise<ConfigWebSkillsDetails> {
  return requireClient().writeSkill(name, content);
}

export function createSkill(name: string, content = ''): Promise<ConfigWebSkillsDetails> {
  return requireClient().createSkill(name, content);
}

export function deleteSkill(name: string): Promise<ConfigWebSkillsDetails> {
  return requireClient().deleteSkill(name);
}

export function readPluginsDetails(): Promise<ConfigWebPluginsDetails> {
  return requireClient().readPluginsDetails();
}

/** 宿主是否提供自动压缩这一节（桌面运行时提供，浏览器宿主不提供）。 */
export function supportsAutoCompact(): boolean {
  return typeof client?.readAutoCompactDetails === 'function';
}

type AutoCompactClient = ConfigWebClient &
  Required<Pick<ConfigWebClient, 'readAutoCompactDetails' | 'writeAutoCompactSettings' | 'resetAutoCompactCounters'>>;

export function readAutoCompactDetails(): Promise<ConfigWebAutoCompactDetails> {
  return requireAutoCompact().readAutoCompactDetails();
}

export function writeAutoCompactSettings(settings: ConfigWebAutoCompactSettings): Promise<ConfigWebAutoCompactDetails> {
  return requireAutoCompact().writeAutoCompactSettings(settings);
}

export function resetAutoCompactCounters(sessionId?: string): Promise<ConfigWebAutoCompactDetails> {
  return requireAutoCompact().resetAutoCompactCounters(sessionId);
}

function requireAutoCompact(): AutoCompactClient {
  const current = requireClient();
  if (!supportsAutoCompact()) throw new Error('当前宿主不支持自动压缩设置');
  return current as AutoCompactClient;
}

export function readSessionsDetails(): Promise<ConfigWebSessionsDetails> {
  return requireClient().readSessionsDetails();
}

export function readSessionDetails(id: string): Promise<ConfigWebSessionDetails> {
  return requireClient().readSessionDetails(id);
}

export function readSessionContent(id: string): Promise<{ content: string }> {
  return requireClient().readSessionContent(id);
}

export function readSessionConversationPage(
  id: string,
  offset: number,
  limit: number,
  tail = false,
): Promise<ConfigWebConversationPage> {
  return requireClient().readSessionConversationPage(id, offset, limit, tail);
}

export function readSessionItem(id: string, sequence: number): Promise<ConfigWebConversationItem> {
  return requireClient().readSessionItem(id, sequence);
}

export function readSessionContextAnalysis(id: string): Promise<ConfigWebContextAnalysis> {
  return requireClient().readSessionContextAnalysis(id);
}

export function writeSession(id: string, content: string): Promise<unknown> {
  return requireClient().writeSession(id, content);
}

export function readRolesDetails(): Promise<ConfigWebRolesDetails> {
  return requireClient().readRolesDetails();
}

export function writeRole(name: string, content: string): Promise<ConfigWebRolesDetails> {
  return requireClient().writeRole(name, content);
}

export function createRole(name: string, content = ''): Promise<ConfigWebRolesDetails> {
  return requireClient().createRole(name, content);
}

export function deleteRole(name: string): Promise<ConfigWebRolesDetails> {
  return requireClient().deleteRole(name);
}

export function connectHeartbeat(
  onEvent?: (event: { type?: string }) => void,
): { close(): void } | null {
  return client?.connectHeartbeat?.(onEvent) ?? null;
}
