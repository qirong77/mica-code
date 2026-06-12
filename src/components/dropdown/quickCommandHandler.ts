/**
 * quickCommandHandler.ts — 快捷命令下拉菜单的逻辑处理
 *
 * 由 TerminalInput 调用，负责：
 * - 检测 '/' 输入 → 显示/过滤快捷命令列表
 * - 处理键盘事件（Escape/Tab/↑↓/Enter）当菜单可见时
 * - 管理 dropdown.state / terminalInput.disabled
 */

import {
  quickCommandsAtom,
  dropdown,
  terminalInput,
  type DropdownItem,
} from '../../store/ui-state.js';

// ── Emitter ref（由 index.ts 注入，避免循环引用）─────────

let _emitSelect: ((item: DropdownItem) => void) | null = null;

/** 由 DropDown/index.ts 调用，注入 select 事件发射器 */
export function setSelectEmitter(emit: (item: DropdownItem) => void): void {
  _emitSelect = emit;
}

// ── 公共 API ──────────────────────────────────────────

/** TerminalInput 在 handleChange 中调用：当输入以 '/' 开头时 */
export function showQuickCommands(query: string, includeHidden = false): void {
  const commands = quickCommandsAtom.get();
  const filter = query.toLowerCase();
  const filtered = commands.filter(
    (cmd) =>
      (includeHidden || !cmd.hidden) &&
      (cmd.name.toLowerCase().includes(filter) ||
        cmd.description.toLowerCase().includes(filter)),
  );

  filtered.sort((a, b) => {
    if (filter) {
      const aPrefix = a.name.toLowerCase().startsWith(filter);
      const bPrefix = b.name.toLowerCase().startsWith(filter);
      if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  const items: DropdownItem[] = filtered.map((cmd) => ({
    key: cmd.name,
    label: `/${cmd.name}`,
    description: cmd.description,
  }));

  dropdown.inputValue.set(query);
  dropdown.state.set({
    visible: true,
    items,
    selectedIndex: 0,
    title: '',
    emptyMessage: 'no matching commands',
  });
  terminalInput.disabled.set(true);
}

/** TerminalInput 在 handleChange 中调用：当输入不再以 '/' 开头 */
export function hideQuickCommands(): void {
  const state = dropdown.state.get();
  if (!state.visible) return;

  dropdown.state.set({ visible: false, items: [], selectedIndex: 0 });
  dropdown.selection.set(null);
  dropdown.inputValue.set('');
  terminalInput.disabled.set(false);
}

/**
 * TerminalInput 的 useInput 中调用：处理快捷命令下拉菜单的键盘事件。
 * 返回 true 表示事件已被消费（TerminalInput 不应继续处理）。
 */
export function handleDropdownKey(key: {
  escape?: boolean;
  tab?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  shift?: boolean;
}): boolean {
  const state = dropdown.state.get();
  if (!state.visible || state.items.length === 0) return false;

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

// ── 内部辅助 ──────────────────────────────────────────

function closeAndClear(): void {
  dropdown.state.set({ visible: false, items: [], selectedIndex: 0 });
  dropdown.selection.set(null);
  dropdown.inputValue.set('');
  terminalInput.disabled.set(false);
}

function executeSelected(): void {
  const state = dropdown.state.get();
  if (!state.visible || state.items.length === 0) return;

  const idx = Math.min(state.selectedIndex, state.items.length - 1);
  const selected = state.items[idx];
  if (!selected) return;

  const commands = quickCommandsAtom.get();
  const cmd = commands.find((c) => c.name === selected.key);

  if (cmd) {
    const beforeItems = dropdown.state.get().items;
    const raw = dropdown.inputValue.get();
    const remainder = raw.slice(cmd.name.length).trim();
    cmd.action(remainder || undefined);
    const after = dropdown.state.get();

    // 如果 action 没有变更 dropdown 内容（如 /clear），则关闭下拉列表
    if (after.visible && after.items === beforeItems) {
      closeAndClear();
    }
    return;
  }

  dropdown.selection.set(selected);
  if (_emitSelect) {
    _emitSelect(selected);
  }
  closeAndClear();
}

function navigateDropdown(direction: 1 | -1): void {
  const state = dropdown.state.get();
  if (!state.visible || state.items.length === 0) return;

  const len = state.items.length;
  const newIndex =
    direction === -1
      ? state.selectedIndex > 0
        ? state.selectedIndex - 1
        : len - 1
      : state.selectedIndex < len - 1
        ? state.selectedIndex + 1
        : 0;

  dropdown.state.set({ ...state, selectedIndex: newIndex });
}
