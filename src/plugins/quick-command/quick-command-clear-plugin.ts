import { MicaPlugin } from '../MicaPlugin';

export class QuickCommandClearPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'clear',
      description: '开始新会话（旧会话可通过 /resume 恢复）',
      action: () => {
        this.agent.agentTurn.session.replaceMessages([]);
        this.atoms.currentSessionId.set('');
        this.showMessage('已开启新会话，旧会话已保存');
      },
    });
  }
}
