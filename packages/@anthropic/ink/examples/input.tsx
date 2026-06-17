#!/usr/bin/env bun

/**
 * Input-demo.tsx — 独立简化的输入框实现
 *
 * 只处理：用户输入、光标渲染、上下边框样式
 * 去掉了所有主题、配置、状态管理、Voice、MCP、keybindings 等无关逻辑
 *
 * 运行: bun run src/screens/Input-demo.tsx
 */

// =============================================================================
// 1. 依赖
// =============================================================================
import React, { useCallback, useMemo, useState } from 'react';
import {
  Ansi,
  Box,
  Text,
  useInput,
  useDeclaredCursor,
  useTerminalFocus,
  stringWidth,
  wrapAnsi,
  wrappedRender,
} from '../src';

// =============================================================================
// 2. 工具函数 — grapheme 分段
// =============================================================================
let _graphemeSegmenter: Intl.Segmenter | null = null;
function getGraphemeSegmenter(): Intl.Segmenter {
  if (!_graphemeSegmenter) {
    _graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  }
  return _graphemeSegmenter;
}

let _wordSegmenter: Intl.Segmenter | null = null;
function getWordSegmenter(): Intl.Segmenter {
  if (!_wordSegmenter) {
    _wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  }
  return _wordSegmenter;
}

// =============================================================================
// 3. MeasuredText — 文字测量与换行
// =============================================================================
class WrappedLine {
  constructor(
    public readonly text: string,
    public readonly startOffset: number,
    public readonly isPrecededByNewline: boolean,
    public readonly endsWithNewline: boolean = false,
  ) {}
}

class MeasuredText {
  private _wrappedLines: WrappedLine[] | undefined;
  private _graphemeBoundaries: number[] | undefined;
  private _wordBoundariesCache: Array<{ start: number; end: number; isWordLike: boolean }> | undefined;
  private navigationCache = new Map<string, number>();

  constructor(
    public readonly text: string,
    readonly columns: number,
  ) {
    this.text = text.normalize('NFC');
  }

  private get wrappedLines(): WrappedLine[] {
    if (!this._wrappedLines) {
      this._wrappedLines = this.measureWrappedText();
    }
    return this._wrappedLines;
  }

  private getGraphemeBoundaries(): number[] {
    if (!this._graphemeBoundaries) {
      this._graphemeBoundaries = [];
      for (const { index } of getGraphemeSegmenter().segment(this.text)) {
        this._graphemeBoundaries.push(index);
      }
      this._graphemeBoundaries.push(this.text.length);
    }
    return this._graphemeBoundaries;
  }

  getWordBoundaries(): Array<{ start: number; end: number; isWordLike: boolean }> {
    if (!this._wordBoundariesCache) {
      this._wordBoundariesCache = [];
      for (const segment of getWordSegmenter().segment(this.text)) {
        this._wordBoundariesCache.push({
          start: segment.index,
          end: segment.index + segment.segment.length,
          isWordLike: segment.isWordLike ?? false,
        });
      }
    }
    return this._wordBoundariesCache;
  }

