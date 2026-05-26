import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { MicaPlugin } from '../MicaPlugin';
import { hasBackups, rewindFiles } from '../../utils/fileHistory.js';

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
    const hasFileChanges = hasBackups();

    const detailParts: string[] = [`将移除 ${removedCount} 条消息`];
    if (hasFileChanges) detailParts.push('并回退代码改动');

    const title = `rewind: ${detailParts.join('，')}`;

    const ctx = {
      selectedIdx: 0,
      render: null as any,
      onInput: null as any,
    };

    ctx.render = () => <ConfirmDialog title={title} selected={ctx.selectedIdx} />;

    ctx.onInput = (_input: string, key: any) => {
      if (key.upArrow || key.downArrow) {
        ctx.selectedIdx = ctx.selectedIdx === 0 ? 1 : 0;
        this.showUI(ctx.render, ctx.onInput);
        return true;
      }
      if (key.return) {
        this.hideUI();
        if (ctx.selectedIdx === 1) {
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
    };

    this.showUI(ctx.render, ctx.onInput);
  }

  private _doRewind(
    originalMsgs: readonly any[],
    cutoff: number,
    hasFileChanges: boolean,
  ) {
    const rewinded = originalMsgs.slice(0, cutoff);
    this.atoms.messages.set(rewinded);

    if (hasFileChanges) {
      rewindFiles()
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
