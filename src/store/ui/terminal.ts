import { atom } from 'nanostores';

export interface DropdownItem {
  key: string;
  label: string;
  description?: string;
  suffix?: { text: string; color?: string };
}

export interface DropdownState {
  visible: boolean;
  items: DropdownItem[];
  selectedIndex: number;
  title?: string;
  emptyMessage?: string;
}

export const DEFAULT_INPUT_PLACEHOLDER = 'Type something and press Enter...';

export const terminalInput = {
  text: atom(''),
  disabled: atom(false),
  placeholder: atom(DEFAULT_INPUT_PLACEHOLDER),
};

export const dropdown = {
  state: atom<DropdownState>({ visible: false, items: [], selectedIndex: 0 }),
  selection: atom<DropdownItem | null>(null),
  inputValue: atom(''),
  cursor: atom(0),
};

export const inputBottomDistanceAtom = atom(0);
