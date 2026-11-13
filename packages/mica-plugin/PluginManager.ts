import { statSync, unwatchFile, watchFile } from 'node:fs';
import { join } from 'node:path';
import type { Disposable } from '@packages/mica-common/index.js';
import type { MicaPlugin } from './Plugin.js';
import type { PluginContext } from './PluginContext.js';
import type { PluginAgentRegistry } from './PluginAgent.js';
import type { PluginModelsHandler } from './PluginModels.js';
import type { PluginRequirement } from './PluginManifest.js';
import type { PluginPromptSections } from './PluginPrompt.js';
import type { PluginSessionStateApi } from './PluginSessionState.js';
import type { PluginAskApi } from './PluginAsk.js';
import { createPluginSessionSettingsApi, type PluginSessionSettingsHostApi } from './PluginSessionSettings.js';
import { createPluginLlmApi } from './PluginLlm.js';
import { createPluginBackgroundScheduler } from './PluginBackground.js';
import type { PluginObservationEvent } from './PluginObservation.js';
import type { PluginSubagentApi } from './PluginSubagents.js';
import type { PluginPanelHandler, PluginPanelRegistry } from './PluginPanel.js';
import type { PluginSessionMenuHandler, PluginSessionMenuRegistry } from './PluginSessionMenu.js';
import type { PluginSkillRegistrationOptions } from './PluginDesktop.js';
import type { RuntimeSkillRegistration } from '@packages/mica-skills/index.js';
import type { Skill } from '@packages/mica-skills/types.js';
import { loadManifestSkills, publishPluginSkills, type PluginSkillPublishEntry } from './PluginSkills.js';
import { loadManifestRoles, publishPluginRoles } from './PluginRoles.js';
import { createPluginHealthStore, writePluginHealth } from './PluginHealth.js';
import { createPluginLogger } from './PluginLog.js';
import { createPluginSettingsStore } from './PluginSettings.js';
import { createPluginDataApi, pluginDataPath } from './PluginData.js';
import { PluginActionRegistry, type PluginActionInput, type PluginActionResult } from './PluginActions.js';
import { PLUGIN_STATE_FILE, readPluginState, resolvePluginStatePath } from './PluginState.js';
import { createPluginStatus, writePluginStatus, type PluginHostKind } from './PluginStatus.js';
import type { FilePluginLoadResult } from './FilePluginLoader.js';
import { micaSkills } from '@packages/mica-skills/index.js';

export type PluginSetupReport = {
  loaded: string[];
  /** setup 抛错的插件。`required` 插件还会继续抛出，中断启动。 */
  failed: { pluginId: string; error: unknown }[];
  /**
   * 因为宿主缺少它在清单里声明的能力而没被启动的插件。
   *
   * 这类失败**不抛错**：能力缺失是宿主与清单的约定不一致，让整个应用起不来只会把
   * 一条本可以显示在配置页上的信息变成一次崩溃。
   */
  skipped: { pluginId: string; missing: PluginRequirement[] }[];
};

/** 一次启停变化的结果：谁被卸载了、谁被装配起来了。 */
export type PluginStateChange = {
  /** 因为名单里被停用而卸载的插件。 */
  disabled: string[];
  /** 因为名单里重新启用而装配的插件。 */
  enabled: string[];
  /** 变化过程中装配或卸载失败的插件；装配失败记入 setupReport，原因写进插件日志。 */
  failed: { pluginId: string; error: unknown }[];
};

/**
 * 插件启停的运行期同步。
 *
 * 启停是**配置**（`plugins-state.json`），而工具、命令、钩子活在**进程**里：只改文件不动
 * 进程，配置页上写着「已停用」、对话里它的工具还在。所以常驻宿主把这份配置交出来，
 * manager 在每轮开始（`turn:before`）按它对齐一次——运行中的会话因此不必重开，正在跑的
 * 那一轮也不被打断。
 */
export type PluginStateSyncOptions = {
  /** 装配它的宿主：写进 `plugin-status.json`，配置页据此说明结论来自哪个宿主。 */
  host: PluginHostKind;
  /**
   * 重新扫描用户插件目录并注册新插件。
   *
   * 启用一个「启动时被停用、连入口都没 import」的插件必须重新读一次磁盘；怎么加载由宿主
   * 回答（TUI 走启动扩展、常驻宿主走 `loadUserPlugins`）。省略表示这个宿主不装用户插件。
   */
  loadUserPlugins?: (options: { disabled: string[] }) => Promise<Pick<FilePluginLoadResult, 'loaded' | 'failed'>>;
  /**
   * 此刻能不能卸载 / 装配插件。
   *
   * 名单一变就立即对齐，但正在跑的那一轮里不能把它的工具、钩子从脚底抽走——宿主在这
   * 件事上比 manager 清楚（headless 看 executor，TUI 看 runtime）。返回 false 时变化
   * 被记下来，等这一轮结束（`turn:after`）再对齐。
   */
  canSyncNow?: () => boolean;
};

