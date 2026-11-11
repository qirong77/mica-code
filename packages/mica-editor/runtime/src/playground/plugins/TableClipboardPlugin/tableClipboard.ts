import {
  $computeTableMap,
  $createTableCellNode,
  $createTableRowNode,
  $getTableCellNodeFromLexicalNode,
  $insertTableRowAtNode,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  $isTableSelection,
  TableCellHeaderStates,
  type TableCellNode,
  type TableNode,
  type TableRowNode,
} from '@lexical/table';
import {
  $createParagraphNode,
  $generateNodesFromRawText,
  $getSelection,
  $isElementNode,
  $isEventFromEmbeddedInput,
  $isRangeSelection,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_HIGH,
  KEY_TAB_COMMAND,
  type LexicalEditor,
  mergeRegister,
  PASTE_COMMAND,
  type PasteCommandType,
} from 'lexical';

import {
  MAX_TABLE_CLIPBOARD_CELLS,
  MAX_TABLE_CLIPBOARD_INLINE_BREAKS,
  MAX_TABLE_CLIPBOARD_TEXT_LENGTH,
  parseTableClipboard,
  type TableClipboardMatrix,
} from './parseTableClipboard';

export const TABLE_CLIPBOARD_LIMIT_MESSAGE =
  '粘贴内容过大：单次最多 10,000 个单元格、约 100 万字符，且不能含过多单元格内换行或制表符。请分批粘贴。';
export const TABLE_CAPACITY_LIMIT_MESSAGE =
  '操作后表格将超过 10,000 个单元格的安全上限，请拆分为多个表格。';

export type TableClipboardWarning = (message: string) => void;
export type TableMatrixPasteResult = 'handled' | 'unhandled' | 'too-large';

function $getSelectionTableContext() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) && !$isTableSelection(selection)) {
    return null;
  }
  const anchorCell = $getTableCellNodeFromLexicalNode(selection.anchor.getNode());
  const focusCell = $getTableCellNodeFromLexicalNode(selection.focus.getNode());
  const anchorRow = anchorCell?.getParent();
  const focusRow = focusCell?.getParent();
  const table = anchorRow?.getParent();
  if (
    !anchorCell || !focusCell ||
    !$isTableRowNode(anchorRow) || !$isTableRowNode(focusRow) ||
    !$isTableNode(table) || !table.is(focusRow.getParent()) ||
    ($isTableSelection(selection) && selection.tableKey !== table.getKey())
  ) {
    return null;
  }
  return {anchorCell, focusCell, selection, table};
}

/** Read only direct children: a nested table must never become part of this grid. */
function $getSimpleTableGrid(table: TableNode): TableCellNode[][] | null {
  const rowCount = table.getChildrenSize();
  const firstRow = table.getFirstChild();
  if (!$isTableRowNode(firstRow) || rowCount > MAX_TABLE_CLIPBOARD_CELLS) {
    return null;
  }
  const columns = firstRow.getChildrenSize();
  if (columns === 0 || rowCount * columns > MAX_TABLE_CLIPBOARD_CELLS) {
    return null;
  }
  const grid: TableCellNode[][] = [];
  for (const row of table.getChildren()) {
    if (!$isTableRowNode(row) || row.getChildrenSize() !== columns) {
      return null;
    }
    const cells: TableCellNode[] = [];
    for (const cell of row.getChildren()) {
      if (!$isTableCellNode(cell) || cell.getColSpan() !== 1 || cell.getRowSpan() !== 1) {
        return null;
      }
      cells.push(cell);
    }
    grid.push(cells);
  }
  return grid;
}

function inspectMatrix(matrix: TableClipboardMatrix): {columns: number} | TableMatrixPasteResult {
  if (matrix.length === 0) {
    return 'unhandled';
  }
  if (matrix.length > MAX_TABLE_CLIPBOARD_CELLS) {
    return 'too-large';
  }
  let columns = 0;
  let textLength = 0;
  let inlineBreaks = 0;
  for (const row of matrix) {
    columns = Math.max(columns, row.length);
    if (columns * matrix.length > MAX_TABLE_CLIPBOARD_CELLS) {
      return 'too-large';
    }
    for (const value of row) {
      if (typeof value !== 'string') {
        return 'unhandled';
      }
      textLength += value.length;
      if (textLength > MAX_TABLE_CLIPBOARD_TEXT_LENGTH) {
        return 'too-large';
      }
      for (let index = 0; index < value.length; index++) {
        const character = value[index];
        if (character === '\t' || character === '\r' || character === '\n') {
          if (++inlineBreaks > MAX_TABLE_CLIPBOARD_INLINE_BREAKS) {
            return 'too-large';
          }
          if (character === '\r' && value[index + 1] === '\n') {
            index++;
          }
        }
      }
    }
  }
  return columns === 0 ? 'unhandled' : {columns};
}

