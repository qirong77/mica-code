import { micaBuiltinCommands } from '@packages/mica-builtin-commands/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import { getActiveContext } from '../../app/activeContext.js';
import type { ApplicationContext } from '../../app/ApplicationContext.js';

export type BuiltInCommandItem = Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];

export function registerCommand(ctx: PluginContext, command: BuiltInCommandItem, options: { allowDuringTurn?: boolean } = {}): void {
  const disposable = ctx.commands.register({
    name: command.name,
    description: command.description,
    hidden: command.hidden,
    hiddenMenuParent: command.hiddenMenuParent,
    hiddenMenuItems: command.hiddenMenuItems,
    scope: 'local-only',
    allowDuringTurn: options.allowDuringTurn,
    pluginId: ctx.pluginId,
    async handler(_commandCtx, args) {
      if (command.name !== 'log') micaBuiltinCommands.closeLogPanel();
      micaLogger.logRuntime('plugin', 'action:start', { name: command.name, arg: args });
      try {
        await command.action(args || undefined);
        micaLogger.logRuntime('plugin', 'action:done', { name: command.name });
        return { ok: true };
      } catch (error) {
        micaLogger.logRuntime('plugin', 'action:error', { name: command.name, error: formatError(error) }, 'error');
        throw error;
      }
    },
  });
  ctx.onDispose(() => disposable.dispose());
  syncQuickCommands(ctx);
}

export function syncQuickCommands(ctx: PluginContext): void {
  micaUi.dropdown.setQuickCommands(
    ctx.commands.list().map((command) => ({
      name: command.name,
      description: command.description ?? '',
      hidden: command.hidden,
      hiddenMenuParent: command.hiddenMenuParent,
      hiddenMenuItems: command.hiddenMenuItems,
      action: (arg?: string) => {
        const text = `/${command.name}${arg ? ` ${arg}` : ''}`;
        const runtime = getActiveContext<ApplicationContext>()?.runtime;
        if (runtime) {
          void runtime.submit(text, { source: 'command' });
          return;
        }
        void ctx.commands.execute(text, {});
      },
    })),
  );
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
