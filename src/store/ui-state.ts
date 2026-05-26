import { atom } from 'nanostores';

export type WorkingStatus =
  | { type: 'idle' }
  | { type: 'connecting' }
  | { type: 'thinking' }
  | { type: 'streaming' }
  | { type: 'calling_tool'; elapsedMs?: number }
  | { type: 'completed'; elapsedMs?: number }
  | { type: 'error'; message?: string };

export interface DropdownItem {
  key: string;
  label: string;
  description?: string;
  suffix?: { text: string; color?: string };
}

export interface DropdownState {
  visible: boolean;
  items: DropdownItem[];
  selectedIndex: number;
  title?: string;
  emptyMessage?: string;
}

export interface ToolCallData {
  id: string;
  toolName: string;
  toolInput: Record<string, any>;
  completed: boolean;
  displayText: string;
  status?: 'executing' | 'error';
  elapsedMs?: number;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface Command {
  name: string;
  description: string;
  action: (arg?: string) => void;
  hidden?: boolean;
}

export const workingStatusAtom = atom<WorkingStatus>({ type: 'idle' });

export const dropdown = {
  atom: atom<DropdownState>({ visible: false, items: [], selectedIndex: 0 }),
  selection: atom<DropdownItem | null>(null),
  inputValue: atom(''),
  cursor: atom(0),
};

export const logTextAtom = atom('');

export const streamingTextAtom = atom('');

export const toolCallsAtom = atom<ToolCallData[]>([]);

export const terminalInput = {
  text: atom(''),
  disabled: atom(false),
};

export const quickCommandsAtom = atom<Command[]>([]);

export interface PluginUI {
  id: string;
  component: React.ComponentType;
  onInput?: (input: string, key: any) => boolean;
}

export const pluginUIsAtom = atom<PluginUI[]>([]);

export const systemLogVisibleAtom = atom(false);

export const session = {
  index: atom<SessionMeta[]>([]),
  currentId: atom<string>(''),
  switch: atom<string | null>(null),
};
