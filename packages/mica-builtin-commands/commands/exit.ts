import type { BuiltInCommandItem } from '../commandHost.js';
import type { CommandRuntimeServices } from '../services.js';

export function createExitCommand(services: CommandRuntimeServices): BuiltInCommandItem {
  return {
    name: 'exit',
    description: '退出程序',
    async action() {
      await services.requestExit(0);
    },
  };
}
