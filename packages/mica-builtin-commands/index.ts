import { createClearCommand } from './commands/clear.js';
import { createCommitCommand } from './commands/commit.js';
import { createCompactCommand } from './commands/compact.js';
import { createConfigCommand } from './commands/config.js';
import { createContextCommand } from './commands/context.js';
import { createEffortCommand } from './commands/effort.js';
import { createDiffCommand } from './commands/diff.js';
import { createExitCommand } from './commands/exit.js';
import { createForkCommand } from './commands/fork.js';
import { createMcpCommand } from './commands/mcp.js';
import { createModelCommand } from './commands/model.js';
import { createNewCommand } from './commands/new.js';
import { createProviderCommand } from './commands/provider.js';
import { createRenameCommand } from './commands/rename.js';
import { createResumeCommand } from './commands/resume.js';
import { createRewindCommand } from './commands/rewind.js';
import { createRoleCommand, cycleNextRole } from './commands/role.js';
import { createSkillsCommand } from './commands/skills.js';
import { createStatusCommand } from './commands/status.js';
import { syncConfigFromAgent } from './shared/configSwitch.js';
import { createTaskCommand } from './commands/task.js';
import { AgentChangeTracker } from './git/agentChangeTracker.js';

export const micaBuiltinCommands = {
  cycleNextRole,
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
  SubagentTaskDetail,
  SubagentTaskOwner,
  SubagentTaskStatus,
  SubagentTaskSummary,
} from './services.js';
export type { RewindApplyResult, RewindFileChange, RewindPreviewResult } from '@packages/mica-runtime/index.js';
export { AgentChangeTracker } from './git/agentChangeTracker.js';
