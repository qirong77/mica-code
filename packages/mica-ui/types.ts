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

export type MicaUiCommandStatus = 'running' | 'success' | 'warning' | 'error' | 'info';

export interface MicaUiMessageParam {
  role: 'user' | 'assistant' | 'notice';
  content: string | MicaUiContentBlockParam[];
  displayContent?: string | MicaUiContentBlockParam[];
  variant?: 'commit' | 'config' | 'compact' | 'error';
  command?: string;
  status?: MicaUiCommandStatus;
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
  completionItems?: MicaUiCommandCompletionItems;
  action: (arg?: string) => void | Promise<void>;
}

export type MicaUiCommandCompletionItems = MicaUiCommandCompletionItem[] | (() => MicaUiCommandCompletionItem[]);

export interface MicaUiCommandCompletionItem {
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

export type MicaUiCommandPanelStatus = MicaUiCommandStatus;

export type MicaUiCommandPanelVariant = 'commit' | 'config' | 'compact' | 'error';

export interface MicaUiCommandPanelItem {
  id: string;
  command: string;
  variant?: MicaUiCommandPanelVariant;
  status: MicaUiCommandPanelStatus;
  text: string;
  lines?: string[];
  startedAt?: number;
  updatedAt?: number;
}

export interface MicaUiDropdownItem {
  key: string;
  label: string;
  description?: string;
  suffix?: { text: string; color?: string };
  commandName?: string;
  insertText?: string;
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
      variant?: 'commit' | 'config' | 'compact' | 'error';
      command?: string;
      status?: MicaUiCommandStatus;
    };

export interface MicaUiAgentStatusItem {
  id: string;
  taskOwnerId?: string;
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
  agentOwnerId?: string;
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

export type MicaUiSubagentTaskStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface MicaUiSubagentTaskActivity {
  id: string;
  summary: string;
  toolName?: string;
  startedAt: string;
}

export interface MicaUiSubagentTaskItem {
  id: string;
  description: string;
  subagentType: string;
  model: string;
  status: MicaUiSubagentTaskStatus;
  parentTaskId?: string;
  activities?: MicaUiSubagentTaskActivity[];
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
