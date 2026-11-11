// Bounds apply before allocating a rectangular matrix or any Lexical nodes.
export const MAX_TABLE_CLIPBOARD_CELLS = 10_000;
export const MAX_TABLE_CLIPBOARD_TEXT_LENGTH = 1_048_576;
export const MAX_TABLE_CLIPBOARD_INLINE_BREAKS = 20_000;

export type TableClipboardMatrix = ReadonlyArray<ReadonlyArray<string>>;

export type TableClipboardParseResult =
  | {status: 'matrix'; matrix: string[][]}
  | {status: 'not-matrix' | 'invalid' | 'too-large'};

/**
 * Excel-style TSV, not CSV: only unquoted tabs make this a matrix. Quotes are
 * special only at the beginning of a field, and doubled quotes escape a quote.
 * CRLF/CR become LF, including inside a quoted cell. Exactly one final record
 * separator is ignored; explicit empty fields and additional blank rows remain.
 */
export function parseTableClipboard(text: string): TableClipboardParseResult {
  if (!text.includes('\t')) {
    return {status: 'not-matrix'};
  }
  if (text.length > MAX_TABLE_CLIPBOARD_TEXT_LENGTH) {
    return {status: 'too-large'};
  }

  const matrix: string[][] = [];
  let row: string[] = [];
  let value = '';
  let inQuotes = false;
  let afterQuote = false;
  let atFieldStart = true;
  let sawColumnSeparator = false;
  let endedWithRecordSeparator = false;
  let columns = 0;
  let inlineBreaks = 0;

  const finishField = (): boolean => {
    row.push(value);
    value = '';
    atFieldStart = true;
    afterQuote = false;
    columns = Math.max(columns, row.length);
    return columns * (matrix.length + 1) <= MAX_TABLE_CLIPBOARD_CELLS;
  };
  const finishRow = (): void => {
    matrix.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    endedWithRecordSeparator = false;
    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          value += '"';
          index++;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else if (character === '\r' || character === '\n' || character === '\t') {
        if (++inlineBreaks > MAX_TABLE_CLIPBOARD_INLINE_BREAKS) {
          return {status: 'too-large'};
        }
        value += character === '\t' ? '\t' : '\n';
        if (character === '\r' && text[index + 1] === '\n') {
          index++;
        }
      } else {
        value += character;
      }
      continue;
    }

    if (character === '\t' || character === '\r' || character === '\n') {
      if (!finishField()) {
        return {status: 'too-large'};
      }
      if (character === '\t') {
        sawColumnSeparator = true;
        // A separator promises another field, even at the very end of input.
        if ((row.length + 1) * (matrix.length + 1) > MAX_TABLE_CLIPBOARD_CELLS) {
          return {status: 'too-large'};
        }
      } else {
        finishRow();
        endedWithRecordSeparator = true;
        if (character === '\r' && text[index + 1] === '\n') {
          index++;
        }
      }
    } else if (afterQuote) {
      // Do not silently discard malformed quotes or unexpected suffixes.
      return {status: 'invalid'};
    } else if (character === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
    } else {
      value += character;
      atFieldStart = false;
    }
  }

  if (inQuotes) {
    return {status: 'invalid'};
  }
  if (!endedWithRecordSeparator) {
    if (!finishField()) {
      return {status: 'too-large'};
    }
    finishRow();
  }
  if (!sawColumnSeparator) {
    return {status: 'not-matrix'};
  }

  // Ragged TSV records have implicit empty trailing fields, not missing cells.
  for (const record of matrix) {
    while (record.length < columns) {
      record.push('');
    }
  }
  return {matrix, status: 'matrix'};
}
