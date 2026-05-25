import { MicaPlugin } from '../MicaPlugin';

export class QuickCommandExitPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'exit',
      description: '退出程序',
      action: () => {
        process.exit(0);
      },
    });
  }
}
