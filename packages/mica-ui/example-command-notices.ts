#!/usr/bin/env bun

/**
 * Standalone demo for command notice rendering.
 *
 * Run: bun packages/mica-ui/example-command-notices.ts
 */

import React from 'react';
import { wrappedRender } from '@anthropic/ink';
import { micaUi } from './index.js';

const h = React.createElement;

function Root(): React.ReactNode {
  React.useEffect(() => {
    micaUi.dropdown.quickCommand.hide();
    micaUi.bottom.plugins.clear();
    micaUi.conversation.clearResponseText();
    micaUi.conversation.clearPendingInput();
    micaUi.terminalInput.text.set('');
    micaUi.terminalInput.disabled.set(true);
    micaUi.terminalInput.setPlaceholder('command notice example - press Ctrl+C to exit');
    micaUi.panels.thinkingText.set('');
    micaUi.panels.setAgentTurnLogItems([]);
    micaUi.panels.setCommandPanelItems([]);
    micaUi.panels.modelDisplay.name.set('gpt-5.5_xhigh');
    micaUi.panels.modelDisplay.effort.set('none');
    micaUi.panels.modelDisplay.contextWindowSize.set(128000);
    micaUi.panels.contextSize.set(0);
    micaUi.panels.cachedTokenRate.set(0);
    micaUi.panels.status.idle();
    micaUi.messageBar.setMessages([]);

    micaUi.conversation.setMessages([
      {
        role: 'notice',
        command: '/compact',
        status: 'running',
        variant: 'compact',
        content: 'compact: preparing context',
      },
      {
        role: 'user',
        content: '这是其他消息',
      },
      {
        role: 'notice',
        command: '/commit',
        status: 'success',
        variant: 'commit',
        content: '已提交并推送 `abc1234`  fix: 调整 commit 和 compact 命令反馈 UI 🐛',
      },
      {
        role: 'notice',
        command: '/commit',
        status: 'warning',
        variant: 'commit',
        content: 'commit: 没有可提交的变化',
      },
    ]);

    const timer = setTimeout(() => {
      micaUi.conversation.setMessages([
        {
          role: 'notice',
          command: '/compact',
          variant: 'compact',
          status: 'info',
          content: 'compact: 当前会话内容较少，暂不需要 compact',
        },
        {
          role: 'user',
          content: '这是其他消息',
        },
        {
          role: 'notice',
          command: '/commit',
          status: 'success',
          variant: 'commit',
          content: '已提交并推送 `abc1234`  fix: 调整 commit 和 compact 命令反馈 UI 🐛',
        },
        {
          role: 'notice',
          command: '/commit',
          status: 'warning',
          variant: 'commit',
          content: 'commit: 没有可提交的变化',
        },
      ]);
    }, 1200);

    return () => {
      clearTimeout(timer);
    };
  }, []);

  return h(micaUi.App);
}

const instance = await wrappedRender(h(Root), { exitOnCtrlC: true });
await instance.waitUntilExit();