  private measureWrappedText(): WrappedLine[] {
    const wrappedText = wrapAnsi(this.text, this.columns, {
      hard: true,
      trim: false,
    });
    const wrappedLines: WrappedLine[] = [];
    let searchOffset = 0;
    let lastNewLinePos = -1;
    const lines = wrappedText.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!;
      const isPrecededByNewlineFn = (startOffset: number) =>
        i === 0 || (startOffset > 0 && this.text[startOffset - 1] === '\n');

      if (text.length === 0) {
        lastNewLinePos = this.text.indexOf('\n', lastNewLinePos + 1);
        if (lastNewLinePos !== -1) {
          wrappedLines.push(new WrappedLine(text, lastNewLinePos, isPrecededByNewlineFn(lastNewLinePos), true));
        } else {
          wrappedLines.push(new WrappedLine(text, this.text.length, isPrecededByNewlineFn(this.text.length), false));
        }
      } else {
        const startOffset = this.text.indexOf(text, searchOffset);
        if (startOffset === -1) throw new Error('Failed to find wrapped line in text');
        searchOffset = startOffset + text.length;
        const potentialNewlinePos = startOffset + text.length;
        const endsWithNewline = potentialNewlinePos < this.text.length && this.text[potentialNewlinePos] === '\n';
        if (endsWithNewline) lastNewLinePos = potentialNewlinePos;
        wrappedLines.push(new WrappedLine(text, startOffset, isPrecededByNewlineFn(startOffset), endsWithNewline));
      }
    }
    return wrappedLines;
  }

  getWrappedText(): string[] {
    return this.wrappedLines.map((line) => (line.isPrecededByNewline ? line.text : line.text.trimStart()));
  }

  get lineCount(): number {
    return this.wrappedLines.length;
  }

  getLineLength(line: number): number {
    return stringWidth(this.wrappedLines[Math.max(0, Math.min(line, this.wrappedLines.length - 1))]!.text);
  }

  nextOffset(offset: number): number {
    const key = `next:${offset}`;
    const cached = this.navigationCache.get(key);
    if (cached !== undefined) return cached;
    const boundaries = this.getGraphemeBoundaries();
    let lo = 0;
    let hi = boundaries.length - 1;
    let result = this.text.length;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const b = boundaries[mid]!;
      if (b > offset) {
        result = b;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }
    this.navigationCache.set(key, result);
    return result;
  }

  prevOffset(offset: number): number {
    if (offset <= 0) return 0;
    const key = `prev:${offset}`;
    const cached = this.navigationCache.get(key);
    if (cached !== undefined) return cached;
    const boundaries = this.getGraphemeBoundaries();
    let lo = 0;
    let hi = boundaries.length - 1;
    let result = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const b = boundaries[mid]!;
      if (b < offset) {
        result = b;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    this.navigationCache.set(key, result);
    return result;
  }

  snapToGraphemeBoundary(offset: number): number {
    if (offset <= 0) return 0;
    if (offset >= this.text.length) return this.text.length;
    const boundaries = this.getGraphemeBoundaries();
    let lo = 0;
    let hi = boundaries.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (boundaries[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return boundaries[lo]!;
  }

  stringIndexToDisplayWidth(text: string, index: number): number {
    if (index <= 0) return 0;
    if (index >= text.length) return stringWidth(text);
    return stringWidth(text.substring(0, index));
  }

  displayWidthToStringIndex(text: string, targetWidth: number): number {
    if (targetWidth <= 0) return 0;
    if (!text) return 0;
    if (text === this.text) return this.offsetAtDisplayWidth(targetWidth);
    let currentWidth = 0;
    let currentOffset = 0;
    for (const { segment, index } of getGraphemeSegmenter().segment(text)) {
      const sw = stringWidth(segment);
      if (currentWidth + sw > targetWidth) break;
      currentWidth += sw;
      currentOffset = index + segment.length;
    }
    return currentOffset;
  }

  private offsetAtDisplayWidth(targetWidth: number): number {
    if (targetWidth <= 0) return 0;
    let currentWidth = 0;
    const boundaries = this.getGraphemeBoundaries();
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i]!;
      const end = boundaries[i + 1]!;
      const segment = this.text.substring(start, end);
      const sw = stringWidth(segment);
      if (currentWidth + sw > targetWidth) return start;
      currentWidth += sw;
    }
    return this.text.length;
  }

  getPositionFromOffset(offset: number): { line: number; column: number } {
    const lines = this.wrappedLines;
    for (let line = 0; line < lines.length; line++) {
      const currentLine = lines[line]!;
      const nextLine = lines[line + 1];
      if (offset >= currentLine.startOffset && (!nextLine || offset < nextLine.startOffset)) {
        const stringPosInLine = offset - currentLine.startOffset;
        let displayColumn: number;
        if (currentLine.isPrecededByNewline) {
          displayColumn = this.stringIndexToDisplayWidth(currentLine.text, stringPosInLine);
        } else {
          const leadingWs = currentLine.text.length - currentLine.text.trimStart().length;
          if (stringPosInLine < leadingWs) {
            displayColumn = 0;
          } else {
            const trimmed = currentLine.text.trimStart();
            const posInTrimmed = stringPosInLine - leadingWs;
            displayColumn = this.stringIndexToDisplayWidth(trimmed, posInTrimmed);
          }
        }
        return { line, column: Math.max(0, displayColumn) };
      }
    }
    const lastLine = lines[lines.length - 1]!;
    return { line: lines.length - 1, column: stringWidth(lastLine.text) };
  }

  getOffsetFromPosition(position: { line: number; column: number }): number {
    const wrappedLine = this.wrappedLines[Math.max(0, Math.min(position.line, this.wrappedLines.length - 1))]!;
    if (wrappedLine.text.length === 0 && wrappedLine.endsWithNewline) {
      return wrappedLine.startOffset;
    }
    const leadingWs = wrappedLine.isPrecededByNewline
      ? 0
      : wrappedLine.text.length - wrappedLine.text.trimStart().length;
    const displayColumnWithLeading = position.column + leadingWs;
    const stringIndex = this.displayWidthToStringIndex(wrappedLine.text, displayColumnWithLeading);
    const offset = wrappedLine.startOffset + stringIndex;
    const lineEnd = wrappedLine.startOffset + wrappedLine.text.length;
    let maxOffset = lineEnd;
    const lineDisplayWidth = stringWidth(wrappedLine.text);
    if (wrappedLine.endsWithNewline && position.column > lineDisplayWidth) {
      maxOffset = lineEnd + 1;
    }
    return Math.min(offset, maxOffset);
  }

  getViewportStartLine(maxVisibleLines: number | undefined, offset: number): number {
    if (maxVisibleLines === undefined || maxVisibleLines <= 0) return 0;
    const pos = this.getPositionFromOffset(offset);
    const allLines = this.wrappedLines;
    if (allLines.length <= maxVisibleLines) return 0;
    const half = Math.floor(maxVisibleLines / 2);
    let startLine = Math.max(0, pos.line - half);
    const endLine = Math.min(allLines.length, startLine + maxVisibleLines);
    if (endLine - startLine < maxVisibleLines) {
      startLine = Math.max(0, endLine - maxVisibleLines);
    }
    return startLine;
  }
}

