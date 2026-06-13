import { UIPanelPlugin } from '../MicaPlugin.js';
import { createSelectCommand } from './selectPlugin.js';
import {
  getProviderList,
  getCurrentProvider,
  switchProvider,
  PROVIDER_PATH,
} from '../../store/providerConfig.js';

export class QuickCommandProviderPlugin extends UIPanelPlugin {
  onInstall(): void {
    this.addQuickCommand(
      createSelectCommand(this, {
        name: 'provider',
        description: '切换 AI 服务提供商',
        title: `select provider ( ${PROVIDER_PATH} )`,
        getCurrent: () => getCurrentProvider(),
        getOptions: () => getProviderList(),
        onSelect: async (v) => {
          const { error, provider } = await switchProvider(v);
          if (error) {
            this.showMessage(error);
          } else {
            this.showMessage(`已切换到 ${provider?.name ?? v}`);
          }
        },
      }),
    );
  }
}
