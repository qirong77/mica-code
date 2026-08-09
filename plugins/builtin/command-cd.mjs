import { basename } from 'node:path';
import { commandHostToken } from '../../packages/mica-builtin-commands/commandHost.js';
import { showSelectCommand } from '../../packages/mica-builtin-commands/shared/selectCommand.js';

const RECENT_SESSION_LIMIT = 300;

export default function setupCommandCd(ctx) {
  const host = ctx.services.get(commandHostToken);
  host.registerCommand(ctx, createCdCommand(host.sessionController, host.services));
}

export function createCdCommand(sessionController, services) {
  return {
    name: 'cd',
    description: '切换到最近 session 使用过的工作目录',
    action() {
      const current = process.cwd();
      const directories = collectRecentCwds(sessionController.listRecent(RECENT_SESSION_LIMIT));

      showSelectCommand({
        id: 'select-cwd',
        title: `select working directory (${directories.length})`,
        current,
        options: directories.map((cwd) => ({
          name: cwd,
          label: basename(cwd) || cwd,
          description: cwd,
          searchField: cwd,
        })),
        emptyMessage: 'no working directories in recent sessions',
        itemGap: 0,
        filterable: true,
        onSelect: (cwd) => changeWorkingDirectory(cwd, services),
      });
    },
  };
}

export function collectRecentCwds(sessions) {
  return [...new Set(sessions.map((session) => session.cwd).filter(Boolean))];
}

function changeWorkingDirectory(cwd, services) {
  try {
    process.chdir(cwd);
    services.showNotice(`Working directory: ${process.cwd()}`, undefined, { command: '/cd', status: 'success' });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.showNotice(`Unable to change working directory: ${message}`, undefined, {
      command: '/cd',
      status: 'error',
    });
    return false;
  }
}
