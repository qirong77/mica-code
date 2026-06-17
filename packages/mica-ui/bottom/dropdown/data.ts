import { atom } from 'nanostores';
import type { MicaUiDropdownState, MicaUiDropdownItem, MicaUiCommand } from '../../types.js';

export const state = atom<MicaUiDropdownState>({ visible: false, items: [], selectedIndex: 0 });
export const selection = atom<MicaUiDropdownItem | null>(null);
export const inputValue = atom('');
export const quickCommands = atom<MicaUiCommand[]>([]);

export function setQuickCommands(commands: MicaUiCommand[]): void {
  quickCommands.set(commands);
}

export function clearQuickCommands(): void {
  quickCommands.set([]);
}

export function setDropdownState(nextState: MicaUiDropdownState): void {
  state.set(nextState);
}

export function hideDropdown(): void {
  state.set({ visible: false, items: [], selectedIndex: 0 });
  selection.set(null);
  inputValue.set('');
}
