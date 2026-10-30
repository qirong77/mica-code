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
import type { PluginSessionMenuHandler, PluginSessionMenuRegistry } from './PluginSessionMenu.js';
import type { PluginSkillDefinition } from './PluginDesktop.js';
import type { RuntimeSkillRegistration } from '@packages/mica-skills/index.js';
import type { Skill } from '@packages/mica-skills/types.js';
import { loadManifestSkills, publishPluginSkills } from './PluginSkills.js';
import { createPluginHealthStore, writePluginHealth } from './PluginHealth.js';
import { createPluginLogger } from './PluginLog.js';
import { createPluginSettingsStore } from './PluginSettings.js';
import {
  PluginActionRegistry,
  type PluginActionInput,
  type PluginActionResult,
} from './PluginActions.js';
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
 * - `logger`：包装成带插件 id 的文件日志，写进 `resolveLogDir()`（与运行时日志同目录）；
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
  /**
   * 会话右键菜单动作的登记表。与面板同理：宿主提供它、清单声明了 `desktop.sessionMenu`
   * 时，插件才能注册自己的处理器。
   */
  desktopSessionMenus?: PluginSessionMenuRegistry;
};

export class PluginManager {
  private readonly plugins = new Map<string, MicaPlugin>();
  private readonly disposables: Disposable[] = [];
  /**
   * 配置页动作的登记表。
   *
   * 登记本身不需要宿主设施（只是把处理器存起来），所以它跟着 manager 走，任何宿主都
   * 能提供 `ctx.actions`；真正执行动作的是「配置页宿主」——它可以是常驻会话进程，也可以
   * 是一次性进程（`mica plugin-action`）。
   */
  private readonly actions = new PluginActionRegistry(
    (pluginId) => (this.plugins.get(pluginId)?.manifest?.actions ?? []).map((entry) => entry.key),
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

    for (const plugin of this.sortedPlugins()) {
      if (options.only && !options.only.includes(plugin.id)) continue;
      const localDisposables: Disposable[] = [];
      const logger = createPluginLogger(plugin.id, baseContext.logger);
      const configDir = baseContext.paths?.config;
      // 这个插件注册成功的 skill：每次注册后整份重写它的索引文件（见 PluginSkills.ts）。
      const publishedSkills: PluginSkillDefinition[] = [];
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
        desktopSessionMenus,
        ...shared
      } = baseContext;
      const settings = createPluginSettingsStore(plugin.id, plugin.manifest?.settings ?? [], { configDir });
      const health = createPluginHealthStore(plugin.id, { configDir });
      /**
       * 注册一条 skill 并把归属记在这个插件名下。
       *
       * 清单声明的与插件在 setup 里自己注册的走同一条路：磁盘上同名的优先（用户装一份
       * 就能覆盖内置），没注册上的报成一条用户可见状态，生效的顺手重写一份索引——不 setup
       * 插件的宿主（桌面运行时的 `/` 补全、配置页）靠它列出内置 skill，不必为此冷启动一个
       * 会话进程。
       */
      const registerSkill = (skill: Skill): RuntimeSkillRegistration => {
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
        const name = skill.name.trim();
        if (!registration.skipped.some((item) => item.name === name)) {
          publishedSkills.push(skill);
          publishPluginSkills(plugin.id, publishedSkills, { configDir });
        }
        localDisposables.push({ dispose: () => registration.dispose() });
        return registration;
      };
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
          register: (skill) => registerSkill(skill),
        },
        onDispose: (dispose) => localDisposables.push({ dispose }),
      };
      // 常驻任务由 manager 自己调度，不依赖宿主接线：它是纯定时逻辑，任何宿主都能给。
      // 插件没手动 dispose 的循环随 localDisposables 一起回收，所以停用插件 = 循环停止。
      const background = createPluginBackgroundScheduler({
        pluginId: plugin.id,
        enabled: options.backgroundTasks !== false,
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
          ...(agentRegistry.compactIdleHistory
            ? {
                compactIdleHistory: (hook) => agentRegistry.compactIdleHistory!(plugin.id, hook),
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
            ? { panel: (handler: PluginPanelHandler) => panels.add(plugin.id, handler) }
            : {}),
          ...(sessionMenus && (plugin.manifest?.desktopSessionMenu.length ?? 0) > 0
            ? {
                sessionMenu: (handler: PluginSessionMenuHandler) =>
                  sessionMenus.add(plugin.id, handler),
              }
            : {}),
        };
      }
      // 配置页动作：不需要会话，也不属于 `desktop` 那半边（一次性进程同样提供）。
      // 清单声明了按钮才有注册口，理由同面板：没按钮还接受注册等于骗插件。
      if ((plugin.manifest?.actions.length ?? 0) > 0) {
        const actionStore = this.actions;
        ctx.actions = {
          register: (key, handler) => actionStore.add(plugin.id, key, handler),
        };
      }
      if (plugin.manifest?.llm && modelsHandler) {
        // 生效值 = 全局设置 + 本会话覆盖；每次调用重新合并，配置页改完立刻生效。
        const llmSpec = plugin.manifest.llm;
        ctx.llm = createPluginLlmApi({
          spec: llmSpec,
          readValues: () => ({ ...settings.get(), ...(sessionSettingsHost?.read() ?? {}) }),
          models: (request) => modelsHandler(plugin.id, request),
          // 配置的接口/模型不可用时组件会自动降级为主配置，这里留一条「为什么降级了」。
          health,
        });
      }

      // 清单声明的能力必须都能兑现，否则插件一定会在运行期踩空。放在 setup 之前判断，
      // 装配出来的 ctx 就是事实，不需要插件自己再猜。
      const missing = options.ignoreRequirements
        ? []
        : missingRequirements(plugin.manifest?.requires ?? [], ctx);
      if (missing.length > 0) {
        // 缺宿主能力是**这一份宿主**的事实，不是插件「现在怎么样」：TUI、`mica exec`、
        // `mica commit` 本来就没有 `desktop` 这些面。写进所有宿主共享的 plugin-health 会
        // 让桌面端显示一条别的宿主留下的「待配置」，而插件在桌面端其实好好的。留痕走日志
        // 与 skipped 报告（用户插件那份落进 plugin-status.json）。
        report.skipped.push({ pluginId: plugin.id, missing });
        logger.warn('plugin:skipped', { missing });
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
