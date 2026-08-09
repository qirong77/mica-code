import { commandHostToken } from '../../packages/mica-builtin-commands/commandHost.js';

export default function setupCommandClear(ctx) {
  const host = ctx.services.get(commandHostToken);
  host.registerCommand(
    ctx,
    createClearCommand(host.agent, host.sessionController, host.services, () => {
      ctx.events.publish({ type: 'session:cleared', owner: host.agent });
    }),
  );
}

export function createClearCommand(agent, sessionController, services, onCleared) {
  return {
    name: 'clear',
    description: '新开一个空 session，不清除当前 session 内容',
    action() {
      if (services.isAgentBusy(agent)) {
        services.showNotice('Agent is busy; wait or abort before starting a new session', undefined, {
          command: '/clear',
          status: 'warning',
        });
        return;
      }
      services.clearSubagentTasks?.(agent);
      services.clearUI(agent, sessionController);
      onCleared?.();
      services.showNotice('Started new session', undefined, { command: '/clear', status: 'success' });
    },
  };
}
