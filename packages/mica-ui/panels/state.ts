import { atom } from 'nanostores';
import type {
  MicaUiWorkingStatus,
  MicaUiAgentTurnLogItem,
  MicaUiPluginUI,
  MicaUiAgentStatusItem,
  MicaUiBackgroundTaskItem,
  MicaUiSubagentTaskItem,
  MicaUiStartupBannerState,
  MicaUiCommandPanelItem,
} from '../types.js';

const MAX_COMMAND_PANEL_ITEMS = 4;
const MAX_COMMAND_PANEL_LINES = 8;

export const workingStatus = atom<MicaUiWorkingStatus>({ type: 'idle' });
export const thinkingText = atom('');
export const agentTurnLogItems = atom<MicaUiAgentTurnLogItem[]>([]);
export const pluginUIs = atom<MicaUiPluginUI[]>([]);
export const commandPanelItems = atom<MicaUiCommandPanelItem[]>([]);
export const contextSize = atom(0);
export const cachedTokenRate = atom(0);
export const agentStatusItems = atom<MicaUiAgentStatusItem[]>([]);
export const backgroundTaskItems = atom<MicaUiBackgroundTaskItem[]>([]);
export const subagentTaskItems = atom<MicaUiSubagentTaskItem[]>([]);
export const startupBanner = atom<MicaUiStartupBannerState>({
  provider: '-',
  model: '-',
  context: '-',
  effort: '-',
  tools: '-',
  mcp: '-',
  session: 'new',
  workdir: '-',
  tips: '/help for commands · /model to switch',
});

export const modelDisplay = {
  name: atom('-'),
  effort: atom('-'),
  contextWindowSize: atom(0),
};

export function setWorkingStatus(status: MicaUiWorkingStatus): void {
  workingStatus.set(status);
}

export const status = {
  idle: () => setWorkingStatus({ type: 'idle' }),
  connecting: (startedAt?: number, moduleStartedAt?: number) =>
    setWorkingStatus({ type: 'connecting', startedAt, moduleStartedAt }),
  thinking: (startedAt?: number, moduleStartedAt?: number) =>
    setWorkingStatus({ type: 'thinking', startedAt, moduleStartedAt }),
  streaming: (startedAt?: number, moduleStartedAt?: number) =>
    setWorkingStatus({ type: 'streaming', startedAt, moduleStartedAt }),
  callingTool: (toolNames?: string[], elapsedMs?: number, startedAt?: number, moduleStartedAt?: number) =>
    setWorkingStatus({ type: 'calling_tool', startedAt, moduleStartedAt, toolNames, elapsedMs }),
  pluginTask: (text: string, level?: 'info' | 'warn' | 'error') =>
    setWorkingStatus({ type: 'plugin_task', text, level }),
  completed: (elapsedMs?: number, startedAt?: number) => setWorkingStatus({ type: 'completed', startedAt, elapsedMs }),
  error: (message?: string) => setWorkingStatus({ type: 'error', message }),
};

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

export function setExclusivePluginUI(pluginPanel: MicaUiPluginUI): void {
  pluginUIs.set([pluginPanel]);
}

export function upsertPluginUI(pluginPanel: MicaUiPluginUI): void {
  pluginUIs.set([...pluginUIs.get().filter((panel) => panel.id !== pluginPanel.id), pluginPanel]);
}

export function removePluginUI(id: string): boolean {
  const panels = pluginUIs.get();
  const nextPanels = panels.filter((panel) => panel.id !== id);
  if (nextPanels.length === panels.length) return false;
  pluginUIs.set(nextPanels);
  return true;
}

export function clearPluginUIs(): void {
  pluginUIs.set([]);
}

export function setCommandPanelItems(items: MicaUiCommandPanelItem[]): void {
  commandPanelItems.set(trimCommandPanelItems(items));
}

export function upsertCommandPanelItem(item: MicaUiCommandPanelItem): void {
  const now = item.updatedAt ?? Date.now();
  const items = commandPanelItems.get();
  const existing = items.find((entry) => entry.id === item.id);
  const nextItem: MicaUiCommandPanelItem = {
    ...existing,
    ...item,
    startedAt: item.startedAt ?? existing?.startedAt ?? now,
    updatedAt: now,
    lines: trimCommandPanelLines(item.lines ?? existing?.lines ?? []),
  };
  setCommandPanelItems([...items.filter((entry) => entry.id !== item.id), nextItem]);
}

export function removeCommandPanelItem(id: string): boolean {
  const items = commandPanelItems.get();
  const nextItems = items.filter((item) => item.id !== id);
  if (nextItems.length === items.length) return false;
  commandPanelItems.set(nextItems);
  return true;
}

export function clearCommandPanelItems(): void {
  commandPanelItems.set([]);
}

export function setAgentStatusItems(items: MicaUiAgentStatusItem[]): void {
  agentStatusItems.set([...items]);
}

export function setBackgroundTaskItems(items: MicaUiBackgroundTaskItem[]): void {
  backgroundTaskItems.set([...items]);
}

export function setSubagentTaskItems(items: MicaUiSubagentTaskItem[]): void {
  subagentTaskItems.set([...items]);
}

export function setStartupBanner(state: Partial<MicaUiStartupBannerState>): void {
  startupBanner.set({ ...startupBanner.get(), ...state });
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

function trimCommandPanelItems(items: MicaUiCommandPanelItem[]): MicaUiCommandPanelItem[] {
  return items.slice(-MAX_COMMAND_PANEL_ITEMS).map((item) => ({
    ...item,
    lines: trimCommandPanelLines(item.lines ?? []),
  }));
}

function trimCommandPanelLines(lines: string[]): string[] {
  return lines.slice(-MAX_COMMAND_PANEL_LINES);
}
