
import type { CommandRuntimeServices } from './services.js';

export function createExitCommand(services: CommandRuntimeServices) {
  return {
    name: 'exit',
    description: '退出程序',
    action: async () => {
      await services.requestExit(0);
    },
  } satisfies Parameters<typeof import('@packages/mica-ui/index.js').micaUi.dropdown.setQuickCommands>[0][number];
}
