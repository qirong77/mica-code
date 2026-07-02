import { createAgentsCommand } from './agents.js';
import { createClearCommand } from './clear.js';
import { createCommitCommand } from './commit.js';
import { createCompactCommand } from './compact.js';
import { createCopyCommand } from './copy.js';
import { createContextCommand } from './context.js';
import { createDoctorCommand } from './doctor.js';
import { createEffortCommand } from './effort.js';
import { createExitCommand } from './exit.js';
import { createForkCommand } from './fork.js';
import { createGitDiffContextCommand } from './gitDiffContext.js';
import { closeLogPanel, createLogCommand } from './log.js';
import { createMcpCommand } from './mcp.js';
import { createModelCommand } from './model.js';
import { createNewCommand } from './new.js';
import { createProviderCommand } from './provider.js';
import { createRecapCommand } from './recap.js';
import { createRenameCommand } from './rename.js';
import { createReviewCommand } from './review.js';
import { createResumeCommand } from './resume.js';
import { createRewindCommand } from './rewind.js';
import { createSkillsCommand } from './skills.js';
import { createStatusCommand } from './status.js';
import { syncConfigFromAgent } from './configSwitch.js';

export const micaBuiltinCommands = {
  createAgentsCommand,
  createClearCommand,
  createCommitCommand,
  createCompactCommand,
  createCopyCommand,
  createContextCommand,
  createDoctorCommand,
  createEffortCommand,
  createExitCommand,
  createForkCommand,
  createGitDiffContextCommand,
  createLogCommand,
  closeLogPanel,
  createMcpCommand,
  createModelCommand,
  createNewCommand,
  createProviderCommand,
  createRecapCommand,
  createRenameCommand,
  createReviewCommand,
  createResumeCommand,
  createRewindCommand,
  createSkillsCommand,
  createStatusCommand,
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
  RecapOptions,
  RecapResult,
  ResumeSessionResult,
  RunningAgentRecord,
  SessionSummary,
} from './services.js';
export type { RewindApplyResult, RewindFileChange, RewindPreviewResult } from '@packages/mica-runtime/index.js';
