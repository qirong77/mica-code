import { MicaPlugin } from '../MicaPlugin';
import { api, model } from '../../store/config.js';

export class QuickCommandStatusPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'status',
      description: '显示当前状态（模型、API 配置等）',
      action: () => {
        const currentModel = this.atoms.model.get();
        const currentEffort = this.atoms.effort.get();
        const maxTokens = model.maxTokens.get();
        const contextWindow = model.conextWindowSize.get();
        const baseUrl = api.baseUrl.get();
        const apiKey = api.apiKey.get();
        const modelOptions = this.atoms.modelOptions.get();
        const effortOptions = this.atoms.effortOptions.get();
        const messages = this.atoms.messages.get();
        const sessionId = this.atoms.currentSessionId.get();

        const currentModelLabel = modelOptions.find(m => m.name === currentModel)?.label ?? currentModel;
        const currentEffortLabel = effortOptions.find(e => e.name === currentEffort)?.label ?? currentEffort;

        const lines = [
          `Model: ${currentModelLabel} (${currentModel})`,
          `Effort: ${currentEffortLabel} (${currentEffort})`,
          `Max Tokens: ${maxTokens}`,
          `Context Window: ${contextWindow}`,
          `Base URL: ${baseUrl || '(not set)'}`,
          `API Key: ${apiKey || '(not set)'}`,
          `Session ID: ${sessionId}`,
          `Messages: ${messages.length}`,
        ];

        this.showMessage(lines.join('\n'), 5000);
      },
    });
  }
}
