import { quickCommands, state, selection, inputValue } from './state.js';
import { disabled as inputDisabled } from '../../input/state.js';
import type { MicaUiDropdownItem } from '../../types.js';

let _emitSelect: ((item: MicaUiDropdownItem) => void) | null = null;

export function setSelectEmitter(emit: (item: MicaUiDropdownItem) => void): void {
  _emitSelect = emit;
}

export function showQuickCommands(query: string, includeHidden = false): void {
  const commands = quickCommands.get();
  const filter = query.toLowerCase();
  const filtered = commands.filter(
    (cmd) =>
      (includeHidden || !cmd.hidden) &&
      (cmd.name.toLowerCase().includes(filter) || cmd.description.toLowerCase().includes(filter)),
  );
  filtered.sort((a, b) => {
    if (filter) {
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
    cmd.action(raw.slice(cmd.name.length).trim() || undefined);
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
