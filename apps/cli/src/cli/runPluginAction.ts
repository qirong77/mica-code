import { micaCommands } from '@packages/mica-commands/index.js';
import { formatExecError } from '@packages/mica-common/index.js';
import { officialPlugins } from '@packages/mica-official-plugins/index.js';
import { loadUserPlugins, micaPlugin, readDisabledPluginIds } from '@packages/mica-plugin/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { readActiveProviderConfig } from '@packages/mica-config/index.js';
import { createPluginModels } from '../plugins/pluginModels.js';
import { createPluginPaths } from '../plugins/pluginPaths.js';

/**
 * 一次性执行某个插件的配置页动作（配置页的「注册」「测试连接」这类按钮走这里）。
 *
 * 与 `runPluginCommand` 同一个思路：动作属于插件，内核只把它跑起来。这个进程里没有
 * agent、没有 turn、没有会话——正因为如此，配置页点按钮才不需要先打开一条会话，也不会
 * 把人从设置页拽到对话里。
 *
 * 输出约定（配置页按它解析）：`{ ok: true, message?, link? }` 或 `{ ok: false, code, error }`。
 */

export type PluginActionRunOptions = {
  pluginId: string;
  action: string;
  /** 页面上当前的设置值（可能是还没写盘的草稿）。 */
  values?: Record<string, string>;
};

export type PluginActionRunResult = {
  ok: boolean;
  message?: string;
  link?: string;
  code?: string;
  error?: string;
};

export async function runPluginAction(options: PluginActionRunOptions): Promise<PluginActionRunResult> {
  const paths = createPluginPaths();
  const plugins = new micaPlugin.PluginManager();
  const commands = new micaCommands.CommandRegistry();
  const hooks = new micaPlugin.HookRegistry();
  const events = new micaRuntime.RuntimeEventBus();
  const services = new micaPlugin.ServiceContainer();
  // 只接受清单里声明过的 key：声明与实现写岔了要当场报出来，而不是点了没反应。
  const declared = new Map<string, string[]>();
  for (const plugin of officialPlugins) {
    declared.set(plugin.id, (plugin.manifest?.actions ?? []).map((entry) => entry.key));
  }
  const disabled = readDisabledPluginIds();
  for (const plugin of officialPlugins) {
    if (disabled.has(plugin.id)) continue;
    plugins.register(plugin);
  }
  // 配置页同样列出用户插件，它们的按钮要能点。这里不写 plugin-status.json：
  // 点一次按钮不该改写「插件装没装上」的记录，那是常驻宿主的职责。
  const userPlugins = await loadUserPlugins(plugins, {
    pluginsDir: paths.plugins,
    disabled: [...disabled]
  });
  for (const plugin of userPlugins.plugins) {
    if (!plugin.manifest) continue;
    declared.set(plugin.id, (plugin.manifest.actions ?? []).map((entry) => entry.key));
  }

  await plugins.setupAll(
    {
      paths,
      services,
      hooks,
      commands,
      events,
      // 动作里可能要问一次模型（试连插件自己的模型接口），请求由宿主代发；没有会话，
      // 因此只发请求、不入账。
      pluginModels: createPluginModels({
        resolveMainProvider: (model) => readActiveProviderConfig(model ? { model } : {}),
      }),
    },
    // 只装目标插件：这个进程不提供 tools / background 这类能力，无关插件装配进来
    // 只会得到一堆「缺能力」的跳过记录。
    {
      quietSkips: true,
      only: [options.pluginId],
      ignoreRequirements: true,
      // 一次点击不该留下常驻进程：常驻任务只登记，不排期。
      backgroundTasks: false,
    },
  );

  if (!declared.get(options.pluginId)?.includes(options.action)) {
    return {
      ok: false,
      code: 'unknown_action',
      error: `插件 ${options.pluginId} 没有声明动作 ${options.action}`
    };
  }
  if (!plugins.hasPluginAction(options.pluginId, options.action)) {
    return {
      ok: false,
      code: 'action_not_registered',
      error: `插件 ${options.pluginId} 的动作 ${options.action} 在当前宿主里不可用（可能被停用或缺少依赖）`
    };
  }

  try {
    const result = await plugins.runPluginAction(options.pluginId, options.action, {
      values: options.values ?? {}
    });
    if (!result) return { ok: true };
    return {
      ok: true,
      ...(result.message ? { message: result.message } : {}),
      ...(result.link ? { link: result.link } : {})
    };
  } catch (error) {
    return { ok: false, code: 'error', error: formatExecError(error) };
  }
}