/**
 * 每个插件在 setup 时拿到的东西，去掉几项「按插件生成」的：
 *
 * - `pluginId` / `onDispose`：生命周期绑定，只由 PluginManager 决定；
 * - `logger`：包装成带插件 id 的文件日志，写进 `resolveLogDir()`（与运行时日志同目录）；
 * - `settings`：按插件清单里的 `settings` 声明读取，路径跟着 `paths.config` 走；
 * - `data`：绑定当前 pluginId 的跨宿主自有数据，宿主不能注入另一插件的句柄；
 * - `health`：插件自报状态，落到 `$MICA_HOME/plugin-health/<id>.json`；
 * - `prompt`：包一层只写自己段落的入口。
 * - `skills`：进程级 skill 注册表，按 pluginId 归属，卸载时一起摘掉。
 *
 * host 仍然可以传自己的 `logger`，它会作为落盘之外的转发目标（TUI 静默、headless 写 stderr）。
 */
export type PluginBaseContext = Omit<
  PluginContext,
  'pluginId' | 'pluginStatus' | 'onDispose' | 'logger' | 'settings' | 'sessionSettings' | 'health' | 'skills' | 'models' | 'data'
> & {
  logger?: PluginContext['logger'];
  /**
   * 按插件 id 生成本会话的状态读写面。宿主不提供时插件拿不到 `sessionState`，
   * 相关能力必须声明在 `requires` 里，由 manager 跳过而不是让插件在运行期踩空。
   */
  sessionStateFor?: (pluginId: string) => PluginSessionStateApi;
  /**
   * 按插件 id 生成本会话的设置覆盖读写面。宿主不提供时插件拿不到 `sessionSettings`，
   * 需要它的插件必须在 `requires` 里声明，注册阶段就会被跳过。
   */
  sessionSettingsFor?: (pluginId: string) => PluginSessionSettingsHostApi;
  /**
   * 按插件 id 生成「问用户一个问题」的入口。只有能把问题画给人、并且收得到点选的宿主
   * 才提供（桌面端的 `mica app-server`）；没提供时插件拿不到 `ask`，依赖它的插件在
   * 注册阶段按 `requires: ['ask']` 整插件跳过。
   */
  askFor?: (pluginId: string) => PluginAskApi;
  /**
   * 内核持有的 prompt 段落表。manager 会为每个插件包一层只写自己段落的入口，
   * 宿主只需要把 `AgentRuntime.promptSections` 交出来。
   */
  promptSections?: PluginPromptSections;
  /**
   * 内核持有的模型请求改写表。manager 按插件 id 绑定后交给插件，插件注册不到别人名下。
   */
  agentRegistry?: PluginAgentRegistry;
  /**
   * 委派子代理的入口。manager 按插件 id 绑定后交给插件——注册的子代理类型挂在插件
   * 名下，卸载时随之摘除。
   */
  subagentsFor?: (pluginId: string) => PluginSubagentApi;
  /**
   * 插件自己的模型请求入口。manager 按插件 id 绑定后交给插件，所以记账与日志都挂着
   * 插件身份；没有会话可记的宿主（`mica commit`）照样提供，只是不入账。
   */
  pluginModels?: PluginModelsHandler;
  /**
   * 对话右侧面板的登记表。宿主提供它、并在插件清单声明了 `desktop.panel` 时，插件才能
   * 拿到 `ctx.desktop.panel()`——没声明就静默接受注册会让插件以为界面已经出现。
   */
  desktopPanels?: PluginPanelRegistry;
  /**
   * 会话右键菜单动作的登记表。与面板同理：宿主提供它、清单声明了 `desktop.sessionMenu`
   * 时，插件才能注册自己的处理器。
   */
  desktopSessionMenus?: PluginSessionMenuRegistry;
  /**
   * 运行期启停同步。给了它，manager 就在每轮开始时跟着 `plugins-state.json` 对齐，
   * 并负责写 `plugin-status.json`；省略表示这个宿主只在启动时读一次名单。
   */
  pluginStateSync?: PluginStateSyncOptions;
};

type PluginAttempt =
  | { status: 'loaded' }
  | { status: 'failed'; error: unknown }
  | { status: 'skipped'; missing: PluginRequirement[] };

export class PluginManager {
  private readonly plugins = new Map<string, MicaPlugin>();
  /**
   * 每个已装配插件的资源，按 pluginId 分开存。
   *
   * 停用一个插件要摘掉它注册的工具、命令、钩子与界面，而不是连别人的一起释放，所以
   * 这份登记表不能是扁平的。
   */
  private readonly runs = new Map<string, Disposable[]>();
  /** 每个插件最后一次装配的结论：启停同步据此决定「要不要重新装配」。 */
  private readonly attempts = new Map<string, PluginAttempt>();
  /** 装配时的能力面：重新启用一个插件要用同一份 baseContext 再 setup 一次。 */
  private baseContext: PluginBaseContext | null = null;
  /** 常驻宿主传的装配选项（`backgroundTasks` 等）：重新启用时沿用它。 */
  private residentOptions: { ignoreRequirements?: boolean; backgroundTasks?: boolean } = {};
  private stateSyncHook: Disposable | null = null;
  private prepareStateSyncHook: Disposable | null = null;
  /** 轮次结束时兜底对齐一次（名单在轮次中途变过、或 watcher 漏了事件）。 */
  private stateSettledHook: Disposable | null = null;
  /** 名单变化后等一小段再对齐：一次写盘会连发几个 mtime 事件。 */
  private stateSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private watchedStatePath: string | null = null;
  /** `plugins-state.json` 的 mtime+size：没变就不必读、更不必重装。 */
  private stateSignature: string | null = null;
  /** 用户插件的磁盘加载结果：`plugin-status.json` 要按它补上入口文件与加载失败。 */
  private userPluginFiles: Pick<FilePluginLoadResult, 'loaded' | 'failed'> = { loaded: [], failed: [] };
  private syncing: Promise<PluginStateChange | null> | null = null;
  /**
   * 配置页动作的登记表。
   *
   * 登记本身不需要宿主设施（只是把处理器存起来），所以它跟着 manager 走，任何宿主都
   * 能提供 `ctx.actions`；真正执行动作的是「配置页宿主」——它可以是常驻会话进程，也可以
   * 是一次性进程（`mica plugin-action`）。
   */
  private readonly actions = new PluginActionRegistry((pluginId) =>
    (this.plugins.get(pluginId)?.manifest?.actions ?? []).map((entry) => entry.key),
  );