// =============================================================================
// 4. Cursor — 光标操作
// =============================================================================
class Cursor {
  constructor(
    readonly measuredText: MeasuredText,
    readonly offset: number = 0,
  ) {}

  static fromText(text: string, columns: number, offset: number = 0): Cursor {
    return new Cursor(new MeasuredText(text, columns - 1), offset);
  }

  get text(): string {
    return this.measuredText.text;
  }

  private get columns(): number {
    return this.measuredText.columns + 1;
  }

  getPosition(): { line: number; column: number } {
    return this.measuredText.getPositionFromOffset(this.offset);
  }

  isAtStart(): boolean {
    return this.offset === 0;
  }

  isAtEnd(): boolean {
    return this.offset >= this.text.length;
  }

  equals(other: Cursor): boolean {
    return this.offset === other.offset && this.measuredText === other.measuredText;
  }

  left(): Cursor {
    if (this.offset === 0) return this;
    return new Cursor(this.measuredText, this.measuredText.prevOffset(this.offset));
  }

  right(): Cursor {
    if (this.offset >= this.text.length) return this;
    return new Cursor(this.measuredText, Math.min(this.measuredText.nextOffset(this.offset), this.text.length));
  }

  up(): Cursor {
    const { line, column } = this.getPosition();
    if (line === 0) return this;
    const prevLine = this.measuredText.getWrappedText()[line - 1];
    if (!prevLine) return this;
    const prevWidth = stringWidth(prevLine);
    const col = column > prevWidth ? prevWidth : column;
    return new Cursor(this.measuredText, this.measuredText.getOffsetFromPosition({ line: line - 1, column: col }));
  }

  down(): Cursor {
    const { line, column } = this.getPosition();
    if (line >= this.measuredText.lineCount - 1) return this;
    const nextLine = this.measuredText.getWrappedText()[line + 1];
    if (!nextLine) return this;
    const nextWidth = stringWidth(nextLine);
    const col = column > nextWidth ? nextWidth : column;
    return new Cursor(this.measuredText, this.measuredText.getOffsetFromPosition({ line: line + 1, column: col }));
  }

