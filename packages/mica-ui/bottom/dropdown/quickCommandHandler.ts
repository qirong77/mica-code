import { quickCommands, state, selection, inputValue } from './state.js';
import { disabled as inputDisabled } from '../../input/state.js';
import type { MicaUiDropdownItem } from '../../types.js';

let _emitSelect: ((item: MicaUiDropdownItem) => void) | null = null;

export function setSelectEmitter(emit: (item: MicaUiDropdownItem) => void): void {
  _emitSelect = emit;
}

export function showQuickCommands(query: string): void {
  const commands = quickCommands.get();
  const parsedQuery = parseQuickCommandQuery(query);
  const filter = parsedQuery.filter;
  const filtered = commands.filter((cmd) => commandMatchesQuery(cmd, parsedQuery));
  filtered.sort((a, b) => {
    if (filter) {
      const aExact = a.name.toLowerCase() === filter;
      const bExact = b.name.toLowerCase() === filter;
      if (aExact !== bExact) return aExact ? -1 : 1;
      const aPrefix = a.name.toLowerCase().startsWith(filter);
      const bPrefix = b.name.toLowerCase().startsWith(filter);
      if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  state.set({
    visible: true,
    items: filtered.map((cmd) => ({ key: cmd.name, label: `/${cmd.name}`, description: cmd.description })),
    selectedIndex: 0,
    title: '',
    emptyMessage: 'no matching commands',
  });
  inputValue.set(query);
  inputDisabled.set(true);
}

export function hideQuickCommands(): void {
  const s = state.get();
  if (!s.visible) return;
  state.set({ visible: false, items: [], selectedIndex: 0 });
  selection.set(null);
  inputValue.set('');
  inputDisabled.set(false);
}

export function handleDropdownKey(key: {
  escape?: boolean;
  tab?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  shift?: boolean;
}): boolean {
  const s = state.get();
  if (!s.visible || s.items.length === 0) return false;
  if (key.escape) {
    closeAndClear();
    return true;
  }
  if (key.tab) {
    executeSelected();
    return true;
  }
  if (key.return && !key.shift) {
    executeSelected();
    return true;
  }
  if (key.upArrow) {
    navigateDropdown(-1);
    return true;
  }
  if (key.downArrow) {
    navigateDropdown(1);
    return true;
  }
  return false;
}

function closeAndClear(): void {
  state.set({ visible: false, items: [], selectedIndex: 0 });
  selection.set(null);
  inputValue.set('');
  inputDisabled.set(false);
}

function executeSelected(): void {
  const s = state.get();
  if (!s.visible || s.items.length === 0) return;
  const idx = Math.min(s.selectedIndex, s.items.length - 1);
  const selected = s.items[idx];
  if (!selected) return;
  const commands = quickCommands.get();
  const cmd = commands.find((c) => c.name === selected.key);
  if (cmd) {
    const beforeItems = state.get().items;
    const raw = inputValue.get();
    cmd.action(commandArg(raw, cmd.name));
    if (state.get().visible && state.get().items === beforeItems) closeAndClear();
    return;
  }
  selection.set(selected);
  _emitSelect?.(selected);
  closeAndClear();
}

function navigateDropdown(direction: 1 | -1): void {
  const s = state.get();
  if (!s.visible || s.items.length === 0) return;
  const len = s.items.length;
  const newIndex =
    direction === -1
      ? s.selectedIndex > 0
        ? s.selectedIndex - 1
        : len - 1
      : s.selectedIndex < len - 1
        ? s.selectedIndex + 1
        : 0;
  state.set({ ...s, selectedIndex: newIndex });
}

type ParsedQuickCommandQuery = {
  filter: string;
  commandToken: string;
  hasArgs: boolean;
};

function parseQuickCommandQuery(query: string): ParsedQuickCommandQuery {
  const trimmedStart = query.trimStart();
  const commandToken = trimmedStart.match(/^\S*/)?.[0].toLowerCase() ?? '';
  const remainder = trimmedStart.slice(commandToken.length);
  const hasArgs = remainder.length > 0;
  return {
    filter: hasArgs ? commandToken : trimmedStart.trimEnd().toLowerCase(),
    commandToken,
    hasArgs,
  };
}

function commandMatchesQuery(cmd: { name: string; description: string }, query: ParsedQuickCommandQuery): boolean {
  if (!query.filter) return true;
  const name = cmd.name.toLowerCase();
  if (query.hasArgs) {
    return name === query.commandToken || name.startsWith(query.commandToken);
  }
  const description = cmd.description.toLowerCase();
  return name.includes(query.filter) || description.includes(query.filter);
}

function commandArg(raw: string, commandName: string): string | undefined {
  const trimmedStart = raw.trimStart();
  const arg = trimmedStart.slice(commandName.length).trim();
  return arg || undefined;
}
