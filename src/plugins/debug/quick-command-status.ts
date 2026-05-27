import { MicaPlugin } from '../MicaPlugin';
import { getContextUsage, getTotalBilledTokens } from '../../utils/getContextUsage';

export class QuickCommandStatusPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'debug-status',
      description: '显示当前状态（模型、API 配置等）',
      hidden: true,
      action: () => {
        const currentModel = this.atoms.model.get();
        const currentEffort = this.atoms.effort.get();
        const maxTokens = this.atoms.maxTokens.get();
        const contextWindow = this.atoms.contextWindowSize.get();
        const baseUrl = this.atoms.apiBaseUrl.get();
        const apiKey = this.atoms.apiKey.get();
        const modelOptions = this.atoms.modelOptions.get();
        const effortOptions = this.atoms.effortOptions.get();
        const messages = this.atoms.messages.get();
        const sessionId = this.atoms.currentSessionId.get();

        const currentModelLabel = modelOptions.find(m => m.name === currentModel)?.label ?? currentModel;
        const currentEffortLabel = effortOptions.find(e => e.name === currentEffort)?.label ?? currentEffort;

        const entries: [string, string][] = [
          ['Model', `${currentModelLabel} (${currentModel})`],
          ['Effort', `${currentEffortLabel} (${currentEffort})`],
          ['Max Tokens', `${maxTokens}`],
          ['Context Window', `${contextWindow}`],
          ['Context Usage', `${getContextUsage(messages)} tokens`],
          ['Base URL', baseUrl || '(not set)'],
          ['API Key', apiKey || '(not set)'],
          ['Session ID', `${sessionId}`],
          ['Messages', `${messages.length}`],
          ['Total Billed Tokens', `${getTotalBilledTokens(messages)}`],
        ];

        const maxLabelWidth = Math.max(...entries.map(([label]) => label.length));

        this.showMessage(
          entries.map(([label, value]) => `${label.padEnd(maxLabelWidth)} : ${value}`).join('\n'),
          0,
        );
      },
    });
  }
}
