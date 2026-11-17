import type { PluginSettingsStore } from './PluginSettings.js';

/** 随包 web.ts 的独立只读宿主；不提供会话、HTTP req/res 或任意 channel。 */
export type PluginWebContext = {
  pluginId: string;
  pluginVersion: string;
  paths: { config: string; data: string };
  settings: Pick<PluginSettingsStore, 'get'>;
  /** 随包清单的公开身份投影，不包含设置值或凭据。 */
  catalog: readonly { id: string; name: string; version: string }[];
};

/** default createWeb(context) 的返回值；查询须只读并在 signal 中止时停止工作。 */
export type PluginWebHandler = {
  queries: Record<string, (params: Readonly<Record<string, string>>, context: { signal: AbortSignal }) => unknown | Promise<unknown>>;
  dispose?(): void | Promise<void>;
};

/** 名称是固定的操作标识，而不是 URL、路径或任意代码。 */
export function isPluginWebQuery(query: unknown): query is string {
  return typeof query === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(query);
}

/** 浏览器与运行时共用的固定同源端点；不接受任意 URL。 */
export function pluginWebPath(pluginId: string, query: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(pluginId) || pluginId.includes('..')) throw new Error('插件 id 非法');
  if (!isPluginWebQuery(query)) throw new Error('插件只读查询名非法');
  return `/plugins/${encodeURIComponent(pluginId)}/api/${query}`;
}
