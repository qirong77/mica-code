import { micaUI } from '../../packages/mica-ui/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { registerClearPlugin } from './pluginClear.js';
import { registerProviderPlugin } from './pluginProvider.js';
import { registerModelPlugin } from './pluginModel.js';
import { registerEffortPlugin } from './pluginEffort.js';
import { registerStatusPlugin } from './pluginStatus.js';
import { registerMcpPlugin } from './pluginMcp.js';
import { registerResumePlugin } from './pluginResume.js';
import { registerSkillsPlugin } from './pluginSkills.js';
import { registerGitDiffContextPlugin } from './pluginGitDiffContext.js';
import { registerCommitPlugin } from './pluginCommit.js';
import { closeLogsPanel, registerLogsPlugin } from './pluginLogs.js';
import type { SessionController } from '../session/SessionController.js';
import { logRuntime } from '../logger.js';

export function registerCommands({
  agent,
  sessionController,
}: {
  agent: AgentRuntime;
  sessionController: SessionController;
}) {
  const commands = [
    registerClearPlugin(agent, sessionController),
    registerResumePlugin(agent, sessionController),
    registerProviderPlugin(agent),
    registerModelPlugin(agent),
    registerEffortPlugin(agent),
    registerStatusPlugin(agent),
    registerLogsPlugin(),
    registerMcpPlugin(),
    registerSkillsPlugin(),
    registerGitDiffContextPlugin(),
    registerCommitPlugin(agent),
  ];

  micaUI.dropdown.setQuickCommands(
    commands.map((command) => ({
      ...command,
      action: (arg?: string) => {
        if (command.name !== 'logs') closeLogsPanel();
        logRuntime('plugin', 'action:start', { name: command.name, arg });
        try {
          const result = command.action(arg);
          if (isPromiseLike(result)) {
            return result
              .then((value) => {
                logRuntime('plugin', 'action:done', { name: command.name });
                return value;
              })
              .catch((error) => {
                logRuntime('plugin', 'action:error', { name: command.name, error: formatError(error) }, 'error');
                throw error;
              });
          }
          logRuntime('plugin', 'action:done', { name: command.name });
          return result;
        } catch (error) {
          logRuntime('plugin', 'action:error', { name: command.name, error: formatError(error) }, 'error');
          throw error;
        }
      },
    })),
  );
  logRuntime('plugin', 'registered', { count: commands.length });
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === 'object' && value !== null && 'then' in value;
}
