import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { UIPanelPlugin, handleListKeys } from '../MicaPlugin';
import { hasBackups, listBackedUpFiles, restoreFiles } from '../../utils/fileHistory.js';
import { Dialog, SelectList, KeyHints } from '../../components/primitives/index.js';

interface RewindState {
  selectedIdx: number;
  _title: string;
  lastUserText: string;
  affectedFiles: string[];
}

function extractUserText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('')
      .trim();
  }
  return '';
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

function RewindDialog({ state }: { state: RewindState }) {
  const items = [
    { key: 'confirm', label: '确认回退' },
    { key: 'cancel', label: '取消' },
  ];

  return (
    <Dialog
      title={state._title}
      footer={<KeyHints hints={['↑↓ navigate', '↵ confirm', 'esc cancel']} />}
    >
      <Box flexDirection="column" paddingBottom={1}>
        <Box>
          <Text>将回退到对话：</Text>
          <Text bold>{state.lastUserText}</Text>
        </Box>
        {state.affectedFiles.length > 0 && (
          <Box flexDirection="column" paddingTop={1}>
            <Text dimColor>受影响的文件：</Text>
            {state.affectedFiles.map((f, i) => (
              <Text key={i} dimColor>
                {' '}
                {f}
              </Text>
            ))}
          </Box>
        )}
      </Box>
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

    const lastMsg = msgs[cutoff];
    const userText = truncate(extractUserText(lastMsg.content), 60);

    const removedCount = msgs.length - cutoff;
    const backedUpFiles = hasBackups() ? listBackedUpFiles() : [];
    const affectedFiles = backedUpFiles.map((f) => {
      const parts = f.split('/');
      return parts.length > 3 ? '../' + parts.slice(-3).join('/') : f;
    });

    const detailParts: string[] = [`移除 ${removedCount} 条消息`];
    if (affectedFiles.length > 0) detailParts.push(`回退 ${affectedFiles.length} 个文件`);

    const title = `rewind: ${detailParts.join('，')}`;

    this.showUI<RewindState>(
      RewindDialog,
      { selectedIdx: 0, _title: title, lastUserText: userText, affectedFiles },
      (_input, key, state, setState) =>
        handleListKeys(
          key,
          state,
          setState,
          2,
          (idx) => {
            this.hideUI();
            if (idx === 1) {
              this.showMessage('已取消');
              return;
            }
            this._doRewind(msgs, cutoff, affectedFiles.length > 0);
          },
          () => {
            this.hideUI();
            this.showMessage('已取消');
          },
        ),
    );
  }

  private _doRewind(originalMsgs: readonly any[], cutoff: number, hasFileChanges: boolean) {
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
      if (m.role === 'user' && (typeof m.content === 'string' || Array.isArray(m.content))) {
        return i;
      }
    }
    return -1;
  }
}
