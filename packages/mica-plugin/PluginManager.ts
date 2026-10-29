import type { Disposable } from '@packages/mica-common/index.js';
import type { MicaPlugin } from './Plugin.js';
import type { PluginContext } from './PluginContext.js';
import type { PluginAgentRegistry } from './PluginAgent.js';
import type { PluginModelsHandler } from './PluginModels.js';
import type { PluginRequirement } from './PluginManifest.js';
import type { PluginPromptSections } from './PluginPrompt.js';
import type { PluginSessionStateApi } from './PluginSessionState.js';
import { createPluginSessionSettingsApi, type PluginSessionSettingsHostApi } from './PluginSessionSettings.js';
import { createPluginLlmApi } from './PluginLlm.js';
import { createPluginBackgroundScheduler } from './PluginBackground.js';
import type { PluginSubagentApi } from './PluginSubagents.js';
import type { PluginPanelHandler, PluginPanelRegistry } from './PluginPanel.js';
import { createPluginHealthStore, writePluginHealth } from './PluginHealth.js';
import { createPluginLogger } from './PluginLog.js';
import { createPluginSettingsStore } from './PluginSettings.js';
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

/**
 * 每个插件在 setup 时拿到的东西，去掉几项「按插件生成」的：
 *
 * - `pluginId` / `onDispose`：生命周期绑定，只由 PluginManager 决定；
 * - `logger`：包装成带插件 id 的文件日志，写进 `os.tmpdir()/mica-logs/`；
 * - `settings`：按插件清单里的 `settings` 声明读取，路径跟着 `paths.config` 走；
 * - `health`：插件自报状态，落到 `$MICA_HOME/plugin-health/<id>.json`；
 * - `prompt`：包一层只写自己段落的入口。
 * - `skills`：进程级 skill 注册表，按 pluginId 归属，卸载时一起摘掉。
 *
 * host 仍然可以传自己的 `logger`，它会作为落盘之外的转发目标（TUI 静默、headless 写 stderr）。
 */
export type PluginBaseContext = Omit<
  PluginContext,
  'pluginId' | 'onDispose' | 'logger' | 'settings' | 'sessionSettings' | 'health' | 'skills' | 'models'
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
};

