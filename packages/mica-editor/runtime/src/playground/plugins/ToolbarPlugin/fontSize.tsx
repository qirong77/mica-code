/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import './fontSize.css';

import { type LexicalEditor } from 'lexical';
import * as React from 'react';

import { MAX_ALLOWED_FONT_SIZE, MIN_ALLOWED_FONT_SIZE } from '../../context/ToolbarContext';
import DropDown, { DropDownItem } from '../../ui/DropDown';
import { isKeyboardInput } from '../../utils/focusUtils';
import { updateFontSizeInSelection } from './utils';
import { FONT_SIZE_PRESETS } from './typography';

function parseFontSize(input: string): [number, string] | null {
  const match = input.match(/^(\d+(?:\.\d+)?)(px|pt)$/);
  return match ? [Number(match[1]), match[2]] : null;
}

function normalizeToPx(fontSize: number, unit: string): number {
  return unit === 'pt' ? Math.round((fontSize * 4) / 3) : fontSize;
}

function isValidFontSize(fontSizePx: number): boolean {
  return fontSizePx >= MIN_ALLOWED_FONT_SIZE && fontSizePx <= MAX_ALLOWED_FONT_SIZE;
}

export function parseFontSizeForToolbar(input: string): string {
  const parsed = parseFontSize(input);
  if (!parsed) {
    return '';
  }

  const [fontSize, unit] = parsed;
  const fontSizePx = normalizeToPx(fontSize, unit);
  return `${fontSizePx}px`;
}

export function parseAllowedFontSize(input: string): string {
  const parsed = parseFontSize(input);
  if (!parsed) {
    return '';
  }

  const [fontSize, unit] = parsed;
  const fontSizePx = normalizeToPx(fontSize, unit);
  return isValidFontSize(fontSizePx) ? input : '';
}

export default function FontSize({
  selectionFontSize,
  disabled,
  editor,
}: {
  selectionFontSize: string;
  disabled: boolean;
  editor: LexicalEditor;
}) {
  const [inputValue, setInputValue] = React.useState(selectionFontSize);
  const [dirty, setDirty] = React.useState(false);

  const commit = (value: string, skipRefocus = false) => {
    const size = Number(value);
    if (!value.trim() || !Number.isFinite(size) || size <= 0) {
      setInputValue(selectionFontSize);
      setDirty(false);
      return;
    }
    const nextSize = Math.min(MAX_ALLOWED_FONT_SIZE, Math.max(MIN_ALLOWED_FONT_SIZE, size));
    setInputValue(String(nextSize));
    setDirty(false);
    updateFontSizeInSelection(editor, `${nextSize}px`, null, skipRefocus);
  };

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInputValue(selectionFontSize);
    setDirty(false);
  }, [selectionFontSize]);

  return (
    <>
      <input
        type="text"
        inputMode="decimal"
        title="字号（可输入自定义值）"
        aria-label="字号"
        value={inputValue}
        disabled={disabled}
        className="toolbar-item font-size-input"
        autoComplete="off"
        onChange={(event) => {
          setInputValue(event.target.value);
          setDirty(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit(inputValue, true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setInputValue(selectionFontSize);
            setDirty(false);
          }
        }}
        onBlur={() => {
          if (dirty) commit(inputValue, true);
        }}
      />
      <span className="font-size-unit" aria-hidden="true">px</span>
      <DropDown disabled={disabled} buttonClassName="toolbar-item font-size-presets" buttonAriaLabel="选择字号">
        {FONT_SIZE_PRESETS.map((size) => (
          <DropDownItem
            key={size}
            className={`item fontsize-item${String(size) === selectionFontSize ? ' active dropdown-item-active' : ''}`}
            onClick={(event) => commit(String(size), isKeyboardInput(event))}
          >
            <span className="text">{size}</span>
          </DropDownItem>
        ))}
      </DropDown>
    </>
  );
}
