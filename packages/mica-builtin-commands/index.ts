import { createAgentsCommand } from './agents.js';
import { createClearCommand } from './clear.js';
import { createCommitCommand } from './commit.js';
import { createCompactCommand } from './compact.js';
import { createEffortCommand } from './effort.js';
import { createGitDiffContextCommand } from './gitDiffContext.js';
import { createLogExportCommand } from './logExport.js';
import { closeLogsPanel, createLogsCommand } from './logs.js';
import { createMcpCommand } from './mcp.js';
import { createModelCommand } from './model.js';
import { createNewCommand } from './new.js';
import { createProviderCommand } from './provider.js';
import { createResumeCommand } from './resume.js';
import { createSkillsCommand } from './skills.js';
import { createStatusCommand } from './status.js';

export const micaBuiltinCommands = {
  createAgentsCommand,
  createClearCommand,
  createCommitCommand,
  createCompactCommand,
  createEffortCommand,
  createGitDiffContextCommand,
  createLogExportCommand,
  createLogsCommand,
  closeLogsPanel,
  createMcpCommand,
  createModelCommand,
  createNewCommand,
  createProviderCommand,
  createResumeCommand,
  createSkillsCommand,
  createStatusCommand,
};

export type {
  CommandAgent,
  CommandRuntimeServices,
  CommandSessionController,
  ResumeSessionResult,
  RunningAgentRecord,
  SessionSummary,
} from './services.js';
