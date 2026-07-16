import { commandHostToken } from '../packages/mica-builtin-commands/commandHost.js';

export default function setupCommandClear(ctx) {
  const host = ctx.services.get(commandHostToken);
  host.registerCommand(ctx, createClearCommand(host.agent, host.sessionController, host.services));
}

export function createClearCommand(agent, sessionController, services) {
  return {
    name: 'clear',
    description: '新开一个空 session，不清除当前 session 内容',
    action() {
      if (services.isAgentBusy(agent)) {
        services.showMessage('Agent is busy; wait or abort before starting a new session');
        return;
      }
      services.clearUI(agent, sessionController);
      services.showMessage('Started new session');
    },
  };
}
