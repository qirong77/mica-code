import type { CommandRuntimeServices } from './services.js';
import { micaLogger } from '@packages/mica-logger/index.js';

export function createExitCommand(services: CommandRuntimeServices) {
  return {
    name: 'exit',
    description: '退出程序',
    action: () => {
      micaLogger.logRuntime('plugin.exit', 'requested');
      services.requestExit();
    },
  } satisfies Parameters<typeof import('@packages/mica-ui/index.js').micaUi.dropdown.setQuickCommands>[0][number];
}
