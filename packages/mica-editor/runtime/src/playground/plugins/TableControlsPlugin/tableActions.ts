import {
  $computeTableCellRectBoundary,
  $computeTableMap,
  $computeTableMapSkipCellCheck,
  $createTableRowNode,
  $createTableSelectionFrom,
  $getTableCellNodeFromLexicalNode,
  $isSimpleTable,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  $isTableSelection,
  $mergeCells,
  $moveTableColumn,
  $moveTableRow,
  $setTableColumnIsHeader,
  $setTableRowIsHeader,
  $unmergeCellNode,
  getTableElement,
  TableCellHeaderStates,
  TableCellNode,
  type TableCellRectBoundary,
  type TableMapType,
  type TableMapValueType,
  type TableNode,
} from '@lexical/table';
import {
  $copyNode,
  $createParagraphNode,
  $getEditor,
  $getNodeByKey,
  $getSelection,
  $getSlot,
  $getSlotNames,
  $getState,
  $isElementNode,
  $isRangeSelection,
  $isSlotHost,
  $parseSerializedNode,
  $setSelection,
  $setSlot,
  $setState,
  createState,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';

export type TableContext = {
  tableKey: string;
  cellKey: string;
  rows: number;
  columns: number;
  selected: number;
  selectionRows: number;
  selectionColumns: number;
  minRow: number;
  maxRow: number;
  minColumn: number;
  maxColumn: number;
  merge: boolean;
  split: boolean;
  header: boolean;
  headerColumn: boolean;
  striped: boolean;
  frozenRows: boolean;
  frozenColumns: boolean;
  simple: boolean;
  background: string | null;
  alignment: string;
  verticalAlign: string;
};

type TableTarget = {
  table: TableNode;
  anchorCell: TableCellNode;
  cells: TableCellNode[];
  map: TableMapType;
  boundary: TableCellRectBoundary;
};

// Lexical 0.53 only serializes/renders native verticalAlign = middle/bottom.
// The workspace defaults to middle, so "top" needs an explicit, persisted bit.
const topAlignedState = createState('workspaceTableTopAligned', {
  parse: (value: unknown) => value === true,
});

function $cellTable(cell: TableCellNode): TableNode | null {
  const row = cell.getParent();
  const table = $isTableRowNode(row) ? row.getParent() : null;
  return $isTableNode(table) ? table : null;
}

function $uniqueMapCells(map: TableMapType): TableMapValueType[] {
  const entries = new Map<string, TableMapValueType>();
  for (const row of map) {
    for (const entry of row) {
      if (entry) entries.set(entry.cell.getKey(), entry);
    }
  }
  return [...entries.values()];
}

/** Reject malformed/ragged tables instead of repairing them during a read. */
function $isRectangularMap(table: TableNode, map: TableMapType): boolean {
  const columns = map[0]?.length || 0;
  if (!columns || map.length !== table.getChildrenSize()) return false;
  const ownedCells = new Set<string>();
  for (const row of table.getChildren()) {
    if (!$isTableRowNode(row)) return false;
    for (const cell of row.getChildren()) {
      if (!$isTableCellNode(cell)) return false;
      ownedCells.add(cell.getKey());
    }
  }
  const mappedCells = new Set<string>();
  for (let row = 0; row < map.length; row++) {
    if (map[row].length !== columns) return false;
    for (let column = 0; column < columns; column++) {
      const entry = map[row][column];
      if (!entry || !$cellTable(entry.cell)?.is(table)) return false;
      const {cell, startColumn, startRow} = entry;
      const height = cell.getRowSpan();
      const width = cell.getColSpan();
      if (
        !Number.isInteger(height) || height < 1 ||
        !Number.isInteger(width) || width < 1 ||
        startRow + height > map.length || startColumn + width > columns ||
        row < startRow || row >= startRow + height ||
        column < startColumn || column >= startColumn + width
      ) return false;
      if (!mappedCells.has(cell.getKey())) {
        for (let r = startRow; r < startRow + height; r++) {
          for (let c = startColumn; c < startColumn + width; c++) {
            if (map[r]?.[c]?.cell.getKey() !== cell.getKey()) return false;
          }
        }
        mappedCells.add(cell.getKey());
      }
    }
  }
  return mappedCells.size === ownedCells.size;
}

/** All node reads in this module must run in an editor read/update. */
function $readTarget(): TableTarget | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) && !$isTableSelection(selection)) return null;
  if ($isTableSelection(selection) && !selection.isValid()) return null;
  // Point.getNode throws for a removed key; stale toolbar selections are normal.
  const anchorNode = $getNodeByKey(selection.anchor.key);
  const focusNode = $getNodeByKey(selection.focus.key);
  if (!anchorNode?.isAttached() || !focusNode?.isAttached()) return null;
  const anchorCell = $getTableCellNodeFromLexicalNode(anchorNode);
  const focusCell = $getTableCellNodeFromLexicalNode(focusNode);
  if (!anchorCell || !focusCell) return null;
  const table = $cellTable(anchorCell);
  if (!table?.isAttached() || !$cellTable(focusCell)?.is(table)) return null;
  if ($isTableSelection(selection) && selection.tableKey !== table.getKey()) return null;

  // Validate the direct structure before the native map's invariant checks.
  for (const row of table.getChildren()) {
    if (!$isTableRowNode(row)) return null;
    for (const cell of row.getChildren()) {
      if (!$isTableCellNode(cell) ||
        !Number.isInteger(cell.getRowSpan()) || cell.getRowSpan() < 1 ||
        !Number.isInteger(cell.getColSpan()) || cell.getColSpan() < 1) return null;
    }
  }
  const [map, anchorMap, focusMap] = $computeTableMap(table, anchorCell, focusCell);
  if (!$isRectangularMap(table, map)) return null;
  const boundary = $computeTableCellRectBoundary(map, anchorMap, focusMap);
  const {minRow, maxRow, minColumn, maxColumn} = boundary;
  if (minRow < 0 || minColumn < 0 || maxRow >= map.length || maxColumn >= map[0].length) return null;
  const cells = new Map<string, TableCellNode>();
  for (let row = minRow; row <= maxRow; row++) {
    for (let column = minColumn; column <= maxColumn; column++) {
      const cell = map[row][column].cell;
      // Do not use selection.getNodes(): it recursively includes nested tables.
      if ($cellTable(cell)?.is(table)) cells.set(cell.getKey(), cell);
    }
  }
  return {anchorCell, boundary, cells: [...cells.values()], map, table};
}

