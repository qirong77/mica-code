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
  role: 'user' | 'assistant' | 'notice';
  content: string | MicaUiContentBlockParam[];
  displayContent?: string | MicaUiContentBlockParam[];
  variant?: 'recap' | 'commit' | 'config' | 'compact' | 'error';
  command?: string;
}

// ── UI state types ──

export type MicaUiWorkingStatus =
  | { type: 'idle' }
  | { type: 'connecting'; startedAt?: number; moduleStartedAt?: number }
  | { type: 'thinking'; startedAt?: number; moduleStartedAt?: number }
  | { type: 'streaming'; startedAt?: number; moduleStartedAt?: number }
  | { type: 'calling_tool'; startedAt?: number; moduleStartedAt?: number; elapsedMs?: number; toolNames?: string[] }
  | { type: 'plugin_task'; text: string; level?: 'info' | 'warn' | 'error' }
  | { type: 'completed'; startedAt?: number; elapsedMs?: number }
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

export type MicaUiConversationMessage =
  | {
      role: 'assistant';
      content: string | MicaUiContentBlockParam[];
      displayContent?: string | MicaUiContentBlockParam[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      stop_reason?: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
    }
  | { role: 'user'; content: string | MicaUiContentBlockParam[]; displayContent?: string | MicaUiContentBlockParam[] }
  | {
      role: 'notice';
      content: string | MicaUiContentBlockParam[];
      displayContent?: string | MicaUiContentBlockParam[];
      variant?: 'recap' | 'commit' | 'config' | 'compact' | 'error';
      command?: string;
    };

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

export type MicaUiBackgroundTaskStatus = 'starting' | 'running' | 'finished' | 'killed' | 'failed' | 'unknown_exited';

export interface MicaUiBackgroundTaskItem {
  id: string;
  command: string;
  cwd: string;
  shell: string;
  pid?: number;
  outputPath: string;
  outputSize: number;
  status: MicaUiBackgroundTaskStatus;
  startedAt: string;
  finishedAt?: string;
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
