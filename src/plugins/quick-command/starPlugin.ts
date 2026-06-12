import { MicaPlugin } from '../MicaPlugin.js';

export class QuickCommandStarPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'star',
      description: '收藏 / 取消收藏当前会话，收藏后 /resume 优先展示',
      action: () => {
        const currentId = this.atoms.currentSessionId.get();
        if (!currentId) {
          this.showMessage('没有活跃的会话');
          return;
        }
        const idx = this.atoms.sessionsIndex.get();
        const target = idx.find((s) => s.id === currentId);
        if (!target) {
          this.showMessage('当前会话未存储');
          return;
        }
        const newStarred = !target.starred;
        this.atoms.sessionsIndex.set(
          idx.map((s) => (s.id === currentId ? { ...s, starred: newStarred } : s)),
        );
        this.showMessage(newStarred ? '已收藏 ⭐️' : '已取消收藏');
      },
    });
  }
}
