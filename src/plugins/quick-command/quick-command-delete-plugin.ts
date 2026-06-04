import { MicaPlugin } from '../MicaPlugin';

export class QuickCommandDeletePlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'delete',
      description: '删除当前会话（不保留记录）',
      action: () => {
        const currentId = this.atoms.currentSessionId.get();
        if (currentId) {
          const sessions = this.atoms.sessionsIndex.get();
          this.atoms.sessionsIndex.set(sessions.filter((s) => s.id !== currentId));
        }
        this.agent.agentTurn.session.replaceMessages([]);
        this.atoms.currentSessionId.set('');
        this.showMessage('会话已删除');
      },
    });
  }
}
