import { createAgentsCommand } from './agents.js';
import { createClearCommand } from './clear.js';
import { createCommitCommand } from './commit.js';
import { createCompactCommand } from './compact.js';
import { createEffortCommand } from './effort.js';
import { createForkCommand } from './fork.js';
import { createGitDiffContextCommand } from './gitDiffContext.js';
import { closeLogPanel, createLogCommand } from './log.js';
import { createMcpCommand } from './mcp.js';
import { createModelCommand } from './model.js';
import { createNewCommand } from './new.js';
import { createProviderCommand } from './provider.js';
import { createResumeCommand } from './resume.js';
import { createRewindCommand } from './rewind.js';
import { createSkillsCommand } from './skills.js';
import { createStatusCommand } from './status.js';

export const micaBuiltinCommands = {
  createAgentsCommand,
  createClearCommand,
  createCommitCommand,
  createCompactCommand,
  createEffortCommand,
  createForkCommand,
  createGitDiffContextCommand,
  createLogCommand,
  closeLogPanel,
  createMcpCommand,
  createModelCommand,
  createNewCommand,
  createProviderCommand,
  createResumeCommand,
  createRewindCommand,
  createSkillsCommand,
  createStatusCommand,
};

export type {
  ClearIdleAgentsResult,
  CommandAgent,
  CommandRuntimeServices,
  CommandSessionController,
  ExclusiveTaskOptions,
  ForkAgentResult,
  PluginStatusOptions,
  ResumeSessionResult,
  RunningAgentRecord,
  SessionSummary,
} from './services.js';
export type { RewindApplyResult, RewindFileChange, RewindPreviewResult } from '@packages/mica-runtime/index.js';
