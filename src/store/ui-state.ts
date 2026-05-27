import { atom } from 'nanostores';

export type WorkingStatus =
  | { type: 'idle' }
  | { type: 'connecting' }
  | { type: 'thinking' }
  | { type: 'streaming' }
  | { type: 'calling_tool'; elapsedMs?: number; toolNames?: string[] }
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
  state: atom<DropdownState>({ visible: false, items: [], selectedIndex: 0 }),
  selection: atom<DropdownItem | null>(null),
  inputValue: atom(''),
  cursor: atom(0),
};

export const thinkingTextAtom = atom('');

export const responseTextAtom = atom('');

export const DEFAULT_INPUT_PLACEHOLDER = 'Type something and press Enter...';

export const terminalInput = {
  text: atom(''),
  disabled: atom(false),
  placeholder: atom(DEFAULT_INPUT_PLACEHOLDER),
};

export const quickCommandsAtom = atom<Command[]>([]);

export interface PluginUI {
  id: string;
  component: React.ComponentType;
  onInput?: (input: string, key: any) => boolean;
  /** 为 true 时，onInput 消费按键后不清空输入框（用于过滤输入等场景） */
  preserveInput?: boolean;
  onTextChange?: (text: string) => boolean;
}

export const pluginUIsAtom = atom<PluginUI[]>([]);

export const systemLogVisibleAtom = atom(false);

export const session = {
  index: atom<SessionMeta[]>([]),
  currentId: atom<string>(''),
  switchSignal: atom<string | null>(null),
};
