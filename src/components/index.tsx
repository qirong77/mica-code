import { createRoot } from '@anthropic/ink';
import React from 'react';
import { App } from './app.js';

// ── 统一导出所有 UI 组件 ──
import { TerminalInputUI } from './input/TerminalInput.js';
import { ConversationUI } from './conversation/Conversation.js';
import { WorkingStatusUI } from './panels/WorkingStatus.js';
import { DropDownUI } from './dropdown/index.js';
import { MessageBarAPI } from './panels/MessageBar.js';
import { AgentTurnLogUI } from './panels/AgentTurnLog.js';

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
