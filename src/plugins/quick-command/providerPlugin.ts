import { UIPanelPlugin } from '../MicaPlugin.js';
import { createSelectCommand } from './selectPlugin.js';
import {
  getProviderList,
  getCurrentProvider,
  switchProvider,
} from '../../store/providerConfig.js';

export class QuickCommandProviderPlugin extends UIPanelPlugin {
  onInstall(): void {
    this.addQuickCommand(
      createSelectCommand(this, {
        name: 'provider',
        description: '切换 AI 服务提供商',
        title: 'select provider ( ~/.mica/config.json )',
        getCurrent: () => getCurrentProvider(),
        getOptions: () => getProviderList(),
        onSelect: async (v) => {
          const { error, provider, modelOptionsError } = await switchProvider(v);
          if (error) {
            this.showMessage(error);
          } else if (modelOptionsError) {
            this.showMessage(`已切换到 ${provider?.name ?? v}，但${modelOptionsError}`, 5000);
          } else {
            this.showMessage(`已切换到 ${provider?.name ?? v}`);
          }
        },
      }),
    );
  }
}
