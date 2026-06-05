import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { UIPanelPlugin } from '../MicaPlugin';
import { hasBackups, restoreFiles } from '../../utils/fileHistory.js';
import { Dialog, SelectList, KeyHints } from '../../components/ui/primitives/index.js';

interface RewindState {
  selectedIdx: number;
  _title: string;
}

function RewindDialog({ state }: { state: RewindState }) {
  const items = [
    { key: 'confirm', label: '确认回退' },
    { key: 'cancel', label: '取消' },
  ];

  return (
    <Dialog title={state._title} footer={<KeyHints hints={['↑↓ navigate', '↵ confirm', 'esc cancel']} />}>
      <SelectList items={items} selectedIdx={state.selectedIdx} />
    </Dialog>
  );
}

export class QuickCommandRewindPlugin extends UIPanelPlugin {
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
    const hasFileChanges = hasBackups();

    const detailParts: string[] = [`将移除 ${removedCount} 条消息`];
    if (hasFileChanges) detailParts.push('并回退代码改动');

    const title = `rewind: ${detailParts.join('，')}`;

    this.showUI<RewindState>(
      RewindDialog,
      { selectedIdx: 0, _title: title },
      (_input, key, state, setState) => {
        if (key.upArrow || key.downArrow) {
          setState({ ...state, selectedIdx: state.selectedIdx === 0 ? 1 : 0 });
          return true;
        }
        if (key.return) {
          this.hideUI();
          if (state.selectedIdx === 1) {
            this.showMessage('已取消');
            return true;
          }
          this._doRewind(msgs, cutoff, hasFileChanges);
          return true;
        }
        if (key.escape) {
          this.hideUI();
          this.showMessage('已取消');
          return true;
        }
        return false;
      },
    );
  }

  private _doRewind(
    originalMsgs: readonly any[],
    cutoff: number,
    hasFileChanges: boolean,
  ) {
    const rewinded = originalMsgs.slice(0, cutoff);
    this.agent.agentTurn.session.replaceMessages(rewinded);

    if (hasFileChanges) {
      restoreFiles()
        .then(() => {
          this.showMessage(`已回退最近一轮对话及代码改动`);
        })
        .catch(() => {
          this.showMessage('回退消息成功，但代码回退失败');
        });
    } else {
      this.showMessage(`已回退最近一轮对话`);
    }
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
