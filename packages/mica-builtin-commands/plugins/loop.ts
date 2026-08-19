import type { PluginContext } from '@packages/mica-plugin/index.js';
import { commandHostToken } from '@packages/mica-builtin-commands/commandHost.js';
import {
  createLoopCommand,
  LoopController,
  ToolLoopSetInterval,
  ToolLoopSetTask,
  ToolLoopStatus,
  ToolLoopStop,
} from '../commands/loop.js';

type SystemPromptBuildEvent = {
  runtime: unknown;
  prompt: string;
};

/**
 * /loop 定时循环任务：
 * - 注册 `/loop <间隔> <任务描述>` 命令（/loop stop 停止、/loop 查看状态）；
 * - 循环运行时经 `system-prompt:build` 钩子在系统提示词末尾追加 loop 模式指引；
 * - 每轮间隔用 `submitAgentSessionInput` 提交一次任务（after_turn，忙时由 message-queue 兜底）；
 * - 注册 `loop_status`/`loop_set_interval`/`loop_set_task`/`loop_stop` 工具，供模型在对话中调整循环（仅主 agent）。
 */
export default function setupLoop(ctx: PluginContext): void {
  const host = ctx.services.get(commandHostToken);
  if (!host) throw new Error('loop requires the builtin command host');
  const services = host.services;

  const controller = new LoopController();

  const tools = [
    new ToolLoopStatus({ controller, services }),
    new ToolLoopSetInterval({ controller, services }),
    new ToolLoopSetTask({ controller, services }),
    new ToolLoopStop({ controller, services }),
  ].map((tool) => {
    if (!ctx.tools) throw new Error('loop requires ctx.tools');
    const registration = ctx.tools.register(tool, { icon: '⏰', primaryAgentOnly: true });
    ctx.onDispose(() => registration.dispose());
    return registration;
  });
  void tools;

  const promptBuildDisposable = ctx.hooks.on<SystemPromptBuildEvent, { event: SystemPromptBuildEvent }>(
    'system-prompt:build',
    (event) => {
      const suffix = controller.buildSystemPromptSuffix();
      if (!suffix) return { event };
      return { event: { ...event, prompt: `${event.prompt}\n\n${suffix}` } };
    },
    { pluginId: ctx.pluginId, priority: 20, failPolicy: 'continue' },
  );
  ctx.onDispose(() => promptBuildDisposable.dispose());
  ctx.onDispose(() => controller.stop());

  host.registerCommand(ctx, createLoopCommand(host.agent, host.sessionController, services, controller));
}
