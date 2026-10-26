import type { PluginContext } from '@packages/mica-plugin/index.js';
import { commandHostToken } from '../../commandHost.js';
import { SessionNotesTool } from './NotesTool.js';

/**
 * 会话笔记：用户与模型共同维护的一段 markdown，按会话隔离。
 *
 * 笔记存在会话快照里（不是对话历史），因此：
 * - compact 改不到它，压缩后依然留在 system prompt 里；
 * - 重启 / resume / fork 能带回，新会话从空白开始；
 * - 桌面端笔记面板与这个工具改的是同一份内容。
 *
 * prompt 注入不在这里做——`AgentRuntime.buildSystemPrompt()` 直接把笔记追加到末尾，
 * 这样 TUI / headless / app-server 三个入口天然一致，不会出现只在某一种模式下可见。
 */
export default function setupSessionNotes(ctx: PluginContext): void {
  const host = ctx.services.get(commandHostToken);
  if (!host) throw new Error('session notes requires the builtin command host');
  if (!ctx.tools) throw new Error('session notes requires ctx.tools');

  const agent = host.agent;
  const tool = new SessionNotesTool(
    () => agent.sessionNotes ?? '',
    (notes) => agent.setSessionNotes?.(notes),
  );

  // primaryAgentOnly：笔记属于这条会话，子代理（Agent / btw）写它会让归属变模糊。
  const registration = ctx.tools.register(tool, { icon: '🗒️', primaryAgentOnly: true });
  ctx.onDispose(() => registration.dispose());
}
