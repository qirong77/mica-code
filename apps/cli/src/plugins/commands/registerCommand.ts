import type { PluginContext } from '@packages/mica-plugin/index.js';
import type { BuiltInCommandItem } from '@packages/mica-builtin-commands/commandHost.js';
import { micaUi } from '@packages/mica-ui/index.js';
import { getActiveContext } from '../../app/activeContext.js';
import type { ApplicationContext } from '../../app/ApplicationContext.js';

export function registerCommand(
  ctx: PluginContext,
  command: BuiltInCommandItem,
  options: { allowDuringTurn?: boolean } = {},
): void {
  const disposable = ctx.commands.register({
    name: command.name,
    description: command.description,
    completionItems: command.completionItems,
    scope: 'local-only',
    allowDuringTurn: options.allowDuringTurn,
    pluginId: ctx.pluginId,
    async handler(_commandCtx, args) {
      await command.action(args || undefined);
      return { ok: true };
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
      completionItems: command.completionItems,
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