  startOfLine(): Cursor {
    const { line, column } = this.getPosition();
    if (column === 0 && line > 0) {
      return new Cursor(this.measuredText, this.measuredText.getOffsetFromPosition({ line: line - 1, column: 0 }));
    }
    return new Cursor(this.measuredText, this.measuredText.getOffsetFromPosition({ line, column: 0 }));
  }

  endOfLine(): Cursor {
    const { line } = this.getPosition();
    const col = this.measuredText.getLineLength(line);
    return new Cursor(this.measuredText, this.measuredText.getOffsetFromPosition({ line, column: col }));
  }

  prevWord(): Cursor {
    if (this.isAtStart()) return this;
    const boundaries = this.measuredText.getWordBoundaries();
    let prevWordStart: number | null = null;
    for (const b of boundaries) {
      if (!b.isWordLike) continue;
      if (b.start < this.offset) {
        if (this.offset > b.start && this.offset <= b.end) return new Cursor(this.measuredText, b.start);
        prevWordStart = b.start;
      }
    }
    return prevWordStart !== null ? new Cursor(this.measuredText, prevWordStart) : new Cursor(this.measuredText, 0);
  }

  nextWord(): Cursor {
    if (this.isAtEnd()) return this;
    const boundaries = this.measuredText.getWordBoundaries();
    for (const b of boundaries) {
      if (b.isWordLike && b.start > this.offset) return new Cursor(this.measuredText, b.start);
    }
    return new Cursor(this.measuredText, this.text.length);
  }

  insert(insertString: string): Cursor {
    const newText = this.text.slice(0, this.offset) + insertString + this.text.slice(this.offset);
    return Cursor.fromText(newText, this.columns, this.offset + insertString.normalize('NFC').length);
  }

  del(): Cursor {
    if (this.isAtEnd()) return this;
    return this.modifyText(this.right());
  }

  backspace(): Cursor {
    if (this.isAtStart()) return this;
    return this.left().modifyText(this);
  }

  private modifyText(end: Cursor, insertString: string = ''): Cursor {
    const newText = this.text.slice(0, this.offset) + insertString + this.text.slice(end.offset);
    return Cursor.fromText(newText, this.columns, this.offset + insertString.length);
  }

  deleteToLineStart(): { cursor: Cursor; killed: string } {
    if (this.offset > 0 && this.text[this.offset - 1] === '\n') {
      return { cursor: this.left().modifyText(this), killed: '\n' };
    }
    const startCursor = this.startOfLine();
    const killed = this.text.slice(startCursor.offset, this.offset);
    return { cursor: startCursor.modifyText(this), killed };
  }

  deleteToLineEnd(): { cursor: Cursor; killed: string } {
    if (this.text[this.offset] === '\n') {
      return { cursor: this.modifyText(this.right()), killed: '\n' };
    }
    const endCursor = this.endOfLine();
    const killed = this.text.slice(this.offset, endCursor.offset);
    return { cursor: this.modifyText(endCursor), killed };
  }

  deleteWordBefore(): { cursor: Cursor; killed: string } {
    if (this.isAtStart()) return { cursor: this, killed: '' };
    const target = this.prevWord().offset;
    const prevWordCursor = new Cursor(this.measuredText, target);
    const killed = this.text.slice(prevWordCursor.offset, this.offset);
    return { cursor: prevWordCursor.modifyText(this), killed };
  }

  deleteWordAfter(): Cursor {
    if (this.isAtEnd()) return this;
    return this.modifyText(new Cursor(this.measuredText, this.nextWord().offset));
  }

