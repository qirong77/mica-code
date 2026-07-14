import { createClearCommand } from './clear.js';
import { createCommitCommand } from './commit.js';
import { createCompactCommand } from './compact.js';
import { createConfigCommand } from './config.js';
import { createContextCommand } from './context.js';
import { createEffortCommand } from './effort.js';
import { createDiffCommand } from './diff.js';
import { createExitCommand } from './exit.js';
import { createForkCommand } from './fork.js';
import { createMcpCommand } from './mcp.js';
import { createModelCommand } from './model.js';
import { createNewCommand } from './new.js';
import { createProviderCommand } from './provider.js';
import { createRenameCommand } from './rename.js';
import { createResumeCommand } from './resume.js';
import { createRewindCommand } from './rewind.js';
import { createRoleCommand } from './role.js';
import { createSkillsCommand } from './skills.js';
import { createStatusCommand } from './status.js';
import { syncConfigFromAgent } from './configSwitch.js';
import { createTaskCommand } from './task.js';
import { AgentChangeTracker } from './agentChangeTracker.js';

export const micaBuiltinCommands = {
  createClearCommand,
  createCommitCommand,
  createCompactCommand,
  createConfigCommand,
  createContextCommand,
  createEffortCommand,
  createDiffCommand,
  createExitCommand,
  createForkCommand,
  createMcpCommand,
  createModelCommand,
  createNewCommand,
  createProviderCommand,
  createRenameCommand,
  createResumeCommand,
  createRewindCommand,
  createRoleCommand,
  createSkillsCommand,
  createStatusCommand,
  createTaskCommand,
  AgentChangeTracker,
  syncConfigFromAgent,
};

export type {
  ClearIdleAgentsResult,
  CommandAgent,
  CommandNoticeOptions,
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
export { AgentChangeTracker } from './agentChangeTracker.js';
