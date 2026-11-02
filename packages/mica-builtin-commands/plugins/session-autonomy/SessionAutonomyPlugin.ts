import type { PluginContext } from '@packages/mica-plugin/index.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';
import type { CommandRuntimeServices } from '@packages/mica-builtin-commands/index.js';
import { ToolSessionPeers } from './SessionAutonomyTools.js';

const SESSION_AUTONOMY_GUIDANCE = `# 会话自治（Session Autonomy）

你可以通过以下工具观察当前会话：
- session_peers：查看正在运行的其他 Mica 实例及其 session 文件路径；怀疑工作区被别的会话改动时用它排查。
  传入 hours（如 6）还会列出最近 N 小时内结束的会话——它们已释放 turn 锁，但可能刚改过工作区。`;

export default function setupSessionAutonomy(ctx: PluginContext): void {
  const host = ctx.services.get(commandHostToken);
  if (!host) throw new Error('session-autonomy requires the builtin command host');
  const services: CommandRuntimeServices = host.services;

  if (!ctx.tools) throw new Error('session-autonomy requires ctx.tools');
  const registration = ctx.tools.register(new ToolSessionPeers({ services }), { primaryAgentOnly: true });
  ctx.onDispose(() => registration.dispose());

  if (!ctx.prompt) throw new Error('SessionAutonomyPlugin requires ctx.prompt');
  const promptBuildDisposable = ctx.prompt.section({
    id: 'guidance',
    order: -200,
    render: () => SESSION_AUTONOMY_GUIDANCE,
  });
  ctx.onDispose(() => promptBuildDisposable.dispose());
}