  render(cursorChar: string, invert: (text: string) => string, maxVisibleLines?: number): string {
    const { line, column } = this.getPosition();
    const allLines = this.measuredText.getWrappedText();
    const startLine = this.measuredText.getViewportStartLine(maxVisibleLines, this.offset);
    const endLine =
      maxVisibleLines !== undefined && maxVisibleLines > 0
        ? Math.min(allLines.length, startLine + maxVisibleLines)
        : allLines.length;

    return allLines
      .slice(startLine, endLine)
      .map((text, i) => {
        const currentLine = i + startLine;
        let beforeCursor = '';
        let atCursor = cursorChar;
        let afterCursor = '';
        let currentWidth = 0;
        let cursorFound = false;

        if (line !== currentLine) return text.trimEnd();

        for (const { segment } of getGraphemeSegmenter().segment(text)) {
          if (cursorFound) {
            afterCursor += segment;
            continue;
          }
          const nextWidth = currentWidth + stringWidth(segment);
          if (nextWidth > column) {
            atCursor = segment;
            cursorFound = true;
          } else {
            currentWidth = nextWidth;
            beforeCursor += segment;
          }
        }

        const renderedCursor = cursorChar ? invert(atCursor) : atCursor;
        return beforeCursor + renderedCursor + afterCursor.trimEnd();
      })
      .join('\n');
  }

  getViewportCharOffset(maxVisibleLines?: number): number {
    const startLine = this.measuredText.getViewportStartLine(maxVisibleLines, this.offset);
    return startLine === 0 ? 0 : 0;
  }

  getViewportCharEnd(maxVisibleLines?: number): number {
    if (maxVisibleLines === undefined || maxVisibleLines <= 0) return this.text.length;
    return this.text.length;
  }
}

// =============================================================================
// 5. useTextInput — 输入处理 hook
// =============================================================================

