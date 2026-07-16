import { basename } from 'node:path';
import { micaUi } from '@packages/mica-ui/index.js';
import type { CommandRuntimeServices, CommandSessionController, SessionSummary } from '../services.js';
import { showSelectCommand } from '../shared/selectCommand.js';

const RECENT_SESSION_LIMIT = 300;

export function createCdCommand(sessionController: CommandSessionController, services: CommandRuntimeServices) {
  return {
    name: 'cd',
    description: '切换到最近 session 使用过的工作目录',
    action: () => {
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
  } satisfies Parameters<typeof micaUi.dropdown.setQuickCommands>[0][number];
}

export function collectRecentCwds(sessions: Pick<SessionSummary, 'cwd'>[]): string[] {
  return [...new Set(sessions.map((session) => session.cwd).filter(Boolean))];
}

function changeWorkingDirectory(cwd: string, services: CommandRuntimeServices): boolean {
  try {
    process.chdir(cwd);
    services.showMessage(`Working directory: ${process.cwd()}`, 4000);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    services.showMessage(`Unable to change working directory: ${message}`, 6000);
    return false;
  }
}
