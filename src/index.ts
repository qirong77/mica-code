
import { MicaAgent } from './core/agent.js';
import { fetchModelOptions } from './store/config.js';
import { ErrorHandlerPlugin } from './plugins/agent/error-handler-plugin.js';
import { AutoCompactPlugin } from './plugins/agent/auto-compact-plugin.js';
import { QuickCommandModelPlugin } from './plugins/quick-command/quick-command-model-plugin.js';
import { QuickCommandEffortPlugin } from './plugins/quick-command/quick-command-effort-plugin.js';
import { QuickCommandResumePlugin } from './plugins/quick-command/quick-command-resume-plugin.js';
import { QuickCommandRenamePlugin } from './plugins/quick-command/quick-command-rename-plugin.js';
import { QuickCommandExitPlugin } from './plugins/quick-command/quick-command-exit-plugin.js';
import { QuickCommandRewindPlugin } from './plugins/quick-command/quick-command-rewind-plugin.js';
import { QuickCommandClearPlugin } from './plugins/quick-command/quick-command-clear-plugin.js';
import { QuickCommandLogPlugin } from './plugins/debug/quick-command-log-plugin.js';
import { QuickCommandStatusPlugin } from './plugins/debug/quick-command-status.js';
import { QuickCommandDebugPlugin } from './plugins/debug/quick-command-debug.js';
import { QuickCommandLogTogglePlugin } from './plugins/debug/quick-command-log-toggle.js';
import { QuickBashPlugin } from './plugins/custom/quick-bash-plugin.js';
import { QuickCommandInitPlugin } from './plugins/custom/quick-command-init-plugin.js';
import { QuickCommandSkillsPlugin } from './plugins/custom/quick-command-skills-plugin.js';
import { QuickCommandMcpPlugin } from './plugins/mcp/quick-command-mcp-plugin.js';
import { terminalInput } from './store/ui-state.js';

await fetchModelOptions();

await MicaAgent.usePlugin(new QuickBashPlugin());
await MicaAgent.usePlugin(new QuickCommandInitPlugin());
await MicaAgent.usePlugin(new QuickCommandSkillsPlugin());
await MicaAgent.usePlugin(new ErrorHandlerPlugin());
await MicaAgent.usePlugin(new AutoCompactPlugin());
await MicaAgent.usePlugin(new QuickCommandDebugPlugin());
await MicaAgent.usePlugin(new QuickCommandLogTogglePlugin());
await MicaAgent.usePlugin(new QuickCommandLogPlugin());
await MicaAgent.usePlugin(new QuickCommandStatusPlugin());
await MicaAgent.usePlugin(new QuickCommandModelPlugin());
await MicaAgent.usePlugin(new QuickCommandEffortPlugin());
await MicaAgent.usePlugin(new QuickCommandResumePlugin());
await MicaAgent.usePlugin(new QuickCommandRenamePlugin());
await MicaAgent.usePlugin(new QuickCommandExitPlugin());
await MicaAgent.usePlugin(new QuickCommandRewindPlugin());
await MicaAgent.usePlugin(new QuickCommandClearPlugin());
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
