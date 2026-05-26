import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { execSync } from 'node:child_process';
import { MicaPlugin } from '../MicaPlugin';

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
      {items.map((label, i) => (
        <Text key={label} color={i === selected ? 'claude' : 'inactive'}>
          {label}
        </Text>
      ))}
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

    let hasFileChanges = false;
    try {
      const diff = execSync('git diff --name-only', { encoding: 'utf-8', cwd: process.cwd() });
      hasFileChanges = diff.trim().length > 0;
    } catch {}

    const detailParts: string[] = [`将移除 ${removedCount} 条消息`];
    if (hasFileChanges) detailParts.push('并回退工作区代码改动');

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
