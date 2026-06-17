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
import type { SessionController } from '../session/SessionController.js';

export function registerCommands({
  agent,
  sessionController,
}: {
  agent: AgentRuntime;
  sessionController: SessionController;
}) {
  micaUI.dropdown.setQuickCommands([
    registerClearPlugin(agent, sessionController),
    registerResumePlugin(agent, sessionController),
    registerProviderPlugin(agent),
    registerModelPlugin(agent),
    registerEffortPlugin(agent),
    registerStatusPlugin(agent),
    registerMcpPlugin(),
    registerSkillsPlugin(),
    registerGitDiffContextPlugin(),
    registerCommitPlugin(agent),
  ]);
}
