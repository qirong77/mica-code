import { micaAgent } from '@packages/mica-agent/index.js';
import { buildConfigWebConversationDetails, startConfigWeb } from '@packages/mica-config-web/index.js';
import type { CommandAgent, CommandRuntimeServices } from './services.js';

export function createConfigCommand(agent: CommandAgent, services: CommandRuntimeServices) {
  return {
    name: 'config',
    description: '打开 Mica 配置页面',
    action: async () => {
      const snapshot = agent.getSnapshot();
      const server = await startConfigWeb(
        buildConfigWebConversationDetails({
          providerId: snapshot.providerId,
          protocol: agent.config.provider.protocol,
          model: snapshot.model,
          systemPrompt: micaAgent.buildSystemPrompt(),
          messages: snapshot.messages,
        }),
      );
      services.showNotice(`Config UI: [${server.url}](${server.url})`, services.getCurrentAgentSessionId(), {
        variant: 'config',
        command: '/config',
      });
    },
  };
}
