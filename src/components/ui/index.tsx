import { createRoot } from '@anthropic/ink';
import React from 'react';
import { App } from './app.js';

// ── 统一导出所有 UI 组件 ──
import { TerminalInputUI } from './components/TerminalInput/TerminalInput.js';
import { ConversationUI } from './components/Conversation/Conversation.js';
import { WorkingStatusUI } from './components/WorkingStatus/index.js';
import { DropDownUI } from './components/DropDown/index.js';
import { MessageBarAPI } from './components/MessageBar/index.js';
import { AgentTurnLogUI } from './components/AgentTurnLog/AgentTurnLog.js';

function Root() {
  return <App />;
}

async function run() {
  const root = await createRoot({ exitOnCtrlC: false });
  root.render(<Root />);
}

/**
 * ui 对象：集中管理所有 UI 组件及其导出对象。
 *
 * 每个 UI 组件遵循统一的导出模式：
 * - renderFn: React 渲染函数
 * - 语义化方法（如 onSubmit / addMessage / clearMessages）替代裸 emitter
 * - atomData?: nanostores atom（用于暴露响应式数据）
 */
export const ui = {
  TerminalInput: TerminalInputUI,
  Conversation: ConversationUI,
  WorkingStatus: WorkingStatusUI,
  DropDown: DropDownUI,
  MessageBar: MessageBarAPI,
  AgentTurnLog: AgentTurnLogUI,
  run,
};
