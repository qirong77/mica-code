import { quickCommands, state, selection, inputValue, rawInputValue } from './state.js';
import type { MicaUiCommand, MicaUiCommandHiddenMenuItem, MicaUiDropdownItem } from '../../types.js';

let _emitSelect: ((item: MicaUiDropdownItem) => void) | null = null;

export function setSelectEmitter(emit: (item: MicaUiDropdownItem) => void): void {
  _emitSelect = emit;
}

export function showQuickCommands(query: string): void {
  const commands = quickCommands.get();
  const parsedQuery = parseQuickCommandQuery(query);
  const filter = parsedQuery.filter;
  const visibleCommands = commands.filter((cmd) => !cmd.hidden);
  const hiddenCommands = commands.filter((cmd) => cmd.hidden);
  const filtered = visibleCommands.filter((cmd) => commandMatchesQuery(cmd, parsedQuery));
  const directlyMatchedHiddenCommands =
    filtered.length === 0 ? hiddenCommands.filter((cmd) => commandMatchesQuery(cmd, parsedQuery)) : [];
  filtered.sort((a, b) => sortCommands(a, b, filter));
  directlyMatchedHiddenCommands.sort((a, b) => sortCommands(a, b, filter));

  const items = buildDropdownItems(filtered, hiddenCommands, directlyMatchedHiddenCommands);

  state.set({
    visible: true,
    items,
    selectedIndex: getInitialSelectedIndex(items, filter),
    title: '',
    emptyMessage: 'no matching commands',
  });
  inputValue.set(filter);
  rawInputValue.set(query);
}

export function hideQuickCommands(): void {
  const s = state.get();
  if (!s.visible) return;
  state.set({ visible: false, items: [], selectedIndex: 0 });
  selection.set(null);
  inputValue.set('');
  rawInputValue.set('');
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
  if (!s.visible) return false;
  if (key.escape) {
    closeAndClear();
    return true;
  }
  if (s.items.length === 0) {
    return Boolean(key.tab || key.return || key.upArrow || key.downArrow);
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
  rawInputValue.set('');
}

function executeSelected(): void {
  const s = state.get();
  if (!s.visible || s.items.length === 0) return;
  const idx = Math.min(s.selectedIndex, s.items.length - 1);
  const selected = s.items[idx];
  if (!selected) return;
  const commands = quickCommands.get();
  const commandName = selected.commandName ?? selected.key;
  const cmd = commands.find((c) => c.name === commandName);
  if (cmd) {
    const beforeItems = state.get().items;
    const raw = rawInputValue.get();
    cmd.action(selected.commandArg ?? commandArg(raw, cmd.name));
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

function sortCommands(a: MicaUiCommand, b: MicaUiCommand, filter: string): number {
  if (filter) {
    const aExact = a.name.toLowerCase() === filter;
    const bExact = b.name.toLowerCase() === filter;
    if (aExact !== bExact) return aExact ? -1 : 1;
    const aPrefix = a.name.toLowerCase().startsWith(filter);
    const bPrefix = b.name.toLowerCase().startsWith(filter);
    if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

function buildDropdownItems(
  commands: MicaUiCommand[],
  hiddenCommands: MicaUiCommand[],
  directlyMatchedHiddenCommands: MicaUiCommand[],
): MicaUiDropdownItem[] {
  const items = commands.map(commandToDropdownItem);
  if (commands.length !== 1) return [...items, ...directlyMatchedHiddenCommands.map(commandToDropdownItem)];

  const [command] = commands;
  if (!command) return items;

  return [
    ...items,
    ...getHiddenMenuCommands(command, hiddenCommands).map(commandToDropdownItem),
    ...resolveHiddenMenuItems(command).map((item) => {
      const label = hiddenMenuLabelText(command, item);
      return {
        key: label,
        label: `/${label}`,
        description: item.description,
        commandName: command.name,
        commandArg: item.arg,
      };
    }),
  ];
}

function commandToDropdownItem(command: MicaUiCommand): MicaUiDropdownItem {
  return {
    key: command.name,
    label: `/${command.name}`,
    description: command.description,
  };
}

function getHiddenMenuCommands(command: MicaUiCommand, hiddenCommands: MicaUiCommand[]): MicaUiCommand[] {
  return hiddenCommands.filter((item) => item.hiddenMenuParent === command.name);
}

function resolveHiddenMenuItems(command: MicaUiCommand): MicaUiCommandHiddenMenuItem[] {
  try {
    const hiddenMenuItems =
      typeof command.hiddenMenuItems === 'function' ? command.hiddenMenuItems() : command.hiddenMenuItems;
    return hiddenMenuItems ?? [];
  } catch {
    return [];
  }
}

function getInitialSelectedIndex(items: MicaUiDropdownItem[], filter: string): number {
  if (!filter) return 0;
  const index = items.findIndex((item) => item.label.slice(1).toLowerCase().startsWith(filter));
  return index === -1 ? 0 : index;
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

function commandMatchesQuery(cmd: MicaUiCommand, query: ParsedQuickCommandQuery): boolean {
  if (!query.filter) return true;
  const name = cmd.name.toLowerCase();
  if (query.hasArgs) {
    return name === query.commandToken || name.startsWith(query.commandToken);
  }
  return name.includes(query.filter);
}

function hiddenMenuLabelText(command: MicaUiCommand, item: MicaUiCommandHiddenMenuItem): string {
  return (item.label ?? `${command.name} ${item.arg}`).toLowerCase();
}

function commandArg(raw: string, commandName: string): string | undefined {
  const trimmedStart = raw.trimStart();
  const arg = trimmedStart.slice(commandName.length).trim();
  return arg || undefined;
}
