import { createCommitCommand } from './commands/commit.js';
import { createConfigCommand } from './commands/config.js';
import { createContextCommand } from './commands/context.js';
import { createEffortCommand } from './commands/effort.js';
import { createLoopCommand } from './commands/loop.js';
import { createMcpCommand } from './commands/mcp.js';
import { createModelCommand } from './commands/model.js';
import { createRoleCommand, cycleNextRole } from './commands/role.js';
import { createSkillsCommand } from './commands/skills.js';
import { createStatusCommand } from './commands/status.js';
import { syncConfigFromAgent } from './shared/configSwitch.js';
import { createTaskCommand } from './commands/task.js';
import { AgentChangeTracker } from './git/agentChangeTracker.js';

export const micaBuiltinCommands = {
  cycleNextRole,
  createCommitCommand,
  createConfigCommand,
  createContextCommand,
  createEffortCommand,
  createLoopCommand,
  createMcpCommand,
  createModelCommand,
  createRoleCommand,
  createSkillsCommand,
  createStatusCommand,
  createTaskCommand,
  AgentChangeTracker,
  syncConfigFromAgent,
};

export { createLoopCommand, formatDuration, LoopController, parseDuration, parseLoopArgs } from './commands/loop.js';
export type { LoopParseResult, LoopStartParams, LoopState } from './commands/loop.js';

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
export {
  buildChangeSummary,
  commitWithMessage,
  generateCommitMessage,
  hasUnmergedFiles,
  pushCurrentBranch,
} from './git/commitRunner.js';
export type { CommitMessageAgent } from './git/commitRunner.js';
export { commandHostToken } from './commandHost.js';
export type { BuiltInCommandItem, CommandHostService } from './commandHost.js';