function buildTextHandler({
  value,
  onChange,
  onSubmit,
  onExit,
  onHistoryUp,
  onHistoryDown,
  multiline,
  cursorChar,
  invert,
  columns,
  externalOffset,
  onOffsetChange,
  maxVisibleLines,
  disableCursorMovementForUpDownKeys,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onExit?: () => void;
  onHistoryUp?: () => void;
  onHistoryDown?: () => void;
  multiline: boolean;
  cursorChar: string;
  invert: (text: string) => string;
  columns: number;
  externalOffset: number;
  onOffsetChange: (offset: number) => void;
  maxVisibleLines?: number;
  disableCursorMovementForUpDownKeys: boolean;
}): { onInput: (input: string, key: any) => void; renderedValue: string; cursorLine: number; cursorColumn: number } {
  const offset = externalOffset;
  const setOffset = onOffsetChange;
  const cursor = Cursor.fromText(value, columns, offset);

  function handleEnter(key: any) {
    if (multiline && cursor.offset > 0 && cursor.text[cursor.offset - 1] === '\\') {
      return cursor.backspace().insert('\n');
    }
    if (key.meta || key.shift) {
      return cursor.insert('\n');
    }
    onSubmit?.(value);
  }

  function upOrHistoryUp() {
    if (disableCursorMovementForUpDownKeys) {
      onHistoryUp?.();
      return cursor;
    }
    const cursorUp = cursor.up();
    if (!cursorUp.equals(cursor)) return cursorUp;
    if (multiline) {
      const cursorUpLogical = cursor.up();
      if (!cursorUpLogical.equals(cursor)) return cursorUpLogical;
    }
    onHistoryUp?.();
    return cursor;
  }

  function downOrHistoryDown() {
    if (disableCursorMovementForUpDownKeys) {
      onHistoryDown?.();
      return cursor;
    }
    const cursorDown = cursor.down();
    if (!cursorDown.equals(cursor)) return cursorDown;
    if (multiline) {
      const cursorDownLogical = cursor.down();
      if (!cursorDownLogical.equals(cursor)) return cursorDownLogical;
    }
    onHistoryDown?.();
    return cursor;
  }

  function onInput(input: string, key: any): void {
    // Ctrl+C: clear input or exit
    if (key.ctrl && input === 'c') {
      if (value) {
        onChange('');
        setOffset(0);
      } else {
        onExit?.();
      }
      return;
    }

    // Build cursor operation from key
    let nextCursor: Cursor | void;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (key.escape) {
        nextCursor = cursor;
        break;
      }
      if (key.leftArrow && (key.ctrl || key.meta)) {
        nextCursor = cursor.prevWord();
        break;
      }
      if (key.rightArrow && (key.ctrl || key.meta)) {
        nextCursor = cursor.nextWord();
        break;
      }
      if (key.backspace) {
        nextCursor = key.meta || key.ctrl ? cursor.deleteWordBefore().cursor : cursor.backspace();
        break;
      }
      if (key.delete) {
        nextCursor = key.meta ? cursor.deleteToLineEnd().cursor : cursor.del();
        break;
      }
      if (key.home) {
        nextCursor = cursor.startOfLine();
        break;
      }
      if (key.end) {
        nextCursor = cursor.endOfLine();
        break;
      }
      if (key.return) {
        nextCursor = handleEnter(key);
        break;
      }
      if (key.tab) {
        nextCursor = cursor.insert('    ');
        break;
      }
      if (key.upArrow && !key.shift) {
        nextCursor = upOrHistoryUp();
        break;
      }
      if (key.downArrow && !key.shift) {
        nextCursor = downOrHistoryDown();
        break;
      }
      if (key.leftArrow) {
        nextCursor = cursor.left();
        break;
      }
      if (key.rightArrow) {
        nextCursor = cursor.right();
        break;
      }

      // Ctrl key sequences
      if (key.ctrl) {
        switch (input) {
          case 'a':
            nextCursor = cursor.startOfLine();
            break;
          case 'b':
            nextCursor = cursor.left();
            break;
          case 'd':
            nextCursor = cursor.del();
            break;
          case 'e':
            nextCursor = cursor.endOfLine();
            break;
          case 'f':
            nextCursor = cursor.right();
            break;
          case 'h':
            nextCursor = cursor.backspace();
            break;
          case 'k':
            nextCursor = cursor.deleteToLineEnd().cursor;
            break;
          case 'n':
            nextCursor = downOrHistoryDown();
            break;
          case 'p':
            nextCursor = upOrHistoryUp();
            break;
          case 'u':
            nextCursor = cursor.deleteToLineStart().cursor;
            break;
          case 'w':
            nextCursor = cursor.deleteWordBefore().cursor;
            break;
          default:
            nextCursor = cursor;
            break;
        }
        break;
      }

      // Meta key sequences
      if (key.meta) {
        switch (input) {
          case 'b':
            nextCursor = cursor.prevWord();
            break;
          case 'f':
            nextCursor = cursor.nextWord();
            break;
          case 'd':
            nextCursor = cursor.deleteWordAfter();
            break;
          default:
            nextCursor = cursor;
            break;
        }
        break;
      }

      // Default: insert character
      const text = input.replace(/\r/g, '\n');
      nextCursor = cursor.insert(text);
      break;
    }

    if (nextCursor && nextCursor instanceof Cursor) {
      if (!cursor.equals(nextCursor)) {
        if (cursor.text !== nextCursor.text) {
          onChange(nextCursor.text);
        }
        setOffset(nextCursor.offset);
      }
    }
  }

  const cursorPos = cursor.getPosition();
  const startLine = cursor.measuredText.getViewportStartLine(maxVisibleLines, cursor.offset);

  return {
    onInput,
    renderedValue: cursor.render(cursorChar, invert, maxVisibleLines),
    cursorLine: cursorPos.line - startLine,
    cursorColumn: cursorPos.column,
  };
}

// =============================================================================
// 6. SimpleTextInput 组件
// =============================================================================
interface SimpleTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onExit?: () => void;
  focus?: boolean;
  multiline?: boolean;
  placeholder?: string;
  columns: number;
  cursorOffset: number;
  onChangeCursorOffset: (offset: number) => void;
  maxVisibleLines?: number;
  onHistoryUp?: () => void;
  onHistoryDown?: () => void;
  showCursor?: boolean;
}

