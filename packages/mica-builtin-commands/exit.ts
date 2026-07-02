import { micaLogger } from '@packages/mica-logger/index.js';

export function createExitCommand() {
  return {
    name: 'exit',
    description: '退出程序',
    action: () => {
      micaLogger.logRuntime('plugin.exit', 'requested');
      process.exit(0);
    },
  } satisfies Parameters<typeof import('@packages/mica-ui/index.js').micaUi.dropdown.setQuickCommands>[0][number];
}