export class PluginManager {
  private readonly plugins = new Map<string, MicaPlugin>();
  private readonly disposables: Disposable[] = [];

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
   * `quietSkips` 给「只跑一条命令」的一次性宿主用（`mica commit`）：那种进程本来就只
   * 提供命令相关的几面能力，别的插件因为缺能力被跳过是设计如此，不该把用户的插件健康
   * 状态写成「宿主未提供能力」。
   */
  async setupAll(baseContext: PluginBaseContext, options: { quietSkips?: boolean } = {}): Promise<PluginSetupReport> {
    const report: PluginSetupReport = { loaded: [], failed: [], skipped: [] };
    this.watchHookErrors(baseContext);

    for (const plugin of this.sortedPlugins()) {
      const localDisposables: Disposable[] = [];
      const logger = createPluginLogger(plugin.id, baseContext.logger);
      const configDir = baseContext.paths?.config;
      // `sessionStateFor` / `promptSections` 由 manager 消费（下面按 pluginId 生成
      // 本插件专属的入口），不能原样漏进 ctx，否则插件会看到一个能读别人状态的入口。
      const {
        sessionStateFor,
        sessionSettingsFor,
        promptSections: promptRegistry,
        agentRegistry,
        subagentsFor,
        pluginModels: modelsHandler,
        desktopPanels,
        ...shared
      } = baseContext;
      const settings = createPluginSettingsStore(plugin.id, plugin.manifest?.settings ?? [], { configDir });
      const health = createPluginHealthStore(plugin.id, { configDir });
      // 宿主的会话级读写面按 pluginId 绑定；没有它就退化成「只有全局设置」，
      // 插件通过 `requires: ['sessionSettings']` 声明这一点，缺能力时注册阶段跳过。
      const sessionSettingsHost = sessionSettingsFor?.(plugin.id);
      const ctx: PluginContext = {
        ...shared,
        pluginId: plugin.id,
        logger,
        settings,
        ...(sessionSettingsHost
          ? {
              sessionSettings: createPluginSessionSettingsApi({
                fields: plugin.manifest?.settings ?? [],
                readGlobal: () => settings.get(),
                readOverrides: () => sessionSettingsHost.read(),
                writeOverrides: (value) => sessionSettingsHost.write(value),
              }),
            }
          : {}),
        health,
        // skill 是进程级注册表（磁盘扫描 + 插件注册合流），所以不需要宿主接线：
        // 注册归属这个插件，卸载时按 pluginId 一起摘掉。
        skills: {
          register: (skill) => {
            const registration = micaSkills.registerRuntime(plugin.id, [skill]);
            if (registration.skipped.length > 0) {
              logger.warn('plugin:skill-shadowed', { skipped: registration.skipped });
              health.report({
                level: 'warn',
                message: `skill 未注册：${registration.skipped
                  .map((item) => `${item.name}（${item.reason}）`)
                  .join('；')}`,
              });
            }
            localDisposables.push({ dispose: () => registration.dispose() });
            return { dispose: registration.dispose, skipped: registration.skipped };
          },
        },
        onDispose: (dispose) => localDisposables.push({ dispose }),
      };
      // 常驻任务由 manager 自己调度，不依赖宿主接线：它是纯定时逻辑，任何宿主都能给。
      // 插件没手动 dispose 的循环随 localDisposables 一起回收，所以停用插件 = 循环停止。
      const background = createPluginBackgroundScheduler({
        pluginId: plugin.id,
        onError: (taskId, error) => {
          const message = errorMessage(error);
          logger.warn('plugin:background-failed', { taskId, error: message });
          health.report({ level: 'warn', message: `常驻任务 ${taskId} 失败：${message}` });
        },
      });
      ctx.background = background;
      localDisposables.push({ dispose: () => background.disposeAll() });
      const sessionState = sessionStateFor?.(plugin.id);
      if (sessionState) ctx.sessionState = sessionState;
      if (promptRegistry) {
        ctx.prompt = { section: (section) => promptRegistry.add(plugin.id, section) };
      }
      if (agentRegistry) {
        ctx.agent = {
          mode: agentRegistry.mode,
          onIterationRewrite: (handler) => agentRegistry.onIterationRewrite(plugin.id, handler),
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
        ctx.desktop = {
          host: 'desktop',
          ...(panels && plugin.manifest?.desktopPanel
            ? { panel: (handler: PluginPanelHandler) => panels.add(plugin.id, handler) }
            : {}),
        };
      }
      if (plugin.manifest?.llm && modelsHandler) {
        // 生效值 = 全局设置 + 本会话覆盖；每次调用重新合并，配置页改完立刻生效。
        const llmSpec = plugin.manifest.llm;
        ctx.llm = createPluginLlmApi({
          spec: llmSpec,
          readValues: () => ({ ...settings.get(), ...(sessionSettingsHost?.read() ?? {}) }),
          models: (request) => modelsHandler(plugin.id, request),
        });
      }

      // 清单声明的能力必须都能兑现，否则插件一定会在运行期踩空。放在 setup 之前判断，
      // 装配出来的 ctx 就是事实，不需要插件自己再猜。
      const missing = missingRequirements(plugin.manifest?.requires ?? [], ctx);
      if (missing.length > 0) {
        report.skipped.push({ pluginId: plugin.id, missing });
        if (!options.quietSkips) {
          logger.warn('plugin:skipped', { missing });
          ctx.health.report({ level: 'warn', message: `宿主未提供能力：${missing.join(', ')}` });
        }
        continue;
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

      try {
        const disposable = await plugin.setup(ctx);
        if (disposable) localDisposables.push(disposable);
        this.disposables.push(...localDisposables.reverse());
        report.loaded.push(plugin.id);
      } catch (error) {
        for (const disposable of localDisposables.splice(0).reverse()) {
          try {
            await disposable.dispose();
          } catch {
            // Preserve the setup error as the canonical plugin failure.
          }
        }
        report.failed.push({ pluginId: plugin.id, error });
        logger.error('plugin:setup-failed', { error: errorMessage(error) });
        ctx.health.report({ level: 'error', message: `启动失败：${errorMessage(error)}` });
        if (plugin.required) throw error;
      }
    }

    return report;
  }

  has(pluginId: string): boolean {
    return this.plugins.has(pluginId);
  }

  async disposeAll(): Promise<void> {
    for (const disposable of this.disposables.splice(0).reverse()) {
      await disposable.dispose();
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
        writePluginHealth(pluginId, { level: 'error', message: `钩子 ${hook} 执行失败：${message}` }, { configDir });
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