function $cellBlocks(cell: TableCellNode): ElementNode[] {
  const blocks: ElementNode[] = [];
  const visit = (node: LexicalNode) => {
    if (!$isElementNode(node) || $isTableNode(node) || $isTableRowNode(node) || $isTableCellNode(node)) return;
    if (!node.isInline()) blocks.push(node);
    if (node.isShadowRoot()) return;
    node.getChildren().forEach(visit);
  };
  cell.getChildren().forEach(visit);
  return blocks;
}

function $verticalAlignment(cell: TableCellNode): string {
  const native = cell.getVerticalAlign();
  // Native changes from another formatting command should still take effect.
  if (native === 'middle' || native === 'bottom') return native;
  return native === 'top' || $getState(cell, topAlignedState) ? 'top' : 'middle';
}

function commonValue<T>(values: T[], fallback: T): T | 'mixed' {
  const first = values[0] ?? fallback;
  return values.every(value => value === first) ? first : 'mixed';
}

function $contextFromTarget({table, anchorCell, cells, map, boundary}: TableTarget): TableContext {
  const {minRow, maxRow, minColumn, maxColumn} = boundary;
  const alignments = cells.flatMap(cell => {
    const formats = $cellBlocks(cell).map(block => {
      const format = block.getFormatType();
      return format === 'start' || format === '' ? 'left' : format === 'end' ? 'right' : format;
    });
    return formats.length ? formats : ['left'];
  });
  return {
    ...boundary,
    tableKey: table.getKey(),
    cellKey: anchorCell.getKey(),
    rows: map.length,
    columns: map[0].length,
    selected: cells.length,
    selectionRows: maxRow - minRow + 1,
    selectionColumns: maxColumn - minColumn + 1,
    // The map/closed boundary includes every covered grid position exactly once.
    merge: cells.length > 1,
    split: cells.some(cell => cell.getColSpan() > 1 || cell.getRowSpan() > 1),
    header: map[0].every(entry => entry.cell.hasHeaderState(TableCellHeaderStates.ROW)),
    headerColumn: map.every(row => row[0].cell.hasHeaderState(TableCellHeaderStates.COLUMN)),
    striped: table.getRowStriping(),
    frozenRows: table.getFrozenRows() > 0,
    frozenColumns: table.getFrozenColumns() > 0,
    simple: $isSimpleTable(table),
    background: commonValue(cells.map(cell => cell.getBackgroundColor()), null),
    alignment: commonValue(alignments, 'left'),
    verticalAlign: commonValue(cells.map($verticalAlignment), 'middle'),
  };
}