/**
 * Append in batches, in O(final cells), rather than rebuilding a table map for
 * each added column/row. This is safe only after the simple-grid preflight.
 * Like the official insert commands, extend row/column header flags, not the
 * last row's entire header state; preserve all existing cell/table attributes.
 */
function $growSimpleTable(
  table: TableNode,
  grid: TableCellNode[][],
  rows: number,
  columns: number,
): void {
  const oldColumns = grid[0].length;
  if (columns > oldColumns) {
    for (const cells of grid) {
      const previous = cells[cells.length - 1];
      const row = previous.getParentOrThrow();
      const added: TableCellNode[] = [];
      for (let column = oldColumns; column < columns; column++) {
        added.push($createTableCellNode(
          previous.getHeaderStyles() & TableCellHeaderStates.ROW,
        ).append($createParagraphNode()));
      }
      row.append(...added);
      cells.push(...added);
    }
    const widths = table.getColWidths();
    const lastWidth = widths?.[oldColumns - 1];
    if (widths && lastWidth !== undefined) {
      table.setColWidths([
        ...widths.slice(0, oldColumns),
        ...Array<number>(columns - oldColumns).fill(lastWidth),
      ]);
    }
  }
  const template = grid[grid.length - 1];
  const addedRows: TableRowNode[] = [];
  while (grid.length < rows) {
    const cells = template.map(cell => $createTableCellNode(
      cell.getHeaderStyles() & TableCellHeaderStates.COLUMN,
    ).append($createParagraphNode()));
    addedRows.push($createTableRowNode().append(...cells));
    grid.push(cells);
  }
  if (addedRows.length > 0) {
    table.append(...addedRows);
  }
}

/** Call inside editor.update/command handling. No DOM is needed. */
export function $pasteTableMatrix(
  editor: LexicalEditor,
  matrix: TableClipboardMatrix,
): TableMatrixPasteResult {
  if (!editor.isEditable()) {
    return 'unhandled';
  }
  const context = $getSelectionTableContext();
  if (!context) {
    return 'unhandled';
  }
  const {anchorCell, focusCell, selection, table} = context;
  const grid = $getSimpleTableGrid(table);
  // Merged/ragged tables stay entirely with Lexical, without partial mutations.
  if (!grid) {
    return 'unhandled';
  }
  const size = inspectMatrix(matrix);
  if (typeof size === 'string') {
    return size;
  }
  let anchorRow = -1;
  let anchorColumn = -1;
  let focusRow = -1;
  let focusColumn = -1;
  for (let row = 0; row < grid.length; row++) {
    for (let column = 0; column < grid[row].length; column++) {
      const cell = grid[row][column];
      if (cell.is(anchorCell)) {
        anchorRow = row;
        anchorColumn = column;
      }
      if (cell.is(focusCell)) {
        focusRow = row;
        focusColumn = column;
      }
    }
  }
  if (anchorRow < 0 || focusRow < 0) {
    return 'unhandled';
  }
  const startRow = $isTableSelection(selection) ? Math.min(anchorRow, focusRow) : anchorRow;
  const startColumn = $isTableSelection(selection) ? Math.min(anchorColumn, focusColumn) : anchorColumn;
  const rows = Math.max(grid.length, startRow + matrix.length);
  const columns = Math.max(grid[0].length, startColumn + size.columns);
  // A small paste in the corner of a large table can still cause huge growth.
  if (rows * columns > MAX_TABLE_CLIPBOARD_CELLS) {
    return 'too-large';
  }

  $growSimpleTable(table, grid, rows, columns);
  for (let row = 0; row < matrix.length; row++) {
    for (let column = 0; column < size.columns; column++) {
      const value = (matrix[row][column] ?? '').replace(/\r\n?/g, '\n');
      const paragraph = $createParagraphNode();
      const firstBlock = grid[startRow + row][startColumn + column].getFirstChild();
      if ($isElementNode(firstBlock) && !$isTableNode(firstBlock)) {
        paragraph.setFormat(firstBlock.getFormatType());
        paragraph.setDirection(firstBlock.getDirection());
        paragraph.setIndent(firstBlock.getIndent());
        paragraph.setStyle(firstBlock.getStyle());
        paragraph.setTextFormat(firstBlock.getTextFormat());
        paragraph.setTextStyle(firstBlock.getTextStyle());
      }
      paragraph.append(...$generateNodesFromRawText(value));
      grid[startRow + row][startColumn + column].clear().append(paragraph);
    }
  }
  grid[startRow + matrix.length - 1][startColumn + size.columns - 1].selectEnd();
  return 'handled';
}

