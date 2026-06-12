import { atom } from 'nanostores';
import { createPersistedAtom } from './createPersistedAtom.js';

export { session, type SessionMeta } from './ui/session.js';
export {
  terminalInput,
  dropdown,
  DEFAULT_INPUT_PLACEHOLDER,
  inputBottomDistanceAtom,
} from './ui/terminal.js';
export type { DropdownItem, DropdownState } from './ui/terminal.js';

export type WorkingStatus =
  | { type: 'idle' }
  | { type: 'connecting' }
  | { type: 'thinking' }
  | { type: 'streaming' }
  | { type: 'calling_tool'; elapsedMs?: number; toolNames?: string[] }
  | { type: 'completed'; elapsedMs?: number }
  | { type: 'error'; message?: string };

export interface ActiveTool {
  toolUseId: string;
  toolName: string;
  displayText: string;
  completed: boolean;
  output: string;
  elapsedMs?: number;
  startTime: number;
}

export interface Command {
  name: string;
  description: string;
  action: (arg?: string) => void;
  hidden?: boolean;
}

export interface PluginUI {
  id: string;
  component: React.ComponentType;
  onInput?: (input: string, key: any) => boolean;
  preserveInput?: boolean;
  onTextChange?: (text: string) => boolean;
}

export const workingStatusAtom = atom<WorkingStatus>({ type: 'idle' });

export const activeToolsAtom = atom<ActiveTool[]>([]);

export const thinkingTextAtom = atom('');

export const responseTextAtom = atom('');

export const planModeAtom = createPersistedAtom('planMode', false);

export const quickCommandsAtom = atom<Command[]>([]);

export const pluginUIsAtom = atom<PluginUI[]>([]);

export const pendingInputAtom = atom<string | null>(null);