export function $readTableContext(): TableContext | null {
  const target = $readTarget();
  return target ? $contextFromTarget(target) : null;
}

function $selectRectangle(table: TableNode, boundary: TableCellRectBoundary): void {
  const [map] = $computeTableMapSkipCellCheck(table, null, null);
  const start = map[boundary.minRow]?.[boundary.minColumn]?.cell;
  const end = map[boundary.maxRow]?.[boundary.maxColumn]?.cell;
  if (start && end) $setSelection($createTableSelectionFrom(table, start, end));
}

function $emptyParagraph(cell: TableCellNode) {
  const paragraph = $createParagraphNode();
  const block = $cellBlocks(cell)[0];
  // Clearing content should not quietly reset the cell's text alignment/style.
  if (block) {
    paragraph.setFormat(block.getFormatType());
    paragraph.setDirection(block.getDirection());
    paragraph.setIndent(block.getIndent());
    paragraph.setStyle(block.getStyle());
    paragraph.setTextFormat(block.getTextFormat());
    paragraph.setTextStyle(block.getTextStyle());
  }
  return paragraph;
}

function $emptyCell(reference: TableCellNode, headerMask: number): TableCellNode {
  return $copyNode(reference)
    .setColSpan(1)
    .setRowSpan(1)
    .setWidth(reference.getColSpan() === 1 ? reference.getWidth() : undefined)
    .setHeaderStyles(reference.getHeaderStyles() & headerMask)
    .append($emptyParagraph(reference));
}

function $insertRows(target: TableTarget, after: boolean): void {
  const {table, map, boundary} = target;
  const index = after ? boundary.maxRow + 1 : boundary.minRow;
  const count = boundary.maxRow - boundary.minRow + 1;
  const reference = map[after ? boundary.maxRow : boundary.minRow];
  const crossing = new Set<string>();
  for (const {cell, startRow} of $uniqueMapCells(map)) {
    if (startRow < index && startRow + cell.getRowSpan() > index) {
      crossing.add(cell.getKey());
      cell.setRowSpan(cell.getRowSpan() + count);
    }
  }
  const insertedRows = Array.from({length: count}, () => {
    const row = $createTableRowNode();
    for (let column = 0; column < map[0].length; column++) {
      if (!crossing.has(map[index]?.[column]?.cell.getKey() || '')) {
        row.append($emptyCell(reference[column].cell, TableCellHeaderStates.COLUMN));
      }
    }
    return row;
  });
  table.splice(index, 0, insertedRows);
  $selectRectangle(table, {
    minRow: index, maxRow: index + count - 1,
    minColumn: boundary.minColumn, maxColumn: boundary.maxColumn,
  });
}

function $insertColumns(target: TableTarget, after: boolean): void {
  const {table, map, boundary} = target;
  const index = after ? boundary.maxColumn + 1 : boundary.minColumn;
  const count = boundary.maxColumn - boundary.minColumn + 1;
  const referenceColumn = after ? boundary.maxColumn : boundary.minColumn;
  const entries = $uniqueMapCells(map);
  const crossing = new Set<string>();
  for (const {cell, startColumn} of entries) {
    if (startColumn < index && startColumn + cell.getColSpan() > index) {
      crossing.add(cell.getKey());
      cell.setColSpan(cell.getColSpan() + count);
    }
  }
  table.getChildren().forEach((row, rowIndex) => {
    if (!$isTableRowNode(row) || crossing.has(map[rowIndex][index]?.cell.getKey() || '')) return;
    const next = entries.find(entry => entry.startRow === rowIndex && entry.startColumn >= index);
    const insertionIndex = next ? next.cell.getIndexWithinParent() : row.getChildrenSize();
    row.splice(insertionIndex, 0, Array.from({length: count}, () =>
      $emptyCell(map[rowIndex][referenceColumn].cell, TableCellHeaderStates.ROW)));
  });
  const widths = table.getColWidths();
  if (widths) {
    const next = [...widths];
    next.splice(index, 0, ...Array<number>(count).fill(widths[referenceColumn] || 92));
    table.setColWidths(next);
  }
  $selectRectangle(table, {
    minRow: boundary.minRow, maxRow: boundary.maxRow,
    minColumn: index, maxColumn: index + count - 1,
  });
}

