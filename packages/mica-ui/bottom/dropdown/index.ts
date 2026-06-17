import type { MicaUiDropdownItem } from '../../types.js';
import { DropDownSelect } from './DropDownSelect.js';
import { state, selection } from './data.js';
import { showQuickCommands, hideQuickCommands, handleDropdownKey, setSelectEmitter } from './quickCommandHandler.js';

const _selectHandlers: Array<(item: MicaUiDropdownItem) => void> = [];
setSelectEmitter((item: MicaUiDropdownItem) => {
  for (const h of _selectHandlers) h(item);
});

export const DropDownUI = {
  renderFn: DropDownSelect,
  onSelect: (cb: (item: MicaUiDropdownItem) => void) => {
    _selectHandlers.push(cb);
    return () => {
      const idx = _selectHandlers.indexOf(cb);
      if (idx !== -1) _selectHandlers.splice(idx, 1);
    };
  },
  atomData: { dropdown: state, selection },
  quickCommand: { show: showQuickCommands, hide: hideQuickCommands, handleKey: handleDropdownKey },
};