export function $handleTableClipboardPaste(
  editor: LexicalEditor,
  event: PasteCommandType,
  warn?: TableClipboardWarning,
): boolean {
  if (
    !editor.isEditable() || $isEventFromEmbeddedInput(event) ||
    !('clipboardData' in event) || !event.clipboardData
  ) {
    return false;
  }
  const {clipboardData} = event;
  const types = Array.from(clipboardData.types);
  // Presence of HTML, Lexical JSON, RTF, files, etc. must preserve the official
  // rich clipboard path, even if the structured payload happens to be empty.
  if (types.length !== 1 || types[0].toLowerCase() !== 'text/plain') {
    return false;
  }
  const context = $getSelectionTableContext();
  if (!context || !$getSimpleTableGrid(context.table)) {
    return false;
  }
  const parsed = parseTableClipboard(clipboardData.getData('text/plain'));
  if (parsed.status === 'too-large') {
    event.preventDefault();
    warn?.(TABLE_CLIPBOARD_LIMIT_MESSAGE);
    return true;
  }
  if (parsed.status !== 'matrix') {
    return false;
  }
  const result = $pasteTableMatrix(editor, parsed.matrix);
  if (result === 'unhandled') {
    return false;
  }
  event.preventDefault();
  if (result === 'too-large') {
    warn?.(TABLE_CAPACITY_LIMIT_MESSAGE);
  }
  return true;
}

/** Bound span expansion before invoking Lexical's map builder (also for Tab). */
function $getBoundedTableMap(table: TableNode, cell: TableCellNode) {
  const rowCount = table.getChildrenSize();
  if (rowCount === 0 || rowCount > MAX_TABLE_CLIPBOARD_CELLS) {
    return null;
  }
  let area = 0;
  const rows = table.getChildren();
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!$isTableRowNode(row) || row.getChildrenSize() > MAX_TABLE_CLIPBOARD_CELLS - area) {
      return null;
    }
    for (const child of row.getChildren()) {
      if (!$isTableCellNode(child)) {
        return null;
      }
      const rowSpan = child.getRowSpan();
      const colSpan = child.getColSpan();
      if (
        !Number.isInteger(rowSpan) || !Number.isInteger(colSpan) ||
        rowSpan < 1 || colSpan < 1 || rowSpan > rowCount - rowIndex
      ) {
        return null;
      }
      area += rowSpan * colSpan;
      if (area > MAX_TABLE_CLIPBOARD_CELLS) {
        return null;
      }
    }
  }
  const [map] = $computeTableMap(table, cell, cell);
  const columns = map[0]?.length ?? 0;
  if (columns === 0 || map.length * columns > MAX_TABLE_CLIPBOARD_CELLS) {
    return null;
  }
  for (const row of map) {
    if (row.length !== columns) {
      return null;
    }
    for (let column = 0; column < columns; column++) {
      if (!row[column]) {
        return null;
      }
    }
  }
  return map;
}

/** Only the visual last cell is special. Other Tab behavior belongs to Lexical. */
export function $appendTableRowOnTab(
  editor: LexicalEditor,
  event: KeyboardEvent,
  warn?: TableClipboardWarning,
): boolean {
  if (
    !editor.isEditable() || $isEventFromEmbeddedInput(event) || event.shiftKey || event.altKey ||
    event.ctrlKey || event.metaKey || event.isComposing
  ) {
    return false;
  }
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return false;
  }
  const context = $getSelectionTableContext();
  if (!context) {
    return false;
  }
  const {anchorCell, table} = context;
  const map = $getBoundedTableMap(table, anchorCell);
  if (!map || !map[map.length - 1][map[0].length - 1].cell.is(anchorCell)) {
    return false;
  }
  if ((map.length + 1) * map[0].length > MAX_TABLE_CLIPBOARD_CELLS) {
    event.preventDefault();
    event.stopPropagation();
    warn?.(TABLE_CAPACITY_LIMIT_MESSAGE);
    return true;
  }
  const newRow = $insertTableRowAtNode(anchorCell, true);
  if (!newRow) {
    return false;
  }
  newRow.getFirstChild()?.selectStart();
  event.preventDefault();
  event.stopPropagation();
  return true;
}

export function registerTableClipboard(
  editor: LexicalEditor,
  warn?: TableClipboardWarning,
): () => void {
  return mergeRegister(
    editor.registerCommand(
      PASTE_COMMAND,
      event => $handleTableClipboardPaste(editor, event, warn),
      COMMAND_PRIORITY_HIGH,
    ),
    editor.registerCommand(
      KEY_TAB_COMMAND,
      event => $appendTableRowOnTab(editor, event, warn),
      // The official table Tab handler is HIGH and consumes the last-cell Tab.
      COMMAND_PRIORITY_CRITICAL,
    ),
  );
}
