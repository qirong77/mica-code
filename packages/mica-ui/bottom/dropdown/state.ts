import { atom } from 'nanostores';
import type { MicaUiDropdownState, MicaUiDropdownItem, MicaUiCommand } from '../../types.js';

export const state = atom<MicaUiDropdownState>({ visible: false, items: [], selectedIndex: 0 });
export const selection = atom<MicaUiDropdownItem | null>(null);
export const inputValue = atom('');
export const rawInputValue = atom('');
export const quickCommands = atom<MicaUiCommand[]>([]);

export function setQuickCommands(commands: MicaUiCommand[]): void {
  quickCommands.set(commands);
}
