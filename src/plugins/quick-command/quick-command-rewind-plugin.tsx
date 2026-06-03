import React from 'react';
import { Box, Text } from '../../../packages/@anthropic/ink/src';
import { UIPanelPlugin } from '../MicaPlugin';
import { hasBackups, restoreFiles } from '../../utils/fileHistory.js';

interface RewindState {
  selectedIdx: number;
}

function ConfirmDialog({
  title,
  selected,
}: {
  title: string;
  selected: number;
}) {
  const items = ['确认回退', '取消'];
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box paddingBottom={1}>
        <Text dimColor>{title}</Text>
      </Box>
      {items.map((label, i) => {
        const isSelected = i === selected;
        return (
          <Box key={label} flexDirection="row">
            <Box width={2}>
              <Text color={isSelected ? 'claude' : 'inactive'}>
                {isSelected ? '▶' : ' '}
              </Text>
            </Box>
            <Text color={isSelected ? 'claude' : undefined} bold={isSelected}>
              {label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function RewindDialog({ state }: { state: RewindState }) {
  const title = (state as any)._title as string ?? '';
  return <ConfirmDialog title={title} selected={state.selectedIdx} />;
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

    interface RewindStateWithTitle extends RewindState {
      _title: string;
    }

    this.showUI<RewindStateWithTitle>(
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
