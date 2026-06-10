import { MicaPlugin } from '../MicaPlugin';

export class QuickCommandDebugPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'debug',
      description: '调试工具（导出会话）',
      action: () => {
        this.agent.ui.DropDown.quickCommand.show('debug-', true);
      },
    });
  }
}
