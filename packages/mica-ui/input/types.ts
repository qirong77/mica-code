import type { Key } from '@anthropic/ink';
import type React from 'react';

export type InputState = { value: string; cursor: number };

export type InputAction =
  | { type: 'insert'; text: string }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'clear' }
  | { type: 'move'; cursor: number }
  | { type: 'set'; value: string; cursor: number };

export interface InputContext {
  inputValue: string;
  cursorOffset: number;
  showDropdown: boolean;
  currentRow: number;
  totalRows: number;
  dispatch: React.Dispatch<InputAction>;
}

export type InputHandler = (char: string, key: Key, context: InputContext) => boolean;