function SimpleTextInput(props: SimpleTextInputProps): React.ReactNode {
  const terminalFocus = useTerminalFocus();

  const invert = useCallback((text: string) => {
    return `\x1b[7m${text}\x1b[27m`;
  }, []);

  const state = buildTextHandler({
    value: props.value,
    onChange: props.onChange,
    onSubmit: props.onSubmit,
    onExit: props.onExit,
    onHistoryUp: props.onHistoryUp,
    onHistoryDown: props.onHistoryDown,
    multiline: props.multiline ?? true,
    cursorChar: ' ',
    invert,
    columns: props.columns,
    externalOffset: props.cursorOffset,
    onOffsetChange: props.onChangeCursorOffset,
    maxVisibleLines: props.maxVisibleLines,
    disableCursorMovementForUpDownKeys: false,
  });

  const cursorRef = useDeclaredCursor({
    line: state.cursorLine,
    column: state.cursorColumn,
    active: Boolean(props.focus && props.showCursor !== false && terminalFocus),
  });

  useInput(state.onInput, { isActive: props.focus });

  const showPlaceholder = props.value.length === 0 && props.placeholder;

  return (
    <Box ref={cursorRef}>
      <Text wrap="truncate-end">
        {showPlaceholder ? (
          <Text dimColor>
            {props.placeholder!.length > 0 ? (
              <>
                <Text inverse>{props.placeholder![0]}</Text>
                <Text dimColor>{props.placeholder!.slice(1)}</Text>
              </>
            ) : (
              <Text inverse> </Text>
            )}
          </Text>
        ) : (
          <Ansi>{state.renderedValue}</Ansi>
        )}
      </Text>
    </Box>
  );
}

// =============================================================================
// 7. InputDemo 主组件
// =============================================================================
function InputDemo(): React.ReactNode {
  const [input, setInput] = useState('');
  const [cursorOffset, setCursorOffset] = useState(0);
  const [submittedMessage, setSubmittedMessage] = useState('');
  const [prevInputs, setPrevInputs] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const columns = process.stdout.columns - 6;

  const onSubmit = useCallback((value: string) => {
    if (value.trim()) {
      const trimmed = value.trim();
      console.log(`You typed: ${trimmed}`);
      setPrevInputs((prev) => [...prev, trimmed]);
      setHistoryIndex(-1);
      setInput('');
      setCursorOffset(0);
      setSubmittedMessage(trimmed);
      setTimeout(() => setSubmittedMessage(''), 2000);
    }
  }, []);

  const onExit = useCallback(() => {
    process.exit(0);
  }, []);

  const handleChange = useCallback((value: string) => {
    setInput(value);
  }, []);

  const onHistoryUp = useCallback(() => {
    if (prevInputs.length === 0) return;
    const newIndex = historyIndex < prevInputs.length - 1 ? historyIndex + 1 : historyIndex;
    if (newIndex !== historyIndex) {
      setHistoryIndex(newIndex);
      const val = prevInputs[prevInputs.length - 1 - newIndex]!;
      setInput(val);
      setCursorOffset(val.length);
    }
  }, [historyIndex, prevInputs]);

  const onHistoryDown = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      const val = prevInputs[prevInputs.length - 1 - newIndex]!;
      setInput(val);
      setCursorOffset(val.length);
    } else if (historyIndex === 0) {
      setHistoryIndex(-1);
      setInput('');
      setCursorOffset(0);
    }
  }, [historyIndex, prevInputs]);

  return (
    <Box flexDirection="column" marginTop={1}>
      {submittedMessage && (
        <Box marginLeft={2} marginBottom={1}>
          <Text dimColor>✓ Submitted: {submittedMessage}</Text>
        </Box>
      )}

      {/* Input box with top border only (borderBottom renders the bottom line of the border) */}
      <Box
        flexDirection="row"
        alignItems="flex-start"
        justifyContent="flex-start"
        borderStyle="round"
        borderLeft={false}
        borderRight={false}
        borderBottom
        width="100%"
      >
        <Box marginLeft={1} marginRight={1}>
          <Text color="#D77757">&gt;</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <SimpleTextInput
            value={input}
            onChange={handleChange}
            onSubmit={onSubmit}
            onExit={onExit}
            focus={true}
            multiline={true}
            placeholder="Type something and press Enter..."
            columns={columns}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            onHistoryUp={onHistoryUp}
            onHistoryDown={onHistoryDown}
          />
        </Box>
      </Box>

      {/* Bottom bar with hints */}
      <Box marginLeft={2} marginTop={1}>
        <Text dimColor>Enter=submit · Esc=clear · ↑↓=history · Ctrl+C=exit</Text>
      </Box>
    </Box>
  );
}

// =============================================================================
// 8. Entry point
// =============================================================================
const instance = await wrappedRender(<InputDemo />);
await instance.waitUntilExit();