function $deleteRows({table, map, boundary}: TableTarget): void {
  const {minRow, maxRow, minColumn} = boundary;
  const count = maxRow - minRow + 1;
  if (count === map.length) {
    table.selectPrevious();
    table.remove();
    return;
  }
  const rows = table.getChildren();
  const entries = $uniqueMapCells(map);
  const moved: TableMapValueType[] = [];
  for (const entry of entries) {
    const {cell, startRow} = entry;
    const span = cell.getRowSpan();
    const overlap = Math.max(0, Math.min(startRow + span - 1, maxRow) - Math.max(startRow, minRow) + 1);
    if (overlap > 0 && overlap < span) {
      cell.setRowSpan(span - overlap);
      if (startRow >= minRow && startRow <= maxRow) moved.push(entry);
    }
  }
  if (moved.length) {
    const destination = rows[maxRow + 1];
    if (!$isTableRowNode(destination)) return;
    const contents = [...moved, ...entries.filter(entry => entry.startRow === maxRow + 1)]
      .sort((a, b) => a.startColumn - b.startColumn).map(entry => entry.cell);
    destination.splice(0, destination.getChildrenSize(), contents);
  }
  for (let row = minRow; row <= maxRow; row++) rows[row].remove();
  const nextRow = Math.min(minRow, map.length - count - 1);
  $selectRectangle(table, {minRow: nextRow, maxRow: nextRow, minColumn, maxColumn: minColumn});
}

function $deleteColumns({table, map, boundary}: TableTarget): void {
  const {minColumn, maxColumn, minRow} = boundary;
  const count = maxColumn - minColumn + 1;
  if (count === map[0].length) {
    table.selectPrevious();
    table.remove();
    return;
  }
  for (const {cell, startColumn} of $uniqueMapCells(map)) {
    const span = cell.getColSpan();
    const overlap = Math.max(0, Math.min(startColumn + span - 1, maxColumn) - Math.max(startColumn, minColumn) + 1);
    if (overlap === span) cell.remove();
    else if (overlap > 0) cell.setColSpan(span - overlap);
  }
  const widths = table.getColWidths();
  if (widths) {
    const next = [...widths];
    next.splice(minColumn, count);
    table.setColWidths(next);
  }
  const nextColumn = Math.min(minColumn, map[0].length - count - 1);
  $selectRectangle(table, {minRow, maxRow: minRow, minColumn: nextColumn, maxColumn: nextColumn});
}

function $copyTree<T extends LexicalNode>(node: T): T {
  // Their clone() intentionally shares an editor for immutable node versions;
  // a user-requested duplicate must instead own a new caption editor.
  if (node.getType() === 'image' || node.getType() === 'sticky') {
    return $parseSerializedNode(node.exportJSON()) as T;
  }
  const copy = $copyNode(node);
  if ($isElementNode(node) && $isElementNode(copy)) {
    copy.append(...node.getChildren().map(child => $copyTree(child)));
  }
  if ($isSlotHost(copy)) {
    for (const name of $getSlotNames(node)) {
      const slot = $getSlot(node, name);
      if (slot) $setSlot(copy, name, $copyTree(slot));
    }
  }
  return copy;
}

function $duplicateRows({table, boundary, map}: TableTarget): void {
  const {minRow, maxRow} = boundary;
  const count = maxRow - minRow + 1;
  const copies = table.getChildren().slice(minRow, maxRow + 1).map(row => $copyTree(row));
  table.splice(maxRow + 1, 0, copies);
  $selectRectangle(table, {
    minRow: maxRow + 1, maxRow: maxRow + count,
    minColumn: 0, maxColumn: map[0].length - 1,
  });
}

