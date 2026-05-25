import { MicaPlugin } from '../MicaPlugin';
import { terminalInput } from '../../store/ui-state.js';

export class QuickCommandRenamePlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'rename',
      description: 'Rename the current conversation',
      action: () => {
        const currentId = this.atoms.currentSessionId.get();
        if (!currentId) {
          this.showMessage('没有活跃的会话');
          return;
        }

        const input = terminalInput.text.get();
        const newTitle = input.slice('/rename'.length).trim();

        if (!newTitle) {
          this.showMessage('用法: /rename 新标题');
          return;
        }

        const idx = this.atoms.sessionsIndex.get();
        const updated = idx.map((s) =>
          s.id === currentId ? { ...s, title: newTitle, updatedAt: Date.now() } : s
        );
        this.atoms.sessionsIndex.set(updated);
        this.showMessage(`已重命名为: ${newTitle}`);
      },
    });
  }
}
