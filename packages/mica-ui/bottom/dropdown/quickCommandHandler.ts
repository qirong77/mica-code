import { quickCommands, state, selection, inputValue, rawInputValue } from './state.js';
import type { MicaUiCommand, MicaUiCommandCompletionItem, MicaUiDropdownItem } from '../../types.js';
import { backgroundTaskItems } from '../../panels/state.js';
import { isActiveBackgroundTaskStatus } from '../../panels/BackgroundTaskRow.js';

let _emitSelect: ((item: MicaUiDropdownItem) => void) | null = null;

export function setSelectEmitter(emit: (item: MicaUiDropdownItem) => void): void {
  _emitSelect = emit;
}

export function showQuickCommands(query: string): void {
  const commands = quickCommands.get();
  const parsedQuery = parseQuickCommandQuery(query);
  const filter = parsedQuery.filter;
  const filtered = commands.filter((cmd) => commandMatchesQuery(cmd, parsedQuery));
  const sortPriorities = new Map(commands.map((command) => [command.name, getCommandSortPriority(command)]));
  filtered.sort((a, b) => sortCommands(a, b, filter, sortPriorities));

  const items = buildDropdownItems(filtered, parsedQuery);

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
  closeAndClear();
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
    applySelected();
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
    cmd.action(selectedCommandArg(selected, cmd.name, raw));
    if (state.get().visible && state.get().items === beforeItems) closeAndClear();
    return;
  }
  selection.set(selected);
  _emitSelect?.(selected);
  closeAndClear();
}

function applySelected(): void {
  const s = state.get();
  if (!s.visible || s.items.length === 0) return;
  const idx = Math.min(s.selectedIndex, s.items.length - 1);
  const selected = s.items[idx];
  if (!selected?.insertText) return;
  selection.set(selected);
  _emitSelect?.(selected);
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

function sortCommands(
  a: MicaUiCommand,
  b: MicaUiCommand,
  filter: string,
  sortPriorities: ReadonlyMap<string, number>,
): number {
  if (filter) {
    const aExact = a.name.toLowerCase() === filter;
    const bExact = b.name.toLowerCase() === filter;
    if (aExact !== bExact) return aExact ? -1 : 1;
    const aPrefix = a.name.toLowerCase().startsWith(filter);
    const bPrefix = b.name.toLowerCase().startsWith(filter);
    if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
  }
  const priorityDiff = (sortPriorities.get(b.name) ?? 0) - (sortPriorities.get(a.name) ?? 0);
  if (priorityDiff !== 0) return priorityDiff;
  return a.name.localeCompare(b.name);
}

function getCommandSortPriority(command: MicaUiCommand): number {
  if (command.name !== 'task') return 0;
  return backgroundTaskItems.get().some((task) => isActiveBackgroundTaskStatus(task.status)) ? 1 : 0;
}

function buildDropdownItems(commands: MicaUiCommand[], parsedQuery: ParsedQuickCommandQuery): MicaUiDropdownItem[] {
  const items = commands.map((command) => commandToDropdownItem(command));
  if (commands.length !== 1) return items;

  const [command] = commands;
  if (!command) return items;

  const completions = resolveCompletionItems(command)
    .filter((item) => completionMatchesQuery(item, parsedQuery))
    .map((item) => completionItemToDropdownItem(command, item));
  return [...items, ...completions];
}

function commandToDropdownItem(command: MicaUiCommand): MicaUiDropdownItem {
  return {
    key: command.name,
    label: `/${command.name}`,
    description: command.description,
    commandName: command.name,
    insertText: `/${command.name} `,
  };
}

function completionItemToDropdownItem(command: MicaUiCommand, item: MicaUiCommandCompletionItem): MicaUiDropdownItem {
  const completionText = completionLabelText(item);
  return {
    key: `${command.name}:${completionText}`,
    label: `/${command.name} ${completionText}`,
    description: item.description,
    commandName: command.name,
    insertText: `/${command.name} ${item.arg}`,
  };
}

function resolveCompletionItems(command: MicaUiCommand): MicaUiCommandCompletionItem[] {
  try {
    const completionItems = typeof command.completionItems === 'function' ? command.completionItems() : command.completionItems;
    return completionItems ?? [];
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
  argFilter: string;
  hasArgs: boolean;
};

function parseQuickCommandQuery(query: string): ParsedQuickCommandQuery {
  const trimmedStart = query.trimStart();
  const commandToken = trimmedStart.match(/^\S*/)?.[0].toLowerCase() ?? '';
  const remainder = trimmedStart.slice(commandToken.length);
  const hasArgs = remainder.trim().length > 0;
  const argFilter = remainder.trim().toLowerCase();
  return {
    filter: hasArgs ? commandToken : trimmedStart.trimEnd().toLowerCase(),
    commandToken,
    argFilter,
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

function completionMatchesQuery(item: MicaUiCommandCompletionItem, query: ParsedQuickCommandQuery): boolean {
  if (!query.hasArgs || !query.argFilter) return true;
  const value = item.arg.toLowerCase();
  const label = item.label?.toLowerCase() ?? '';
  return value.includes(query.argFilter) || label.includes(query.argFilter);
}

function completionLabelText(item: MicaUiCommandCompletionItem): string {
  return item.label ?? item.arg;
}

function commandArg(raw: string, commandName: string): string | undefined {
  const trimmedStart = raw.trimStart();
  const arg = trimmedStart.slice(commandName.length).trim();
  return arg || undefined;
}

function selectedCommandArg(selected: MicaUiDropdownItem, commandName: string, raw: string): string | undefined {
  const selectedInsertText = selected.insertText?.trim();
  const selectedPrefix = `/${commandName}`;
  if (selectedInsertText && selectedInsertText.startsWith(selectedPrefix)) {
    const arg = selectedInsertText.slice(selectedPrefix.length).trim();
    if (arg) return arg;
  }
  return commandArg(raw, commandName);
}

