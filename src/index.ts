import { MicaAgent } from './core/agent.js';
import { updateModelOptions } from './store/updateModelOptions.js';
import { ErrorHandlerPlugin } from './plugins/agent/error-handler-plugin.js';
import { AutoCompactPlugin } from './plugins/agent/auto-compact-plugin.js';
import { MemoryPlugin, injectMemorySystemPrompt } from './plugins/memory/MemoryPlugin.js';
import { promptBuilder } from './prompts/index.js';
import {
  QuickCommandModelPlugin,
  QuickCommandEffortPlugin,
} from './plugins/quick-command/quick-command-select-plugin.js';
import { BuiltinCommandsPlugin } from './plugins/quick-command/builtin-commands-plugin.js';
import { QuickCommandResumePlugin } from './plugins/quick-command/quick-command-resume-plugin.js';
import { QuickCommandRenamePlugin } from './plugins/quick-command/quick-command-rename-plugin.js';
import { QuickCommandRewindPlugin } from './plugins/quick-command/quick-command-rewind-plugin.js';
import { QuickCommandStarPlugin } from './plugins/quick-command/quick-command-star-plugin.js';
import { QuickCommandDeletePlugin } from './plugins/quick-command/quick-command-delete-plugin.js';
import { QuickCommandCompactPlugin } from './plugins/quick-command/quick-command-compact-plugin.js';
import { QuickCommandGitChangeContextPlugin } from './plugins/quick-command/quick-command-git-change-context-plugin.js';
import { QuickCommitPlugin } from './plugins/custom/quick-commit-plugin.js';
import { QuickCommandInitPlugin } from './plugins/custom/quick-command-init-plugin.js';
import { QuickCommandSkillsPlugin } from './plugins/custom/quick-command-skills-plugin.js';
import { QuickCommandMcpPlugin } from './plugins/mcp/quick-command-mcp-plugin.js';
import { terminalInput } from './store/ui-state.js';

await updateModelOptions();

// 在注册任何插件之前注入记忆系统 prompt
injectMemorySystemPrompt(promptBuilder);

await MicaAgent.usePlugin(new QuickCommitPlugin());
await MicaAgent.usePlugin(new QuickCommandInitPlugin());
await MicaAgent.usePlugin(new QuickCommandSkillsPlugin());
await MicaAgent.usePlugin(new ErrorHandlerPlugin());
await MicaAgent.usePlugin(new AutoCompactPlugin());
await MicaAgent.usePlugin(new MemoryPlugin());
await MicaAgent.usePlugin(new BuiltinCommandsPlugin());
await MicaAgent.usePlugin(new QuickCommandModelPlugin());
await MicaAgent.usePlugin(new QuickCommandEffortPlugin());
await MicaAgent.usePlugin(new QuickCommandResumePlugin());
await MicaAgent.usePlugin(new QuickCommandRenamePlugin());
await MicaAgent.usePlugin(new QuickCommandRewindPlugin());
await MicaAgent.usePlugin(new QuickCommandStarPlugin());
await MicaAgent.usePlugin(new QuickCommandDeletePlugin());
await MicaAgent.usePlugin(new QuickCommandCompactPlugin());
await MicaAgent.usePlugin(new QuickCommandGitChangeContextPlugin());
await MicaAgent.usePlugin(new QuickCommandMcpPlugin());

const printPrompt = getPrintPrompt();
if (printPrompt) {
  terminalInput.disabled.set(true);
}

MicaAgent.run();

if (printPrompt) {
  MicaAgent.ui.TerminalInput.submit(printPrompt);
}

function getPrintPrompt(): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-p' || args[i] === '--print') {
      const prompt = args[i + 1];
      if (!prompt) {
        process.stderr.write('Usage: mica -p "your prompt"\n');
        process.exit(1);
      }
      return prompt;
    }
  }
}
