import { micaUI } from '../../packages/mica-ui/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { registerClearPlugin } from './clear.js';
import { registerProviderPlugin } from './provider.js';
import { registerModelPlugin } from './model.js';
import { registerEffortPlugin } from './effort.js';
import { registerStatusPlugin } from './status.js';
import { registerMcpPlugin } from './mcp.js';
import { registerResumePlugin } from './resume.js';
import { registerSkillsPlugin } from './skills.js';
import { registerGitDiffContextPlugin } from './gitDiffContext.js';
import { registerCommitPlugin } from './commit.js';
import { registerLogExportPlugin } from './logExport.js';
import { registerAgentsPlugin } from './agents.js';
import { closeLogsPanel, registerLogsPlugin } from './logs.js';
import type { SessionController } from '../session/SessionController.js';
import { logRuntime } from '../../packages/mica-logger/index.js';

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
    registerLogExportPlugin(agent, sessionController),
    registerAgentsPlugin(),
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
