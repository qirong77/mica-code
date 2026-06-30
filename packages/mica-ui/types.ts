import type React from 'react';

// ── Message / content types ──

export interface MicaUiTextBlock {
  type: 'text';
  text: string;
}

export interface MicaUiImageBlockParam {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    data: string;
  };
}

export type MicaUiContentBlockParam = MicaUiTextBlock | MicaUiImageBlockParam;

export interface MicaUiMessageParam {
  role: 'user' | 'assistant';
  content: string | MicaUiContentBlockParam[];
}

// ── UI state types ──

export type MicaUiWorkingStatus =
  | { type: 'idle' }
  | { type: 'connecting' }
  | { type: 'thinking' }
  | { type: 'streaming' }
  | { type: 'calling_tool'; elapsedMs?: number; toolNames?: string[] }
  | { type: 'plugin_task'; text: string; level?: 'info' | 'warn' | 'error' }
  | { type: 'completed'; elapsedMs?: number }
  | { type: 'error'; message?: string };

export interface MicaUiCommand {
  name: string;
  description: string;
  hidden?: boolean;
  hiddenMenuParent?: string;
  hiddenMenuItems?: MicaUiCommandHiddenMenuItems;
  action: (arg?: string) => void | Promise<void>;
}

export type MicaUiCommandHiddenMenuItems = MicaUiCommandHiddenMenuItem[] | (() => MicaUiCommandHiddenMenuItem[]);

export interface MicaUiCommandHiddenMenuItem {
  arg: string;
  label?: string;
  description?: string;
}

export interface MicaUiPluginUI {
  id: string;
  component: React.ComponentType;
  onInput?: (input: string, key: any) => boolean;
  preserveInput?: boolean;
  onTextChange?: (text: string) => boolean;
}

export interface MicaUiAgentTurnLogItem {
  id: string;
  component: React.ComponentType;
}

export interface MicaUiDropdownItem {
  key: string;
  label: string;
  description?: string;
  suffix?: { text: string; color?: string };
  commandName?: string;
  commandArg?: string;
}

export interface MicaUiDropdownState {
  visible: boolean;
  items: MicaUiDropdownItem[];
  selectedIndex: number;
  title?: string;
  emptyMessage?: string;
}

// ── Log entry types ──

export interface MicaUiThinkingEntry {
  type: 'thinking';
  id: number;
  text: string;
}

export interface MicaUiToolEntry {
  type: 'tool';
  toolUseId: string;
  toolName: string;
  displayText: string;
  completed: boolean;
  output: string;
  startTime: number;
  elapsedMs?: number;
}

export type MicaUiLogEntry = MicaUiThinkingEntry | MicaUiToolEntry;

export type MicaUiConversationMessage =
  | {
      role: 'assistant';
      content: string | MicaUiContentBlockParam[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
    }
  | { role: 'user'; content: string | MicaUiContentBlockParam[] };

export interface MicaUiUILogEntry {
  text: string;
  color?: string;
  dimColor?: boolean;
  bold?: boolean;
}

export interface MicaUiAgentStatusItem {
  id: string;
  index: number;
  title: string;
  cwd: string;
  providerName: string;
  model: string;
  status: MicaUiWorkingStatus;
  current: boolean;
  startedAt: string;
  updatedAt: string;
}

export interface MicaUiStartupBannerState {
  provider: string;
  model: string;
  context: string;
  effort: string;
  tools: string;
  mcp: string;
  session: string;
  workdir: string;
  tips: string;
}
