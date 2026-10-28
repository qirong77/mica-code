import { createCapabilitiesCommand } from './commands/capabilities.js';
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

export const micaBuiltinCommands = {
  cycleNextRole,
  createCapabilitiesCommand,
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
  syncConfigFromAgent,
};

export {
  createLoopCommand,
  DEFAULT_LOOP_INTERVAL_MS,
  formatDuration,
  LoopController,
  MIN_LOOP_INTERVAL_MS,
  parseDuration,
  parseLoopArgs,
} from './commands/loop.js';
export type { LoopParseResult, LoopStartParams, LoopState } from './commands/loop.js';
export { ToolLoopSetInterval, ToolLoopSetTask, ToolLoopStatus, ToolLoopStop } from './commands/loop.js';
export type { LoopToolDeps } from './commands/loop.js';
export { collectRecentCwds, createCdCommand } from './commands/cd.js';
export { createClearCommand } from './commands/clear.js';
export { createCompactCommand } from './commands/compact.js';
export { createExitCommand } from './commands/exit.js';
export { createForkCommand } from './commands/fork.js';
export { createNewCommand } from './commands/new.js';
export { createRenameCommand } from './commands/rename.js';
export { createResumeCommand, formatResumeSessionTitle } from './commands/resume.js';
export { createRewindCommand, rewindCheckpointCells } from './commands/rewind.js';
// btw 的纯逻辑单独成文件：headless 的 btw 面板（app-server）与官方插件 `btw`
// 各自按需从这个子路径取，见那里的说明（插件不能经本入口，那会把 Ink 拖进去）。
export { buildBtwSystemPrompt, createBtwThread, messagesToTranscript } from './shared/btwThread.js';
export type { BtwPromptContext, BtwRoleContext, BtwSubagent, BtwThread } from './shared/btwThread.js';

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
export { commandHostToken } from './commandHost.js';
export type { BuiltInCommandItem, CommandHostService } from './commandHost.js';
export { recordHelperSubagentUsage } from './subagentUsage.js';

// 运行期插件（apps/cli 的 builtinPlugins.ts 与 HeadlessPluginHost.ts 从本入口导入）
export { default as setupCommandCd } from './plugins/command-cd.js';
export { default as setupCommandClear } from './plugins/command-clear.js';
export { default as setupCommandCompact } from './plugins/command-compact.js';
export { default as setupCommandExit } from './plugins/command-exit.js';
export { default as setupCommandFork } from './plugins/command-fork.js';
export { default as setupCommandNew } from './plugins/command-new.js';
export { default as setupCommandRename } from './plugins/command-rename.js';
export { default as setupCommandResume } from './plugins/command-resume.js';
export { default as setupCommandRewind } from './plugins/command-rewind.js';
export { default as setupCommandMemory } from './plugins/command-memory.js';
export { default as setupLoop } from './plugins/loop.js';
export { default as setupMcp } from './plugins/mcp.js';
export { default as setupMessageQueue } from './plugins/message-queue.js';
export { default as setupFileMention } from './plugins/file-mention.js';
export { default as setupMicaCodeAppNotify } from './plugins/mica-code-app-notify.js';
export { default as setupSessionAutonomy } from './plugins/session-autonomy/SessionAutonomyPlugin.js';

// 启动扩展（不走 PluginManager，由各进程入口直接装配）
export { default as setupValidateConfig } from './startup/validate-config.js';
export {
  applyConfigDefaultsToFile,
  assertValidConfig,
  ConfigValidationError,
  DEFAULT_PROVIDER_PROTOCOL,
  formatConfigValidationIssues,
  PROVIDER_PROTOCOLS,
  validateConfig,
  validateConfigFile,
  validateConfigText,
} from './startup/validate-config.js';
export type { ConfigChange, ConfigIssue, ConfigValidationResult } from './startup/validate-config.js';
export { default as setupProcessDiagnostics } from './startup/process-diagnostics.js';
export { default as setupFilePlugins, writeFilePluginStatus } from './startup/file-plugins.js';
export { default as setupModelEffortContext } from './startup/model-effort-context/index.js';
export {
  __resetModelsCacheForTests,
  getModelRule as getModelsDevRule,
} from './startup/model-effort-context/getModelRule.js';
