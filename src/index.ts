import { MicaAgent } from './core/agent.js';
import { updateModelOptions } from './store/updateModelOptions.js';
import { initProvider } from './store/providerConfig.js';
import { api } from './store/config.js';
import { ErrorHandlerPlugin } from './plugins/agent/errorHandlerPlugin.js';
import { AutoCompactPlugin } from './plugins/agent/autoCompactPlugin.js';
import { MemoryPlugin, injectMemorySystemPrompt } from './plugins/memory/MemoryPlugin.js';
import { promptBuilder } from './prompts/index.js';
import {
  QuickCommandModelPlugin,
  QuickCommandEffortPlugin,
} from './plugins/quick-command/selectPlugin.js';
import { QuickCommandProviderPlugin } from './plugins/quick-command/providerPlugin.js';
import { BuiltinCommandsPlugin } from './plugins/quick-command/builtinCommandsPlugin.js';
import { QuickCommandResumePlugin } from './plugins/quick-command/resumePlugin.js';
import { QuickCommandRenamePlugin } from './plugins/quick-command/renamePlugin.js';
import { QuickCommandRewindPlugin } from './plugins/quick-command/rewindPlugin.js';
import { QuickCommandStarPlugin } from './plugins/quick-command/starPlugin.js';
import { QuickCommandCompactPlugin } from './plugins/quick-command/compactPlugin.js';
import { QuickCommandGitChangeContextPlugin } from './plugins/quick-command/gitChangeContextPlugin.js';
import { QuickCommitPlugin } from './plugins/custom/quickCommitPlugin.js';
import { QuickCommandInitPlugin } from './plugins/custom/quickCommandInitPlugin.js';
import { QuickCommandSkillsPlugin } from './plugins/custom/quickCommandSkillsPlugin.js';
import { QuickCommandMcpPlugin } from './plugins/mcp/quickCommandMcpPlugin.js';
import { DebugExportLogPlugin } from './plugins/debug/debugExportLogPlugin.js';
import { terminalInput } from './store/uiState.js';

const modelsUrl = initProvider();
await updateModelOptions(modelsUrl, api.apiKey.get() ?? '');

// 在注册任何插件之前注入记忆系统 prompt
injectMemorySystemPrompt(promptBuilder);

await MicaAgent.usePlugin(new QuickCommitPlugin());
await MicaAgent.usePlugin(new QuickCommandInitPlugin());
await MicaAgent.usePlugin(new QuickCommandSkillsPlugin());
await MicaAgent.usePlugin(new ErrorHandlerPlugin());
await MicaAgent.usePlugin(new AutoCompactPlugin());
await MicaAgent.usePlugin(new MemoryPlugin());
await MicaAgent.usePlugin(new BuiltinCommandsPlugin());
await MicaAgent.usePlugin(new QuickCommandProviderPlugin());
await MicaAgent.usePlugin(new QuickCommandModelPlugin());
await MicaAgent.usePlugin(new QuickCommandEffortPlugin());
await MicaAgent.usePlugin(new QuickCommandResumePlugin());
await MicaAgent.usePlugin(new QuickCommandRenamePlugin());
await MicaAgent.usePlugin(new QuickCommandRewindPlugin());
await MicaAgent.usePlugin(new QuickCommandStarPlugin());
await MicaAgent.usePlugin(new QuickCommandCompactPlugin());
await MicaAgent.usePlugin(new QuickCommandGitChangeContextPlugin());
await MicaAgent.usePlugin(new QuickCommandMcpPlugin());
await MicaAgent.usePlugin(new DebugExportLogPlugin());

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
