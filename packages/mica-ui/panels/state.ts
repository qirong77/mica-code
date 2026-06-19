import { atom } from 'nanostores';
import type {
  MicaUiWorkingStatus,
  MicaUiLogEntry,
  MicaUiAgentTurnLogItem,
  MicaUiPluginUI,
  MicaUiUILogEntry,
  MicaUiAgentStatusItem,
} from '../types.js';

export const workingStatus = atom<MicaUiWorkingStatus>({ type: 'idle' });
export const thinkingText = atom('');
export const logEntries = atom<MicaUiLogEntry[]>([]);
export const agentTurnLogItems = atom<MicaUiAgentTurnLogItem[]>([]);
export const pluginUIs = atom<MicaUiPluginUI[]>([]);
export const contextSize = atom(0);
export const cachedTokenRate = atom(0);
export const agentStatusItems = atom<MicaUiAgentStatusItem[]>([]);

export const modelDisplay = {
  name: atom('claude-sonnet-4-6'),
  effort: atom('low'),
  contextWindowSize: atom(100000),
};

const _uiLog = atom<MicaUiUILogEntry[]>([]);
export const uiLog = _uiLog as {
  get(): MicaUiUILogEntry[];
  set(v: MicaUiUILogEntry[]): void;
  subscribe(cb: (v: MicaUiUILogEntry[]) => void): () => void;
};

export function pushLog(entry: MicaUiUILogEntry | string): void {
  _uiLog.set([..._uiLog.get(), typeof entry === 'string' ? { text: entry } : entry]);
}

export function clearLog(): void {
  _uiLog.set([]);
}

export function setWorkingStatus(status: MicaUiWorkingStatus): void {
  workingStatus.set(status);
}

export const status = {
  idle: () => setWorkingStatus({ type: 'idle' }),
  connecting: () => setWorkingStatus({ type: 'connecting' }),
  thinking: () => setWorkingStatus({ type: 'thinking' }),
  streaming: () => setWorkingStatus({ type: 'streaming' }),
  callingTool: (toolNames?: string[], elapsedMs?: number) =>
    setWorkingStatus({ type: 'calling_tool', toolNames, elapsedMs }),
  pluginTask: (text: string, level?: 'info' | 'warn' | 'error') =>
    setWorkingStatus({ type: 'plugin_task', text, level }),
  completed: (elapsedMs?: number) => setWorkingStatus({ type: 'completed', elapsedMs }),
  error: (message?: string) => setWorkingStatus({ type: 'error', message }),
};

export function setLogEntries(entries: MicaUiLogEntry[]): void {
  logEntries.set(entries);
}

export function clearLogEntries(): void {
  logEntries.set([]);
  agentTurnLogItems.set([]);
}

export function setAgentTurnLogItems(items: MicaUiAgentTurnLogItem[]): void {
  agentTurnLogItems.set(items);
}

export function appendAgentTurnLogItem(item: MicaUiAgentTurnLogItem): void {
  agentTurnLogItems.set([...agentTurnLogItems.get(), item]);
}

export function replaceAgentTurnLogItem(item: MicaUiAgentTurnLogItem): void {
  const items = agentTurnLogItems.get();
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) {
    agentTurnLogItems.set([...items, item]);
  } else {
    agentTurnLogItems.set([...items.slice(0, index), item, ...items.slice(index + 1)]);
  }
}

export function clearAgentTurnLogItems(): void {
  agentTurnLogItems.set([]);
}

export function setPluginUIs(pluginPanels: MicaUiPluginUI[]): void {
  pluginUIs.set(pluginPanels);
}

export function clearPluginUIs(): void {
  pluginUIs.set([]);
}

export function setAgentStatusItems(items: MicaUiAgentStatusItem[]): void {
  agentStatusItems.set([...items]);
}

let _onAbortAgent: (() => void) | null = null;
let _onEditPendingInput: (() => string | null | undefined) | null = null;

export function setOnAbortAgent(cb: () => void): void {
  _onAbortAgent = cb;
}

export function abortAgent(): void {
  _onAbortAgent?.();
}

export function setOnEditPendingInput(cb: () => string | null | undefined): void {
  _onEditPendingInput = cb;
}

export function editPendingInput(): string | null {
  return _onEditPendingInput?.() ?? null;
}
