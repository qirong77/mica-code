import { execSync } from 'node:child_process';
import { MicaPlugin } from '../MicaPlugin';

export class QuickCommandRewindPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'rewind',
      description: '回退最近一轮对话及代码改动',
      action: () => {
        this._showConfirmation();
      },
    });
  }

  private _showConfirmation() {
    const msgs = this.messages;
    const cutoff = this._findLastUserMessageIndex(msgs);

    if (cutoff === -1) {
      this.showMessage('没有可回退的对话');
      return;
    }

    const removedCount = msgs.length - cutoff;

    let hasFileChanges = false;
    try {
      const diff = execSync('git diff --name-only', { encoding: 'utf-8', cwd: process.cwd() });
      hasFileChanges = diff.trim().length > 0;
    } catch {}

    const detailParts: string[] = [`将移除 ${removedCount} 条消息`];
    if (hasFileChanges) detailParts.push('并回退工作区代码改动');

    this.agent.ui.DropDown.atomData.dropdown.set({
      visible: true,
      items: [
        { key: 'confirm', label: '确认回退' },
        { key: 'cancel', label: '取消' },
      ],
      selectedIndex: 0,
      title: `rewind: ${detailParts.join('，')}`,
      emptyMessage: '',
    });

    const handler = (item: any) => {
      this.agent.ui.DropDown.emitter.off('select', handler);
      if (!item || item.key === 'cancel') {
        this.showMessage('已取消');
        return;
      }
      this._doRewind(msgs, cutoff, hasFileChanges);
    };
    this.agent.ui.DropDown.emitter.on('select', handler);
  }

  private _doRewind(
    originalMsgs: readonly any[],
    cutoff: number,
    hasFileChanges: boolean,
  ) {
    const rewinded = originalMsgs.slice(0, cutoff);
    this.atoms.messages.set(rewinded);

    if (hasFileChanges) {
      try {
        execSync('git checkout -- .', { encoding: 'utf-8', cwd: process.cwd() });
        execSync('git clean -fd', { encoding: 'utf-8', cwd: process.cwd() });
      } catch {
        this.showMessage('回退消息成功，但代码回退失败');
        return;
      }
    }

    this.showMessage(`已回退最近一轮对话${hasFileChanges ? '及代码改动' : ''}`);
  }

  private _findLastUserMessageIndex(msgs: readonly any[]): number {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'user' && typeof m.content === 'string') {
        return i;
      }
    }
    return -1;
  }
}
