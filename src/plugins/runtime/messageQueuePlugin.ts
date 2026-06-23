import { micaPlugin, type PluginContext } from '@packages/mica-plugin/index.js';
import type { RuntimeInput } from '@packages/mica-runtime/index.js';
import type { AgentRuntime } from '../../agent/AgentRuntime.js';
import type { LocalRuntimeController } from '../../app/adapters/LocalRuntimeController.js';
import { micaLogger } from '@packages/mica-logger/index.js';

type RuntimeInputHookEvent = {
  runtime: LocalRuntimeController;
  input: RuntimeInput;
  isCommand: boolean;
  owner?: AgentRuntime;
};

export class MessageQueuePlugin extends micaPlugin.Plugin {
  constructor() {
    super({
      id: 'builtin.runtime.messageQueue',
      name: 'Message Queue',
    });
  }

  setup(ctx: PluginContext): void {
    const inputDisposable = ctx.hooks.on<RuntimeInputHookEvent>(
      'input:received',
      async (event) => {
        if (event.isCommand) return;
        if (!event.runtime.isAgentBusy(event.owner)) return;

        const owner = event.owner ?? event.runtime.getQueueOwner();
        const queueMode = event.input.queueMode ?? 'after_iteration';
        const queuedInput: RuntimeInput = event.input.queueMode ? event.input : { ...event.input, queueMode };
        const queued = event.runtime.enqueueForAgent(owner, queuedInput);
        if (!queued) {
          event.runtime.events.publish({
            type: 'notification',
            level: 'warn',
            message: '已有一条排队消息，等待发送或重新编辑',
            owner,
          });
          return { action: 'handled', reason: 'queue_full' };
        }
        event.runtime.events.publish({
          type: 'queue:changed',
          pendingInputs: event.runtime.listQueueForAgent(owner),
          owner,
        });
        event.runtime.events.publish({
          type: 'notification',
          level: 'info',
          message:
            queueMode === 'after_turn' ? '消息已排队，将在当前任务完成后发送' : '消息已排队，将在本轮迭代完成后发送',
          owner,
        });
        micaLogger.logRuntime('runtime', 'submit:queued', {
          chars: event.input.text.length,
          queued: event.runtime.countQueueForAgent(owner),
          queueMode,
        });

        return { action: 'handled', reason: 'queued' };
      },
      { pluginId: ctx.pluginId, priority: -100 },
    );
    ctx.onDispose(() => inputDisposable.dispose());

    const turnAfterDisposable = ctx.hooks.on<{ runtime: LocalRuntimeController }>(
      'turn:after',
      async (event) => {
        if (event.runtime.getStatus().running) return;
        const next = event.runtime.queue.dequeue();
        event.runtime.events.publish({
          type: 'queue:changed',
          pendingInputs: event.runtime.queue.list(),
          owner: event.runtime.getQueueOwner(),
        });
        if (!next) return;
        await event.runtime.submit(next.text, { source: 'plugin' });
      },
      { pluginId: ctx.pluginId, priority: 100 },
    );
    ctx.onDispose(() => turnAfterDisposable.dispose());
  }
}