function $duplicateColumns({table, boundary, map}: TableTarget): void {
  const {minColumn, maxColumn} = boundary;
  const count = maxColumn - minColumn + 1;
  for (const row of table.getChildren()) {
    if (!$isTableRowNode(row)) return;
    const copies = row.getChildren().slice(minColumn, maxColumn + 1).map(cell => $copyTree(cell));
    row.splice(maxColumn + 1, 0, copies);
  }
  const widths = table.getColWidths();
  if (widths) {
    const next = [...widths];
    next.splice(maxColumn + 1, 0, ...widths.slice(minColumn, maxColumn + 1));
    table.setColWidths(next);
  }
  $selectRectangle(table, {
    minRow: 0, maxRow: map.length - 1,
    minColumn: maxColumn + 1, maxColumn: maxColumn + count,
  });
}

const sortCollator = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
const numericValue = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function compareCellText(a: string, b: string): number {
  if (numericValue.test(a) && numericValue.test(b)) {
    if (/^[+-]?\d+$/.test(a) && /^[+-]?\d+$/.test(b)) {
      const left = BigInt(a);
      const right = BigInt(b);
      return left < right ? -1 : left > right ? 1 : 0;
    }
    const difference = Number(a) - Number(b);
    if (Number.isFinite(difference)) return difference;
  }
  return sortCollator.compare(a, b);
}

function $sortRows(target: TableTarget, descending: boolean, header: boolean): void {
  const {table, boundary, map} = target;
  const rows = table.getChildren();
  const offset = header ? 1 : 0;
  const sorted = rows.slice(offset).map((row, index) => ({
    index, row, text: map[index + offset][boundary.minColumn].cell.getTextContent().trim(),
  })).sort((a, b) => {
    const result = compareCellText(a.text, b.text);
    return (descending ? -result : result) || a.index - b.index;
  });
  // Move original row nodes, rather than replacing their text or recreating cells.
  table.splice(0, rows.length, [...rows.slice(0, offset), ...sorted.map(item => item.row)]);
  $selectRectangle(table, {
    minRow: 0, maxRow: map.length - 1,
    minColumn: boundary.minColumn, maxColumn: boundary.maxColumn,
  });
}

/**
 * The caller restores its selection and owns editor.update()/editable checks.
 * Re-read coordinates/styles here: context is a UI snapshot, not mutation authority.
 */
