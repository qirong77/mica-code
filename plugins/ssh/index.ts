import { join } from 'node:path';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { resolveMicaHome } from '@packages/mica-config/index.js';
import { createPanelHandler } from './Panel.js';
import { closeAllControlMasters, createRemoteContext } from './Remote.js';
import { SessionManager } from './Session.js';
import { createTools } from './Tools.js';
import { createPromptSection } from './Prompt.js';
import { readData } from './Hosts.js';

/**
 * `ssh`：让模型操作**远端**服务器。
 *
 * 与内置 `run_shell` 的分界：那个跑在会话所在的这台机器上；这个走系统 OpenSSH 到别的机器。
 * 之所以不实现 SSH 协议（node ssh2），是因为系统 ssh 已经带着用户的一切：`~/.ssh/config`、
 * 私钥、ssh-agent、ProxyJump、2FA、known_hosts。自己写一套只会在「跳板机连不上」「key 要
 * 不要 passphrase」这些地方反复出问题。
 *
 * 数据都在 `$MICA_HOME/plugin-data/ssh/`：`data.json` 主机清单与开关、`known_hosts` 固定的
 * 主机指纹、`audit.jsonl` 调用记录、`panel.json` 面板草稿、`secrets.json` 口令（0600 明文，
 * 只有插件自己读——模型只看到别名，见 `Secrets.ts`）。
 *
 * 开关（`data.json.enabled`）决定这个插件**是否对模型存在**：关着就不注册工具、不注入
 * prompt、输入框上方也不显示状态栏。面板里那个开关改完立刻生效，不需要重开会话。
 */

const PLUGIN_ID = 'ssh';

export default function setup(ctx: PluginContext): void {
  const dataDir = join(ctx.paths?.config ?? resolveMicaHome(), 'plugin-data', ctx.pluginId ?? PLUGIN_ID);
  const settings = ctx.settings.get();
  const remote = createRemoteContext({
    dataDir,
    defaultTimeoutMs: Number(settings.defaultTimeoutSec ?? 120) * 1000,
    tailLines: Number(settings.tailLines ?? 300),
    persistSeconds: Number(settings.controlPersistSec ?? 600),
  });
  const dataFile = join(dataDir, 'data.json');

  const sessions = new SessionManager(remote);
  const tools = ctx.tools;
  if (!tools) throw new Error('ssh 需要宿主提供 tools 能力');

  const toolDeps = {
    ctx: remote,
    dataFile,
    sessions,
    dataDir,
    register: (tool: Parameters<typeof tools.register>[0], options?: Parameters<typeof tools.register>[1]) =>
      tools.register(tool, options),
  };
  let toolDisposables: { dispose(): void }[] = [];
  const syncTools = (): void => {
    const enabled = readData(dataFile).enabled;
    if (enabled && toolDisposables.length === 0) {
      toolDisposables = createTools(toolDeps);
      return;
    }
    if (!enabled && toolDisposables.length > 0) {
      for (const disposable of toolDisposables) disposable.dispose();
      toolDisposables = [];
    }
  };
  syncTools();

  ctx.prompt?.section({
    id: 'ssh',
    // 排在项目说明之后：主机清单是会变的内容，前面稳定的前缀不跟着它失效。
    order: 60,
    render: createPromptSection(dataFile),
  });

  const panel = ctx.desktop?.panel?.(
    createPanelHandler({
      ctx: remote,
      dataFile,
      closeSession: (hostId) => sessions.close(hostId),
      onEnabledChange: () => syncTools(),
    }),
  );
  if (panel) ctx.onDispose(() => panel.dispose());

  ctx.onDispose(() => {
    for (const disposable of toolDisposables) disposable.dispose();
    toolDisposables = [];
    sessions.closeAll();
    closeAllControlMasters(remote, readData(dataFile).hosts);
  });
}
