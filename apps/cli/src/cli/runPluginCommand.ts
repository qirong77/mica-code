import { resolve } from 'node:path';
import { micaCommands } from '@packages/mica-commands/index.js';
import { formatExecError } from '@packages/mica-common/index.js';
import { officialPlugins } from '@packages/mica-official-plugins/index.js';
import { micaPlugin, readDisabledPluginIds, type PluginSetupReport } from '@packages/mica-plugin/index.js';
import { micaRuntime } from '@packages/mica-runtime/index.js';
import { createPluginModels } from '../plugins/pluginModels.js';
import { createPluginPaths } from '../plugins/pluginPaths.js';

/**
 * 一次性执行某个已注册的插件命令（`mica commit` 走这里）。
 *
 * 命令的实现属于插件，内核只负责把它跑起来：装配官方插件、解析命令名、把结果交回
 * 调用方。所以这个进程里没有 agent、没有 turn、没有会话——需要这些能力的插件会被
 * 跳过（而不是把整个命令弄崩），命令自己声明 `requires` 就该是命令真正用到的那几项。
 *
 * 输出约定（桌面端按它解析）：`{ ok: true, ...data }` 或 `{ ok: false, code, error }`。
 */

export type PluginCommandRunOptions = {
  /** 命令名，不带前导 `/`。 */
  name: string;
  cwd?: string;
};

export type PluginCommandRunResult = {
  ok: boolean;
  code?: string;
  error?: string;
  [key: string]: unknown;
};

export async function runPluginCommand(options: PluginCommandRunOptions): Promise<PluginCommandRunResult> {
  if (options.cwd) process.chdir(resolve(options.cwd));

  const plugins = new micaPlugin.PluginManager();
  const commands = new micaCommands.CommandRegistry();
  const hooks = new micaPlugin.HookRegistry();
  const events = new micaRuntime.RuntimeEventBus();
  const services = new micaPlugin.ServiceContainer();

  const disabled = readDisabledPluginIds();
  for (const plugin of officialPlugins) {
    if (disabled.has(plugin.id)) continue;
    plugins.register(plugin);
  }

  const report = await plugins.setupAll(
    {
      paths: createPluginPaths(),
      services,
      hooks,
      commands,
      events,
      // 命令里也可能要模型（`/commit` 的提交说明）：请求由宿主代发，
      // 这个进程没有会话，所以只发请求、不入账。
      pluginModels: createPluginModels(),
    },
    // 这里只有命令相关的几面能力，别的插件因为缺能力被跳过是正常现象，
    // 不能把「跳过」写进用户的插件健康状态。
    { quietSkips: true },
  );

  const command = `/${options.name.trim().replace(/^\//, '')}`;
  try {
    if (!commands.resolve(command)) {
      return { ok: false, code: 'unknown_command', error: unknownCommandMessage(command, report) };
    }
    const result = await commands.execute(command, {});
    if (result.ok) {
      const data = isRecord(result.data) ? result.data : {};
      return { ok: true, ...data, ...(result.message ? { message: result.message } : {}) };
    }
    const data = isRecord(result.data) ? result.data : {};
    const message = result.message || (result.error instanceof Error ? result.error.message : String(result.error));
    return { ...data, ok: false, code: typeof data.code === 'string' ? data.code : 'error', error: message };
  } catch (error) {
    return { ok: false, code: 'error', error: formatExecError(error) };
  } finally {
    await plugins.disposeAll();
  }
}

function unknownCommandMessage(command: string, report: PluginSetupReport) {
  const skipped = report.skipped
    .filter((item) => item.missing.length > 0)
    .map((item) => `${item.pluginId}（缺 ${item.missing.join(', ')}）`)
    .join('、');
  const loaded = report.loaded.length > 0 ? report.loaded.join(', ') : '（无）';
  return `没有找到命令 ${command}：已加载插件 ${loaded}${skipped ? `；跳过 ${skipped}` : ''}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
