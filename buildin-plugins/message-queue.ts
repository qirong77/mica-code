import type { PluginContext } from '@packages/mica-plugin/index.js';
import type {
  RuntimeInput,
  RuntimeInputReceivedHookEvent,
  RuntimeTurnAfterHookEvent,
} from '@packages/mica-runtime/index.js';

export default function setupMessageQueue(ctx: PluginContext): void {
  const runtime = ctx.runtime;
  const queue = runtime?.queue;
  if (!runtime || !queue) throw new Error('message-queue requires ctx.runtime.queue');

  const inputDisposable = ctx.hooks.on<RuntimeInputReceivedHookEvent>(
    'input:received',
    async (event) => {
      if (event.isCommand) return;
      if (!queue.isBusy(event.owner)) return;

      const queueMode = event.input.queueMode ?? 'after_turn';
      const queuedInput: RuntimeInput = event.input.queueMode ? event.input : { ...event.input, queueMode };
      const queued = queue.enqueue(event.owner, queuedInput);
      if (!queued) {
        ctx.events.publish({
          type: 'notification',
          level: 'warn',
          message: '已有一条排队消息，等待发送或重新编辑',
          owner: event.owner,
        });
        return { action: 'handled' as const, reason: 'queue_full' };
      }

      ctx.events.publish({
        type: 'queue:changed',
        pendingInputs: queue.list(event.owner),
        owner: event.owner,
      });
      ctx.events.publish({
        type: 'notification',
        level: 'info',
        message:
          queueMode === 'after_turn' ? '消息已排队，将在当前任务完成后发送' : '消息已排队，将在本轮迭代完成后发送',
        owner: event.owner,
      });

      return { action: 'handled' as const, reason: 'queued' };
    },
    { pluginId: ctx.pluginId, priority: -100 },
  );
  ctx.onDispose(() => inputDisposable.dispose());

  const turnAfterDisposable = ctx.hooks.on<RuntimeTurnAfterHookEvent>(
    'turn:after',
    async (event) => {
      if (queue.isBusy(event.owner)) return;

      const next = queue.dequeue(event.owner);
      ctx.events.publish({
        type: 'queue:changed',
        pendingInputs: queue.list(event.owner),
        owner: event.owner,
      });
      if (!next) return;
      await runtime.submit(next.text, { source: 'plugin', displayText: next.displayText });
    },
    { pluginId: ctx.pluginId, priority: 100 },
  );
  ctx.onDispose(() => turnAfterDisposable.dispose());
}
