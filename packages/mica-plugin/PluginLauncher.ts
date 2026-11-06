/** 随包插件 `plugins/<id>/launcher.js` 的 default createLauncher(context) 接口。 */
export type PluginLauncherContext = {
  pluginId: string;
  settings: {
    get(): Record<string, string>;
  };
  readData(): Promise<{ value: unknown; version: string | null }>;
  writeData(value: unknown, options?: { expectedVersion?: string | null }): Promise<unknown>;
};

/** createLauncher 返回的处理器；宿主在关闭插件时调用可选的 dispose。 */
export type PluginLauncherHandler = {
  request(action: string, input: unknown): unknown | Promise<unknown>;
  dispose?(): void | Promise<void>;
};
