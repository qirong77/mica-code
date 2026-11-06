import type { MicaPlugin, PluginContext } from '@packages/mica-plugin/index.js';
import { AskUserTool } from './AskTool.js';
import { buildAskGuidance } from './prompt.js';

/**
 * 提问段落排在计划（50）之后、委派（100）之前：先把要做的事定下来，遇到岔路再问用户。
 */
const PROMPT_SECTION_ORDER = 70;

/**
 * Ask：把模型判断不了的岔路口交还给用户。
 *
 * 插件只做两件事——注册 `ask_user` 工具和一段提问策略。问答本身的能力在宿主的
 * `ctx.ask` 上（见 `PluginAsk.ts`），所以桌面端之外的宿主根本不装载这个插件，
 * 而不是装载一个没人能点的提问。
 */
export class AskPlugin implements MicaPlugin {
  readonly id = 'ask';
  readonly name = 'Ask';

  setup(ctx: PluginContext): void {
    const ask = ctx.ask;
    const tools = ctx.tools;
    if (!ask) throw new Error('ask 插件需要宿主提供 ask 能力');
    if (!tools) throw new Error('ask 插件需要宿主提供 tools 能力');

    const tool = new AskUserTool(ask, {
      getTimeoutMs: () => Number(ctx.settings.get().timeoutMinutes) * 60_000,
      captureOwner: (context) => ctx.session?.captureOwner?.(context),
      onTimeout: (message, owner) => ctx.ui?.notice(message, { status: 'warning', owner }),
    });
    const toolRegistration = tools.register(tool, { icon: '❓' });
    ctx.onDispose(() => toolRegistration.dispose());

    ctx.prompt?.section({
      id: 'ask',
      order: PROMPT_SECTION_ORDER,
      render: () => buildAskGuidance(),
    });
  }
}
