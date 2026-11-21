import type { PluginBackgroundApi } from './PluginBackground.js';
import type { PluginHealthStore } from './PluginHealth.js';
import type { PluginSettingValues } from './PluginSettings.js';

/**
 * 随包插件 `plugins/<id>/launcher.js` 的 default `createLauncher(context)` 接口。
 *
 * 启动器后端跑在桌面运行时里，和会话宿主无关：它不启动聊天、也拿不到 agent。能用的
 * 只有「这个插件自己的东西」——设置、数据目录、常驻调度，以及一组原生窗口动作。
 */

/** launcher 能看到的设置：与配置页、`ctx.settings` 是同一份 store。 */
export type PluginLauncherSettings = {
  get(): PluginSettingValues;
  /**
   * 只改传入的键，其余保持原样；写盘前过同一份校验，非法值直接抛错。
   *
   * 给「插件自己得知了值」的场合用（读到当前剪贴板内容、探测到窗口状态），
   * 不要让用户去配置页手工抄一遍。
   */
  set(values: Record<string, unknown>): PluginSettingValues;
};

export type PluginLauncherContext = {
  pluginId: string;
  /**
   * 插件自己的数据目录 `$MICA_HOME/plugin-data/<pluginId>`，宿主已创建（0700）。
   *
   * 需要维护一批文件（索引、快照、缓存）的启动器用它，别去猜 `$MICA_HOME` 在哪、
   * 也别自己拼 `plugin-data`。结构化数据仍走 `readData` / `writeData`。
   */
  dataDirectory: string;
  settings: PluginLauncherSettings;
  /**
   * 常驻调度：启动器要在没有窗口的时候也一直跑（剪贴板监听这类），注册到这里。
   *
   * 与 `ctx.background` 同一个调度器，只是租给 launcher 用：单任务串行、不会重叠，
   * 停用或关闭启动器时一起中止。launcher 的最小间隔是 100ms，因此 500ms 的轮询
   * 不会被抬成 1 秒；具体多久一次仍由插件自己的 `every` 决定。
   */
  background: PluginBackgroundApi;
  /**
   * 这个插件的运行健康，与 `ctx.health` 同一份（`$MICA_HOME/plugin-health/<id>.json`）。
   *
   * 启动器常常是第一个发现「外部能力不可用」的地方（原生窗口、系统权限、后端进程），
   * 这类故障要写进健康状态，用户在插件页才看得见。issueKey 用插件自己的依赖名，
   * 只清自己那一条——别去动 `background:<任务>` 这类宿主记的键。
   */
  health: PluginHealthStore;
  readData(): Promise<{ value: unknown; version: string | null }>;
  writeData(value: unknown, options?: { expectedVersion?: string | null }): Promise<unknown>;
  /**
   * 原生动作：显示 / 关闭浮窗、把文件交给编辑器、进入插件设置。
   *
   * 走桌面端已有的私有系统 socket，插件不必自己开端口。`pluginId` 由宿主绑定，
   * 传进来的 `input` 覆盖不了它。纯 Web 宿主里后端照常加载，这一次调用会失败——
   * 插件把「当前宿主不支持」显示在自己的界面上，而不是整块起不来。
   */
  control(action: string, input?: Record<string, unknown>): Promise<unknown>;
};

/** createLauncher 返回的处理器；宿主在关闭插件时调用可选的 dispose。 */
export type PluginLauncherHandler = {
  request(action: string, input: unknown, context?: { signal?: AbortSignal }): unknown | Promise<unknown>;
  dispose?(): void | Promise<void>;
};
