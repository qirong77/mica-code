import type { CommandRuntimeServices } from '../services.js';

export function createConfigCommand(_agent: unknown, services: CommandRuntimeServices) {
  return {
    name: 'config',
    description: '打开 Mica 配置页面',
    action: async () => {
      if (!services.startConfigWeb) throw new Error('Config Web service is unavailable');
      const server = await services.startConfigWeb();
      services.showNotice(`Config UI: [${server.url}](${server.url})`, services.getCurrentAgentSessionId(), {
        variant: 'config',
        command: '/config',
      });
    },
  };
}
