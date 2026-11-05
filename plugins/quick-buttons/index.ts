import type { PluginContext } from '@packages/mica-plugin/index.js';
import { QUICK_BUTTONS_STATE_VERSION, readQuickButtons, type QuickButton } from './buttons.js';
import { createPanelHandler } from './panel.js';
import { renderQuickButtonsPrompt } from './prompt.js';
import { QuickButtonsTool, type QuickButtonsStore } from './QuickButtonsTool.js';

/**
 * `quick-buttons`：输入框上方那一排「点一下就走」的按钮。
 *
 * 三块能力，各自独立：
 *
 * - **工具** `quick_buttons`：模型建/改这一排（本会话的 `pluginState`）；
 * - **面板**：按钮由视图在运行期给出（清单 `dynamicShortcuts`），点一下回到插件的
 *   `run`；面板本身是维护界面，看一眼、删一个、手动加一个；
 * - **prompt**：只在桌面宿主里说明这套东西该怎么用。
 *
 * 工具在所有宿主里都注册：`mica exec` / TUI 里按钮没有落点，但工具结果会把每个按钮的
 * 地址与文本摊平成可读的行——CLI 里这个能力的形态就是那几行链接。因此清单的 `requires`
 * 不写 `desktop`，`ctx.desktop` 只是可选的。
 */

export const QUICK_BUTTONS_PLUGIN_ID = 'quick-buttons';

export default function setupQuickButtons(ctx: PluginContext): void {
  const state = ctx.sessionState;
  if (!state) throw new Error('quick-buttons 需要宿主提供 sessionState');
  if (!ctx.tools) throw new Error('quick-buttons 需要宿主提供 tools');

  const store: QuickButtonsStore = {
    read: () => readQuickButtons(state.get()),
    write: (buttons: QuickButton[]) => state.set({ version: QUICK_BUTTONS_STATE_VERSION, buttons }),
  };

  const hasPanel = Boolean(ctx.desktop?.panel);
  const tool = ctx.tools.register(new QuickButtonsTool(store, { desktop: hasPanel }), {
    icon: '🔘',
    // 按钮属于这条会话的界面：子代理顺手改一排，用户不知道是谁放的。
    primaryAgentOnly: true,
  });
  ctx.onDispose(() => tool.dispose());

  const cwd = () => ctx.session?.describe()?.cwd;
  const panel = ctx.desktop?.panel?.(
    createPanelHandler({
      read: store.read,
      write: store.write,
      cwd,
    }),
  );
  if (panel) ctx.onDispose(() => panel.dispose());

  const section = ctx.prompt?.section({
    id: QUICK_BUTTONS_PLUGIN_ID,
    // 插件段落本来就追加在 base prompt 之后（受影响的只有它们自己这一段之后的部分），
    // 排在会话笔记（1000）之前：这段讲的是「这一轮可以用的手段」，越早越容易被用上。
    order: 70,
    render: () => (hasPanel ? renderQuickButtonsPrompt() : ''),
  });
  if (section) ctx.onDispose(() => section.dispose());

  ctx.logger.info('quick-buttons:ready', { panel: hasPanel });
}
