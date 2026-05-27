import type { DropdownItem } from './CommandDropdown.js';
import { DropDownSelect } from './DropDownSelect.js';
import { dropdown } from '../../../../store/ui-state.js';
import {
  showQuickCommands,
  hideQuickCommands,
  handleDropdownKey,
  setSelectEmitter,
} from './quickCommandHandler.js';

// ── Types ──────────────────────────────────────────────

export type { DropdownItem, DropdownState } from '../../../../store/ui-state.js';

const _selectHandlers: Array<(item: DropdownItem) => void> = [];
setSelectEmitter((item: DropdownItem) => {
  for (const h of _selectHandlers) h(item);
});

export const DropDownUI = {
  renderFn: DropDownSelect,
  onSelect: (cb: (item: DropdownItem) => void) => {
    _selectHandlers.push(cb);
    return () => {
      const idx = _selectHandlers.indexOf(cb);
      if (idx !== -1) _selectHandlers.splice(idx, 1);
    };
  },
  atomData: {
    dropdown: dropdown.state,
    selection: dropdown.selection,
  },
  /** 快捷命令下拉菜单逻辑（由 TerminalInput 调用） */
  quickCommand: {
    show: showQuickCommands,
    hide: hideQuickCommands,
    handleKey: handleDropdownKey,
  },
};