  /** 执行某个插件声明的配置页动作。找不到处理器时报错由调用方翻译成用户能读懂的话。 */
  runPluginAction(pluginId: string, key: string, input: PluginActionInput): Promise<PluginActionResult> {
    return this.actions.run(pluginId, key, input);
  }

  hasPluginAction(pluginId: string, key: string): boolean {
    return this.actions.has(pluginId, key);
  }

  register(plugin: MicaPlugin): void {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin already registered: ${plugin.id}`);
    }
    this.plugins.set(plugin.id, plugin);
  }

  /**
   * 已登记的插件，含 setup 失败的那些：配置页与协议要按清单如实列出插件级声明
   * （会话设置字段），看不到就等于没声明。
   */
  list(): MicaPlugin[] {
    return [...this.plugins.values()];
  }

  /**
   * 装配全部已登记的插件。
   *
   * `plugins-state.json` 里停用的插件在这里被跳过：注册照旧、装配不执行。启停因此只是
   * 「装配 / 卸载一次」，不必重开进程，也不会把插件代码里 import 时才做的事做两遍。
   *
   * `only` 把装配收窄到指定插件（`mica plugin-action` 只为一个插件的动作用）：一次性宿主
   * 不提供 `tools` / `background` 这类能力，装配无关插件只会多出一堆「缺能力」的跳过。
   *
   * `ignoreRequirements` 与 `only` 配套：动作宿主只兑现「动作」这一面，插件声明它还要
   * `tools` / `background` 是给常驻宿主看的，不该成为「按钮点不了」的理由。跳过能力检查
   * 之后，插件必须自己判断 `ctx.<capability>` 在不在（这也是插件一直以来的写法）。
   *
   * `backgroundTasks: false` 让常驻任务只登记不排期：点一次配置页按钮不该顺手起一个桥进程。
   */
  async setupAll(
    baseContext: PluginBaseContext,
    options: {
      only?: readonly string[];
      ignoreRequirements?: boolean;
      backgroundTasks?: boolean;
    } = {},
  ): Promise<PluginSetupReport> {
    const report: PluginSetupReport = { loaded: [], failed: [], skipped: [] };
    this.watchHookErrors(baseContext);
    // 一次性宿主（`mica plugin-action` / 插件命令）没有下一轮可等，名单只在这次装配时
    // 读一次；常驻宿主从这里起步，之后由 `syncPluginState()` 跟着文件走。
    const disabled = new Set(readPluginState({ path: resolveStatePath(baseContext) }).disabled);
    const resident = !options.only;
    if (resident) {
      this.baseContext = baseContext;
      this.residentOptions = {
        ignoreRequirements: options.ignoreRequirements,
        backgroundTasks: options.backgroundTasks,
      };
      if (baseContext.pluginStateSync) await this.reloadUserPlugins(baseContext, disabled);
    }
    for (const plugin of this.sortedPlugins()) {
      if (options.only && !options.only.includes(plugin.id)) continue;
      if (disabled.has(plugin.id)) continue;
      await this.setupPlugin(plugin, baseContext, options, report);
    }
    if (resident && baseContext.pluginStateSync) {
      this.installStateSync(baseContext);
      this.writeStatus(baseContext);
    }
    return report;
  }

  /** 装配单个已登记的插件：一个插件的失败与跳过不影响其余插件。 */
  private async setupPlugin(
    plugin: MicaPlugin,
    baseContext: PluginBaseContext,
    options: { ignoreRequirements?: boolean; backgroundTasks?: boolean },
    report: PluginSetupReport,
  ): Promise<void> {
    const localDisposables: Disposable[] = [];
    const trackRegistration = <T extends Disposable>(registration: T): T => {
      localDisposables.push(registration);
      return registration;
    };
    const logger = createPluginLogger(plugin.id, baseContext.logger);
    const configDir = baseContext.paths?.config;
    // 这个插件注册成功的 skill 与它声明的角色：每次注册后整份重写它的索引文件
    // （见 PluginSkills.ts）。
    const publishedSkills: PluginSkillPublishEntry[] = [];
    // `sessionStateFor` / `promptSections` 由 manager 消费（下面按 pluginId 生成
    // 本插件专属的入口），不能原样漏进 ctx，否则插件会看到一个能读别人状态的入口。
    const {
      sessionStateFor,
      sessionSettingsFor,
      askFor,
      promptSections: promptRegistry,
      agentRegistry,
      subagentsFor,
      pluginModels: modelsHandler,
      desktopPanels,
      desktopSessionMenus,
      // 宿主专属的装配接线，不进 ctx：插件拿到它既没用，也会误以为能自己改名单。
      pluginStateSync: _stateSync,
      ...shared
    } = baseContext;
    const settings = createPluginSettingsStore(plugin.id, plugin.manifest?.settings ?? [], { configDir });
    // 健康状态带上是哪一版写的：升级之后上一版留下的结论不该继续挂在页面上。
    const health = createPluginHealthStore(plugin.id, { configDir, version: plugin.version });
    /**
     * 注册一条 skill 并把归属记在这个插件名下。
     *
     * 清单声明的与插件在 setup 里自己注册的走同一条路：磁盘上同名的优先（用户装一份
     * 就能覆盖内置），没注册上的报成一条用户可见状态，生效的顺手重写一份索引——不 setup
     * 插件的宿主（桌面运行时的 `/` 补全、配置页）靠它列出内置 skill，不必为此冷启动一个
     * 会话进程。
     */
    const registerSkill = (
      skill: Skill,
      skillOptions: PluginSkillRegistrationOptions = {},
    ): RuntimeSkillRegistration => {
      const registration = micaSkills.registerRuntime(plugin.id, [skill]);
      if (registration.skipped.length > 0) {
        logger.warn('plugin:skill-shadowed', { skipped: registration.skipped });
        health.report({
          level: 'warn',
          message: `skill 未注册：${registration.skipped.map((item) => `${item.name}（${item.reason}）`).join('；')}`,
        });
      }
      const name = skill.name.trim();
      if (!registration.skipped.some((item) => item.name === name)) {
        publishedSkills.push({ skill, roles: skillOptions.roles ?? [] });
        publishPluginSkills(plugin.id, publishedSkills, { configDir });
      }
      localDisposables.push({ dispose: () => registration.dispose() });
      return registration;
    };
    // 宿主的会话级读写面按 pluginId 绑定；没有它就退化成「只有全局设置」，
    // 插件通过 `requires: ['sessionSettings']` 声明这一点，缺能力时注册阶段跳过。
    const sessionSettingsHost = sessionSettingsFor?.(plugin.id);
    const statusHost = baseContext.pluginStateSync?.host;
    const paths = baseContext.paths;
    const ctx: PluginContext = {
      ...shared,
      ...(shared.tools
        ? {
            tools: {
              register: (tool, options = {}) =>
                shared.tools!.register(tool, {
                  ...options,
                  group: { key: `plugin:${plugin.id}`, label: plugin.manifest?.name ?? plugin.id },
                }),
            },
          }
        : {}),
      pluginId: plugin.id,
      ...(statusHost && paths
        ? {
            pluginStatus: () =>
              createPluginStatus({
                pluginsDir: paths.plugins,
                host: statusHost,
                updatedAt: new Date().toISOString(),
                filePlugins: this.userPluginFiles,
                setupReport: this.setupReport(),
              }),
          }
        : {}),
      logger,
      settings,
      ...(sessionSettingsHost
        ? {
            sessionSettings: createPluginSessionSettingsApi({
              fields: plugin.manifest?.settings ?? [],
              readGlobal: () => settings.get(),
              readOverrides: (owner) => sessionSettingsHost.read(owner),
              writeOverrides: (value, owner) => sessionSettingsHost.write(value, owner),
            }),
          }
        : {}),
      health,
      // skill 是进程级注册表（磁盘扫描 + 插件注册合流），所以不需要宿主接线：
      // 注册归属这个插件，卸载时按 pluginId 一起摘掉。
      skills: {
        register: (skill, skillOptions) => registerSkill(skill, skillOptions ?? {}),
      },
      onDispose: (dispose) => localDisposables.push({ dispose }),
    };
    // Ignore even untyped host-injected handles: only this manager binds plugin-owned data.
    delete ctx.data;
    if (configDir && pluginDataPath(configDir, plugin.id)) ctx.data = createPluginDataApi(configDir, plugin.id);
    // 常驻任务由 manager 自己调度，不依赖宿主接线：它是纯定时逻辑，任何宿主都能给。
    // 插件没手动 dispose 的循环随 localDisposables 一起回收，所以停用插件 = 循环停止。
    const background = createPluginBackgroundScheduler({
      pluginId: plugin.id,
      enabled: options.backgroundTasks !== false,
      onError: (taskId, error, info) => {
        const message = errorMessage(error);
        logger.warn('plugin:background-failed', { taskId, error: message, failures: info.failures });
        health.report({ level: 'warn', message: `常驻任务 ${taskId} 失败：${message}` });
        // 健康状态只留最后一句话，谁也看不到「它失败了 300 次」。事件进观察流，
        // 复盘才能回答「哪个插件的常驻任务一直在坏」。
        baseContext.hooks.notify<PluginObservationEvent>('plugin:observe', {
          pluginId: plugin.id,
          timestamp: new Date().toISOString(),
          type: 'background:failed',
          taskId,
          tick: info.tick,
          failures: info.failures,
          error: message,
        });
      },
    });
    ctx.background = background;
    localDisposables.push({ dispose: () => background.disposeAll() });
    const sessionState = sessionStateFor?.(plugin.id);
    if (sessionState) ctx.sessionState = sessionState;
    if (askFor) ctx.ask = askFor(plugin.id);
    if (promptRegistry) {
      ctx.prompt = { section: (section) => promptRegistry.add(plugin.id, section) };
    }
    if (agentRegistry) {
      ctx.agent = {
        mode: agentRegistry.mode,
        onIterationRewrite: (handler) => agentRegistry.onIterationRewrite(plugin.id, handler),
        ...(agentRegistry.lastUsage ? { lastUsage: () => agentRegistry.lastUsage!() } : {}),
        // getter 而不是快照：会话里切模型之后窗口会变，插件下一次读到的必须是新的那个。
        ...(agentRegistry.contextWindowSize
          ? {
              get contextWindowSize() {
                return agentRegistry.contextWindowSize!();
              },
            }
          : {}),
        ...(agentRegistry.compactIdleHistory
          ? {
              compactIdleHistory: (hook) => agentRegistry.compactIdleHistory!(plugin.id, hook),
            }
          : {}),
        ...(agentRegistry.withMaintenance
          ? {
              withMaintenance: (window, task) => agentRegistry.withMaintenance!(window, task),
            }
          : {}),
      };
    }
    if (subagentsFor) ctx.subagents = subagentsFor(plugin.id);
    if (modelsHandler) {
      ctx.models = { request: (request) => modelsHandler(plugin.id, request) };
    }
    // desktop 能力面有两半：宿主身份（`host: 'desktop'`，由 host 提供）与对话右侧面板的
    // 注册口。面板只在清单声明了 `desktop.panel` 时才有位置可画——不声明却接受注册，
    // 插件会以为自己的界面已经出现，实际页面上什么都没有。
    if (baseContext.desktop) {
      const panels = baseContext.desktopPanels;
      const sessionMenus = baseContext.desktopSessionMenus;
      ctx.desktop = {
        host: 'desktop',
        ...(panels && plugin.manifest?.desktopPanel
          ? { panel: (handler: PluginPanelHandler) => trackRegistration(panels.add(plugin.id, handler)) }
          : {}),
        ...(sessionMenus && (plugin.manifest?.desktopSessionMenu.length ?? 0) > 0
          ? {
              sessionMenu: (handler: PluginSessionMenuHandler) =>
                trackRegistration(sessionMenus.add(plugin.id, handler)),
            }
          : {}),
      };
    }
    // 配置页动作：不需要会话，也不属于 `desktop` 那半边（一次性进程同样提供）。
    // 清单声明了按钮才有注册口，理由同面板：没按钮还接受注册等于骗插件。
    if ((plugin.manifest?.actions.length ?? 0) > 0) {
      const actionStore = this.actions;
      ctx.actions = {
        register: (key, handler) => trackRegistration(actionStore.add(plugin.id, key, handler)),
      };
    }
    if (plugin.manifest?.llm && modelsHandler) {
      // 生效值 = 全局设置 + 本会话覆盖；每次调用重新合并，配置页改完立刻生效。
      const llmSpec = plugin.manifest.llm;
      ctx.llm = createPluginLlmApi({
        spec: llmSpec,
        readValues: (owner) => ({ ...settings.get(), ...(sessionSettingsHost?.read(owner) ?? {}) }),
        models: (request) => modelsHandler(plugin.id, request),
        // 配置的接口/模型不可用时组件会自动降级为主配置，这里留一条「为什么降级了」。
        health,
      });
    }

    // 清单声明的能力必须都能兑现，否则插件一定会在运行期踩空。放在 setup 之前判断，
    // 装配出来的 ctx 就是事实，不需要插件自己再猜。
    const missing = options.ignoreRequirements ? [] : missingRequirements(plugin.manifest?.requires ?? [], ctx);
    if (missing.length > 0) {
      // 缺宿主能力是**这一份宿主**的事实，不是插件「现在怎么样」：TUI、`mica exec`、
      // `mica commit` 本来就没有 `desktop` 这些面。写进所有宿主共享的 plugin-health 会
      // 让桌面端显示一条别的宿主留下的「待配置」，而插件在桌面端其实好好的。留痕走日志
      // 与 skipped 报告（用户插件那份落进 plugin-status.json）。
      report.skipped.push({ pluginId: plugin.id, missing });
      this.attempts.set(plugin.id, { status: 'skipped', missing });
      logger.warn('plugin:skipped', { missing });
      return;
    }

    // 配置不合法不阻止启动（用户可能正要去页面里填），但必须留痕：否则插件会因为
    // 读不到可用配置而每轮静默跳过，用户只看到「什么都没发生」。
    const settingIssues = settings.validate();
    if (settingIssues.length > 0) {
      logger.warn('plugin:settings-invalid', { issues: settingIssues });
      ctx.health.report({
        level: 'warn',
        message: `配置不完整：${settingIssues.map((issue) => `${issue.key} ${issue.message}`).join('；')}`,
      });
    }

    // 清单声明的 skill：以插件目录为根读进来，随插件一起装、一起停。放在能力检查之后，
    // 因为被跳过的插件不该往进程级注册表里塞任何东西。
    const skillDirs = plugin.manifest?.skills ?? [];
    if (skillDirs.length > 0) {
      if (!plugin.root) {
        health.report({
          level: 'warn',
          message: '清单声明了 skills，但插件不是从目录加载的，读不到 skill 正文',
        });
      } else {
        const { skills, problems } = loadManifestSkills(plugin.root, skillDirs);
        for (const problem of problems) {
          logger.warn('plugin:skill-dir', { problem });
          health.report({ level: 'warn', message: `skill 目录：${problem}` });
        }
        for (const skill of skills) registerSkill(skill);
      }
    }

    // 清单声明的角色：正文留在插件目录里，索引写到 `$MICA_HOME/plugin-roles`，输入框的
    // 角色切换与 CLI 的 `/role` 只扫索引，不必为此 setup 插件。
    const rolePaths = plugin.manifest?.roles ?? [];
    if (rolePaths.length > 0) {
      if (!plugin.root) {
        logger.warn('plugin:role-dir', { error: 'no plugin root' });
        health.report({
          level: 'warn',
          message: '清单声明了 roles，但插件不是从目录加载的，读不到角色正文',
        });
      } else {
        const { roles: manifestRoles, problems } = loadManifestRoles(plugin.root, rolePaths);
        for (const problem of problems) {
          logger.warn('plugin:role-dir', { problem });
          health.report({ level: 'warn', message: `角色目录：${problem}` });
        }
        publishPluginRoles(plugin.id, manifestRoles, { configDir });
      }
    }

    try {
      const disposable = await plugin.setup(ctx);
      if (disposable) localDisposables.push(disposable);
      // 保留这份登记表：常驻插件在 setup 返回之后仍可能注册界面或清理回调。按插件分开存，
      // 停用这一个插件时只释放这一份，不碰别人的工具、命令与钩子。
      this.runs.set(plugin.id, localDisposables);
      report.loaded.push(plugin.id);
      this.attempts.set(plugin.id, { status: 'loaded' });
    } catch (error) {
      try {
        await disposeResources(localDisposables);
      } catch {
        // Preserve the setup error as the canonical plugin failure.
      }
      report.failed.push({ pluginId: plugin.id, error });
      this.attempts.set(plugin.id, { status: 'failed', error });
      logger.error('plugin:setup-failed', { error: errorMessage(error) });
      if (plugin.required) throw error;
    }
  }

  has(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  /**
   * 按 `plugins-state.json` 对齐一次：名单变了就卸载停用的、装配重新启用的。
   *
   * 每轮开始调用（`turn:before` 分发之前）。名单没变时只做一次 stat，不读文件、也不碰
   * 任何插件；正在跑的那一轮不受影响，变化从下一轮开始生效。
   */
  async syncPluginState(): Promise<PluginStateChange | null> {
    const baseContext = this.baseContext;
    if (!baseContext?.pluginStateSync) return null;
    // 两个会话可能同时到轮次边界：后到的等前一次做完再看文件，别各按半份名单改。
    if (this.syncing) return this.syncing;
    const path = resolveStatePath(baseContext);
    const signature = stateSignature(path);
    if (signature === this.stateSignature) return null;
    this.stateSignature = signature;
    this.syncing = this.applyPluginState(baseContext, readPluginState({ path }).disabled);
    try {
      return await this.syncing;
    } finally {
      this.syncing = null;
    }
  }

  /** 按一份停用名单卸载 / 装配（`syncPluginState` 的实现，测试也直接用它）。 */
  async applyPluginState(baseContext: PluginBaseContext, disabledIds: readonly string[]): Promise<PluginStateChange> {
    const disabled = new Set(disabledIds);
    const change: PluginStateChange = { disabled: [], enabled: [], failed: [] };
    // 停用的先忘掉上一次结论：用户重新启用它时应该真的再试一次，而不是继承「上次失败」。
    for (const pluginId of [...this.attempts.keys()]) {
      if (disabled.has(pluginId)) this.attempts.delete(pluginId);
    }
    for (const pluginId of [...this.runs.keys()]) {
      if (!disabled.has(pluginId)) continue;
      try {
        await this.disposeRun(pluginId);
        this.clearPublishedIndexes(baseContext, pluginId);
        change.disabled.push(pluginId);
      } catch (error) {
        change.failed.push({ pluginId, error });
        baseContext.logger?.error?.('plugin:unload-failed', { pluginId, error: errorMessage(error) });
      }
    }
    if (baseContext.pluginStateSync?.loadUserPlugins) {
      const error = await this.reloadUserPlugins(baseContext, disabled);
      if (error) change.failed.push({ pluginId: '(user-plugins)', error });
    }
    for (const plugin of this.sortedPlugins()) {
      if (disabled.has(plugin.id) || this.runs.has(plugin.id) || this.attempts.has(plugin.id)) continue;
      const report: PluginSetupReport = { loaded: [], failed: [], skipped: [] };
      await this.setupPlugin(plugin, baseContext, this.residentOptions, report);
      if (report.loaded.length > 0) change.enabled.push(plugin.id);
      change.failed.push(...report.failed);
    }
    if (change.disabled.length > 0 || change.enabled.length > 0) {
      baseContext.logger?.info?.('plugin:state-synced', {
        disabled: change.disabled,
        enabled: change.enabled,
      });
    }
    this.writeStatus(baseContext);
    return change;
  }

  /** 此刻各插件的装配结论：`plugin-status.json` 与配置页都以它为准。 */
  setupReport(): PluginSetupReport {
    const report: PluginSetupReport = { loaded: [], failed: [], skipped: [] };
    for (const [pluginId, attempt] of this.attempts) {
      if (attempt.status === 'loaded') report.loaded.push(pluginId);
      else if (attempt.status === 'failed') report.failed.push({ pluginId, error: attempt.error });
      else report.skipped.push({ pluginId, missing: attempt.missing });
    }
    return report;
  }

  async disposeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const pluginId of [...this.runs.keys()].reverse()) {
      try {
        await this.disposeRun(pluginId);
      } catch (error) {
        errors.push(error);
      }
    }
    this.stateSyncHook?.dispose();
    this.stateSyncHook = null;
    this.prepareStateSyncHook?.dispose();
    this.prepareStateSyncHook = null;
    this.stateSettledHook?.dispose();
    this.stateSettledHook = null;
    if (this.stateSyncTimer) clearTimeout(this.stateSyncTimer);
    this.stateSyncTimer = null;
    if (this.watchedStatePath) unwatchFile(this.watchedStatePath);
    this.watchedStatePath = null;
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to dispose plugin resources');
  }

  /** 释放一个插件注册的全部资源。资源本身按登记的逆序释放。 */
  private async disposeRun(pluginId: string): Promise<void> {
    const disposables = this.runs.get(pluginId);
    this.runs.delete(pluginId);
    this.attempts.delete(pluginId);
    if (disposables) await disposeResources(disposables);
  }

  /**
   * 停用一个插件时把它发布的角色与内置 skill 索引一起撤掉。
   *
   * 索引本来是给「不 setup 插件的宿主」看的（输入框的角色箭头、桌面端的 `/` 补全）。那些
   * 宿主会按 `plugins-state.json` 过滤 skill，却不认得角色：文件留着，停用之后仍然能切到
   * 它的角色。进程退出时**不**清理——那份索引正是留给下一个宿主读的。
   */
  private clearPublishedIndexes(baseContext: PluginBaseContext, pluginId: string): void {
    const configDir = baseContext.paths?.config;
    try {
      publishPluginRoles(pluginId, [], { configDir });
      publishPluginSkills(pluginId, [], { configDir });
    } catch (error) {
      baseContext.logger?.warn?.('plugin:index-clear-failed', { pluginId, error: errorMessage(error) });
    }
  }

  /**
   * 装上名单同步：每轮的 hook 快照生成前运行。被停用的插件不该再处理这一轮，
   * 被启用的插件则要赶上这一轮的 prompt 段落与工具定义。
   */
  private installStateSync(baseContext: PluginBaseContext): void {
    this.stateSignature = stateSignature(resolveStatePath(baseContext));
    this.stateSyncHook?.dispose();
    this.stateSyncHook = baseContext.hooks.beforeEmit('turn:before', async () => {
      // 轮次边界本来就不安全，名单必须先对齐：到这里时 executor 可能已经标了 busy，
      // 但这一轮还没开始跑，工具与钩子换掉不影响任何在途调用。
      await this.runStateSync(baseContext, { force: true });
    });
    this.prepareStateSyncHook?.dispose();
    this.prepareStateSyncHook = baseContext.hooks.beforeEmit('turn:prepare', async () => {
      await this.runStateSync(baseContext, { force: true });
    });
    this.stateSettledHook?.dispose();
    this.stateSettledHook = baseContext.hooks.beforeEmit('turn:after', async () => {
      // 轮次结束就对齐一次：watcher 漏事件（网络盘、容器）时这里兜底，名单没变时
      // 只有一次 stat。忙时攒下的变化也在这里落地。
      await this.runStateSync(baseContext);
    });
    this.watchStateFile(baseContext);
  }

  private async runStateSync(baseContext: PluginBaseContext, options: { force?: boolean } = {}): Promise<void> {
    const canSyncNow = baseContext.pluginStateSync?.canSyncNow;
    if (!options.force && canSyncNow && !canSyncNow()) {
      // 正在跑的一轮里不能把工具与钩子从脚底抽走：`turn:after` 会再对齐一次。
      return;
    }
    try {
      await this.syncPluginState();
    } catch (error) {
      // 同步失败不该打断这一轮：插件保持现状，插件日志里说明发生了什么。
      baseContext.logger?.warn?.('plugin:state-sync-failed', { error: errorMessage(error) });
    }
  }

  /**
   * 盯着 `plugins-state.json`：用户在配置页点开关之后，插件应当立刻装上 / 撤下，
   * 而不是等到下一轮对话。
   *
   * 用 `watchFile`（stat 轮询）而不是 `watch` 目录：这份文件可能还不存在，目录也可能
   * 在第一次写盘前才被创建；300ms 轮询的代价只有一次 stat。
   */
  private watchStateFile(baseContext: PluginBaseContext): void {
    const path = resolveStatePath(baseContext);
    if (this.watchedStatePath === path) return;
    if (this.watchedStatePath) unwatchFile(this.watchedStatePath);
    this.watchedStatePath = path;
    try {
      watchFile(path, { interval: 300 }, (curr, prev) => {
        if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
        this.scheduleStateSync(path);
      });
    } catch (error) {
      baseContext.logger?.warn?.('plugin:state-watch-failed', { error: errorMessage(error) });
    }
  }

  private scheduleStateSync(path: string): void {
    if (this.stateSyncTimer) clearTimeout(this.stateSyncTimer);
    const timer = setTimeout(() => {
      this.stateSyncTimer = null;
      const baseContext = this.baseContext;
      // 路径换过一次（宿主换 config 目录）就别再按旧文件对齐。
      if (!baseContext || resolveStatePath(baseContext) !== path) return;
      void this.runStateSync(baseContext);
    }, 120);
    timer.unref?.();
    this.stateSyncTimer = timer;
  }

  /** 重新扫描用户插件目录并合并加载结果。返回加载失败的原因（成功时为 null）。 */
  private async reloadUserPlugins(
    baseContext: PluginBaseContext,
    disabled: ReadonlySet<string>,
  ): Promise<unknown | null> {
    const loader = baseContext.pluginStateSync?.loadUserPlugins;
    if (!loader) return null;
    try {
      this.mergeUserPluginFiles(await loader({ disabled: [...disabled] }));
      return null;
    } catch (error) {
      baseContext.logger?.warn?.('plugin:user-load-failed', { error: errorMessage(error) });
      return error;
    }
  }

  /** 加载结果是累积的：这一次没扫到的插件（比如刚被停用）不该从状态文件里消失。 */
  private mergeUserPluginFiles(next: Pick<FilePluginLoadResult, 'loaded' | 'failed'>): void {
    const loaded = new Map(this.userPluginFiles.loaded.map((entry) => [entry.pluginId, entry]));
    for (const entry of next.loaded) loaded.set(entry.pluginId, entry);
    const failed = new Map(this.userPluginFiles.failed.map((entry) => [entry.file, entry]));
    for (const entry of next.failed) failed.set(entry.file, entry);
    this.userPluginFiles = { loaded: [...loaded.values()], failed: [...failed.values()] };
  }

  private writeStatus(baseContext: PluginBaseContext): void {
    const options = baseContext.pluginStateSync;
    const paths = baseContext.paths;
    if (!options || !paths) return;
    try {
      writePluginStatus({
        pluginsDir: paths.plugins,
        configDir: paths.config,
        host: options.host,
        filePlugins: this.userPluginFiles,
        setupReport: this.setupReport(),
      });
    } catch (error) {
      // 状态文件写不进去只是配置页少一份说明，不该影响插件运行。
      baseContext.logger?.warn?.('plugin:status-write-failed', { error: errorMessage(error) });
    }
  }

  private sortedPlugins(): MicaPlugin[] {
    return [...this.plugins.values()].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  }

  /**
   * 钩子抛错默认被吞掉（`failPolicy: 'continue'`，这是对的：一个插件不该打断 turn），
   * 但必须留痕——否则「某个插件的钩子每轮都在炸」对用户来说只是「功能没反应」。
   * 这里把它接到该插件自己的文件日志与健康状态上，与插件主动上报走同一条路径。
   */
  private watchHookErrors(baseContext: PluginBaseContext): void {
    const hooks = baseContext.hooks as { setHandlerErrorReporter?: HookErrorReporterInstaller };
    if (typeof hooks?.setHandlerErrorReporter !== 'function') return;
    const loggers = new Map<string, ReturnType<typeof createPluginLogger>>();
    // 每个插件在每个钩子上失败了多少次：观察方按事件数统计会因为限流而严重低估
    // 「每轮都在炸」的钩子，累计数必须由发事件的一方给出。
    const hookFailures = new Map<string, number>();
    const configDir = baseContext.paths?.config;
    hooks.setHandlerErrorReporter((error, hook, pluginId) => {
      const owner = pluginId ?? '(unscoped)';
      let logger = loggers.get(owner);
      if (!logger) {
        logger = createPluginLogger(owner, baseContext.logger);
        loggers.set(owner, logger);
      }
      const message = errorMessage(error);
      logger.error('plugin:hook-failed', { hook, error: message });
      if (pluginId)
        writePluginHealth(
          pluginId,
          { level: 'error', message: `钩子 ${hook} 执行失败：${message}` },
          { configDir, version: this.plugins.get(pluginId)?.version },
        );
      // 观察通道自己的 handler 失败不再回灌：那会让 notify 递归调用自己。
      if (pluginId && hook !== 'plugin:observe') {
        const key = `${pluginId}\n${hook}`;
        const failures = (hookFailures.get(key) ?? 0) + 1;
        hookFailures.set(key, failures);
        baseContext.hooks.notify<PluginObservationEvent>('plugin:observe', {
          pluginId,
          timestamp: new Date().toISOString(),
          type: 'hook:failed',
          hook,
          failures,
          error: message,
        });
      }
    });
  }
}

type HookErrorReporterInstaller = (reporter: (error: unknown, hook: string, pluginId?: string) => void) => void;

/**
 * 清单里声明了、但这份 ctx 上真的没有的能力。
 *
 * 只认 `undefined`：`ui` / `runtime` 这类能力可能只提供部分方法，那种不完整由插件自己
 * 判断，manager 不替它猜——猜错会把能用的插件也关掉。
 */
function missingRequirements(requires: readonly PluginRequirement[], ctx: PluginContext): PluginRequirement[] {
  return requires.filter((requirement) => ctx[requirement] === undefined);
}

/** 名单文件的位置：跟 `paths.config` 走，没有 paths 时退回 `MICA_HOME`。 */
function resolveStatePath(baseContext: Pick<PluginBaseContext, 'paths'>): string {
  const configDir = baseContext.paths?.config;
  return configDir ? join(configDir, PLUGIN_STATE_FILE) : resolvePluginStatePath();
}

/** mtime+size：内容改了就认作变化，改成同样大小也能看出来。 */
function stateSignature(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

async function disposeResources(disposables: Disposable[]): Promise<void> {
  const errors: unknown[] = [];
  while (disposables.length > 0) {
    try {
      await disposables.pop()!.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Failed to dispose plugin resources');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
