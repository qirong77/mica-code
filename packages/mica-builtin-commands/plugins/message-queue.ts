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

      return { action: 'handled' as const, reason: 'queued' };
    },
    { pluginId: ctx.pluginId, priority: -100 },
  );
  ctx.onDispose(() => inputDisposable.dispose());

  const turnAfterDisposable = ctx.hooks.on<RuntimeTurnAfterHookEvent>(
    'turn:after',
    async (event) => {
      if (queue.isBusy(event.owner)) return;
      // Only auto-deliver after a successfully completed turn. When the turn
      // failed or was aborted, keep the queued input pending so the user can
      // still retract it (shift + left to re-edit); the next completed turn
      // delivers it. Auto-firing right after a failed/aborted turn steals the
      // retract window and can cascade provider failures (loop turns with a
      // flaky provider are a common hit).
      if (event.outcome !== 'completed') return;

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
