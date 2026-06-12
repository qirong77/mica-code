import type { Key } from '@anthropic/ink';
import type React from 'react';

// ── Theme ───────────────────────────────────────────────

export const C = {
  accent: '#D77757',
  primary: '#D77757',
  planMode: '#4A90D9',
  success: '#4CAF50',
  error: '#F44336',
  warning: '#FFD600',
  info: '#26C6DA',
  cyan: '#26C6DA',
  dim: '#7b7b7b',
  textSecondary: '#7b7b7b',
  border: '#26C6DA',
} as const;

// ── Quick commands ──────────────────────────────────────

export type { Command } from '../store/uiState.js';

// ── Input reducer types (shared with plugins) ──────────

export type InputState = { value: string; cursor: number };
export type InputAction =
  | { type: 'insert'; text: string }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'clear' }
  | { type: 'move'; cursor: number }
  | { type: 'set'; value: string; cursor: number };

// ── Extensible input handler plugin system ─────────────

/** Context passed to each registered input handler */
export interface InputContext {
  inputValue: string;
  cursorOffset: number;
  showDropdown: boolean;
  /** 0-based current line index */
  currentRow: number;
  /** Total number of lines */
  totalRows: number;
  dispatch: React.Dispatch<InputAction>;
}

/** An input handler receives the raw key event + context.
 *  Return `true` if the event was consumed (stop propagation). */
export type InputHandler = (char: string, key: Key, ctx: InputContext) => boolean;
