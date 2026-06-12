import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { UIPanelPlugin } from '../MicaPlugin.js';
import { Spin } from '../../components/primitives/Spin.js';
import { getClient } from '../../agent/client.js';
import { Dialog } from '../../components/primitives/index.js';

function RenameSpinner() {
  return (
    <Dialog title="正在生成标题...">
      <Box>
        <Spin />
        <Text dimColor> 请稍候...</Text>
      </Box>
    </Dialog>
  );
}

export class QuickCommandRenamePlugin extends UIPanelPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'rename',
      description: 'AI 生成会话标题（可带参数直接指定标题）',
      action: (arg?: string) => {
        if (arg && arg.trim()) {
          this._setTitle(arg.trim());
        } else {
          this._generateTitle();
        }
      },
    });
  }

  private _setTitle(title: string) {
    const currentId = this.atoms.currentSessionId.get();
    if (!currentId) {
      this.showMessage('没有活跃的会话');
      return;
    }

    const idx = this.atoms.sessionsIndex.get();
    const updated = idx.map((s) =>
      s.id === currentId ? { ...s, title, updatedAt: Date.now() } : s,
    );
    this.atoms.sessionsIndex.set(updated);
    this.showMessage(`标题已更新: ${title}`);
  }

  private async _generateTitle() {
    const currentId = this.atoms.currentSessionId.get();
    if (!currentId) {
      this.showMessage('没有活跃的会话');
      return;
    }

    const messages = this.atoms.messages.get().filter((m: any) => m.status !== 'clear');
    if (messages.length === 0) {
      this.showMessage('没有对话内容');
      return;
    }

    this.showUISimple(RenameSpinner);

    try {
      const client = getClient();
      const modelName = this.atoms.model.get();

      const conversationPreview = messages
        .slice(0, 6)
        .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 200) : '[tool calls]'}`)
        .join('\n');

      const res = await client.messages.create({
        model: modelName,
        max_tokens: 50,
        system: '你是一个会话命名助手。根据对话内容生成一个简洁的中文标题（不超过20字），只回复标题本身，不要加引号、标点或其他内容。如果不确定，回复"未命名会话"。',
        messages: [
          { role: 'user', content: `请为以下对话生成标题：\n${conversationPreview}` },
        ],
      });

      const title =
        (res.content[0]?.type === 'text' ? res.content[0].text.trim() : '') ||
        '未命名会话';

      const idx = this.atoms.sessionsIndex.get();
      const updated = idx.map((s) =>
        s.id === currentId ? { ...s, title, updatedAt: Date.now() } : s,
      );
      this.atoms.sessionsIndex.set(updated);
      this.showMessage(`标题已更新: ${title}`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.showMessage(`生成失败: ${errMsg}`);
    } finally {
      this.hideUI();
    }
  }
}