export function $applyTableAction(action: string, context: TableContext, editor: LexicalEditor): void {
  if ($getEditor() !== editor) return;
  const table = $getNodeByKey(context.tableKey);
  const cell = $getNodeByKey(context.cellKey);
  if (!$isTableNode(table) || !$isTableCellNode(cell) || !table.isAttached() || !cell.isAttached() || !$cellTable(cell)?.is(table)) return;
  const target = $readTarget();
  if (!target || !target.table.is(table) || !target.cells.some(selected => selected.is(cell))) return;
  const current = $contextFromTarget(target);
  const {cells, boundary} = target;

  if (action.startsWith('background:')) {
    const color = action.slice('background:'.length);
    if (color === 'none' || /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(color)) {
      cells.forEach(selected => selected.setBackgroundColor(color === 'none' ? null : color.toLowerCase()));
    }
    return;
  }
  if (action === 'align:left' || action === 'align:center' || action === 'align:right') {
    const alignment = action.slice('align:'.length) as 'left' | 'center' | 'right';
    cells.forEach(selected => $cellBlocks(selected).forEach(block => block.setFormat(alignment)));
    return;
  }
  if (action === 'valign:top' || action === 'valign:middle' || action === 'valign:bottom') {
    const alignment = action.slice('valign:'.length);
    cells.forEach(selected => {
      $setState(selected, topAlignedState, alignment === 'top');
      selected.setVerticalAlign(alignment);
    });
    return;
  }

  switch (action) {
    case 'row-before': $insertRows(target, false); break;
    case 'row-after': $insertRows(target, true); break;
    case 'column-before': $insertColumns(target, false); break;
    case 'column-after': $insertColumns(target, true); break;
    case 'delete-row': $deleteRows(target); break;
    case 'delete-column': $deleteColumns(target); break;
    case 'merge': {
      if (current.merge) {
        const merged = $mergeCells(cells);
        if (merged) $setSelection($createTableSelectionFrom(table, merged, merged));
      }
      break;
    }
    case 'split':
      cells.forEach(selected => $unmergeCellNode(selected));
      $selectRectangle(table, boundary);
      break;
    case 'header': $setTableRowIsHeader(table, 0, !current.header); break;
    case 'header-column': $setTableColumnIsHeader(table, 0, !current.headerColumn); break;
    case 'stripe': table.setRowStriping(!table.getRowStriping()); break;
    case 'freeze-row': table.setFrozenRows(table.getFrozenRows() > 0 ? 0 : 1); break;
    case 'freeze-column': table.setFrozenColumns(table.getFrozenColumns() > 0 ? 0 : 1); break;
    case 'equal-width': {
      const widths = table.getColWidths();
      let total = widths?.length === current.columns && widths.every(width => width > 0)
        ? widths.reduce((sum, width) => sum + width, 0) : 600;
      if (typeof window !== 'undefined') {
        // Measuring is optional (headless editors intentionally have no DOM API).
        try {
          total = getTableElement(table, editor.getElementByKey(table.getKey()))?.clientWidth || total;
        } catch { /* Keep model widths when no DOM is available. */ }
      }
      const width = Math.max(92, Math.round(total / current.columns));
      table.setColWidths(Array<number>(current.columns).fill(width));
      for (const {cell: tableCell} of $uniqueMapCells(target.map)) {
        if (tableCell.getWidth() !== undefined) tableCell.setWidth(width * tableCell.getColSpan());
      }
      break;
    }
    case 'select-row':
      $selectRectangle(table, {...boundary, minColumn: 0, maxColumn: current.columns - 1});
      break;
    case 'select-column':
      $selectRectangle(table, {...boundary, minRow: 0, maxRow: current.rows - 1});
      break;
    case 'select-table':
      $selectRectangle(table, {minRow: 0, maxRow: current.rows - 1, minColumn: 0, maxColumn: current.columns - 1});
      break;
    case 'clear-content':
      cells.forEach(selected => {
        const paragraph = $emptyParagraph(selected);
        selected.clear().append(paragraph);
      });
      $selectRectangle(table, boundary);
      break;
    case 'move-row-up':
    case 'move-row-down': {
      if (!current.simple || current.selectionRows !== 1) break;
      const destination = boundary.minRow + (action === 'move-row-up' ? -1 : 1);
      if (destination < 0 || destination >= current.rows) break;
      $moveTableRow(table, boundary.minRow, destination);
      $selectRectangle(table, {minRow: destination, maxRow: destination, minColumn: 0, maxColumn: current.columns - 1});
      break;
    }
    case 'move-column-left':
    case 'move-column-right': {
      if (!current.simple || current.selectionColumns !== 1) break;
      const destination = boundary.minColumn + (action === 'move-column-left' ? -1 : 1);
      if (destination < 0 || destination >= current.columns) break;
      $moveTableColumn(table, boundary.minColumn, destination);
      $selectRectangle(table, {minRow: 0, maxRow: current.rows - 1, minColumn: destination, maxColumn: destination});
      break;
    }
    case 'duplicate-row': if (current.simple) $duplicateRows(target); break;
    case 'duplicate-column': if (current.simple) $duplicateColumns(target); break;
    case 'sort-asc':
    case 'sort-desc':
      if (current.simple && current.selectionColumns === 1) $sortRows(target, action === 'sort-desc', current.header);
      break;
    case 'delete-table':
      table.selectPrevious();
      table.remove();
      break;
  }
}

/** Mount once from the UI plugin; cleanup with its effect. No editor-state writes in listeners. */
export function registerTableCellPresentation(editor: LexicalEditor): () => void {
  if (editor._headless) return () => {};
  return editor.registerMutationListener(TableCellNode, mutations => {
    editor.getEditorState().read(() => {
      for (const [key, mutation] of mutations) {
        if (mutation === 'destroyed') continue;
        const cell = $getNodeByKey(key);
        const element = editor.getElementByKey(key);
        if ($isTableCellNode(cell) && element) {
          element.style.verticalAlign = $verticalAlignment(cell) === 'top'
            ? 'top' : cell.getVerticalAlign() || '';
        }
      }
    });
  }, {skipInitialization: false});
}
