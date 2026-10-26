import type { PluginContext } from '@packages/mica-plugin/index.js';
import { SESSION_NOTES_PLUGIN_ID, normalizeSessionNotes } from '@packages/mica-common/index.js';
import { SessionNotesTool } from './NotesTool.js';
import { formatSessionNotesSection } from './notesSection.js';

/**
 * 会话笔记：用户与模型共同维护的一段 markdown，按会话隔离。
 *
 * 三块能力都从这里接入，内核里没有任何笔记专属代码：
 *
 * - **存储**：`ctx.sessionState`（落到快照的 `pluginState['session-notes']`）。因此
 *   compact 改不到它、resume / fork 能带回、新会话从空白开始；
 * - **工具**：`session_notes`，读写上面那份状态；
 * - **prompt**：`ctx.prompt.section()`，每轮重新渲染，排在所有插件段落最后。
 *
 * 桌面笔记面板走 app-server 的 `mica/notes/*`，与这里读写同一份数据（键由
 * `SESSION_NOTES_PLUGIN_ID` 统一）。
 */
export default function setupSessionNotes(ctx: PluginContext): void {
  if (!ctx.sessionState) throw new Error('session notes requires session state');
  if (!ctx.tools) throw new Error('session notes requires ctx.tools');
  if (!ctx.prompt) throw new Error('session notes requires ctx.prompt');

  const state = ctx.sessionState;
  const read = () => normalizeSessionNotes(state.get());
  const write = (notes: string) => state.set(notes || undefined);

  // primaryAgentOnly：笔记属于这条会话，子代理（Agent / btw）写它会让归属变模糊。
  const registration = ctx.tools.register(new SessionNotesTool(read, write), {
    icon: '🗒️',
    primaryAgentOnly: true,
  });
  ctx.onDispose(() => registration.dispose());

  // order 给一个很大的值：笔记是「每轮都可能变」的内容，排在所有插件段落最后，
  // 免得它一变就把别的插件段落的 cache 前缀也带失效。
  const section = ctx.prompt.section({
    id: 'session-notes',
    order: 1000,
    render: () => formatSessionNotesSection(read()),
  });
  ctx.onDispose(() => section.dispose());

  ctx.logger.info('session-notes:ready', { pluginId: SESSION_NOTES_PLUGIN_ID });
}
