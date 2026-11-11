import {createHeadlessEditor} from '@lexical/headless';
import {
  $computeTableMapSkipCellCheck,
  $createTableNodeWithDimensions,
  $createTableSelection,
  $createTableSelectionFrom,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  TableCellHeaderStates,
  TableCellNode,
  TableNode,
  TableRowNode,
  type InsertTableCommandPayloadHeaders,
} from '@lexical/table';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $isParagraphNode,
  $setSelection,
  type LexicalEditor,
} from 'lexical';
import {describe, expect, it} from 'vitest';

import {
  $applyTableAction,
  $readTableContext,
  type TableContext,
} from '../src/playground/plugins/TableControlsPlugin/tableActions';

const makeEditor = () => createHeadlessEditor({
  namespace: 'table-actions-test',
  nodes: [TableNode, TableRowNode, TableCellNode],
  onError: error => {throw error;},
});

function update(editor: LexicalEditor, fn: () => void) {
  editor.update(fn, {discrete: true});
}

function $table(key: string): TableNode {
  const table = $getNodeByKey(key);
  if (!$isTableNode(table)) throw new Error(`Missing table ${key}`);
  return table;
}

function $cell(key: string): TableCellNode {
  const cell = $getNodeByKey(key);
  if (!$isTableCellNode(cell)) throw new Error(`Missing cell ${key}`);
  return cell;
}

function fixture(data: string[][], headers: InsertTableCommandPayloadHeaders = false) {
  const editor = makeEditor();
  let tableKey = '';
  let keys: string[][] = [];
  update(editor, () => {
    const table = $createTableNodeWithDimensions(data.length, data[0].length, headers);
    tableKey = table.getKey();
    keys = table.getChildren().map((row, r) => {
      if (!$isTableRowNode(row)) throw new Error('Not a row');
      return row.getChildren().map((cell, c) => {
        if (!$isTableCellNode(cell)) throw new Error('Not a cell');
        cell.clear().append($createParagraphNode().append($createTextNode(data[r][c])));
        return cell.getKey();
      });
    });
    $getRoot().append($createParagraphNode(), table, $createParagraphNode());
    $setSelection($createTableSelectionFrom(table, $cell(keys[0][0]), $cell(keys[0][0])));
  });
  return {editor, tableKey, keys};
}

function select(editor: LexicalEditor, tableKey: string, anchor: string, focus = anchor) {
  update(editor, () => $setSelection($createTableSelectionFrom($table(tableKey), $cell(anchor), $cell(focus))));
}

function context(editor: LexicalEditor): TableContext {
  const result = editor.getEditorState().read($readTableContext);
  if (!result) throw new Error('Expected table context');
  return result;
}

function act(editor: LexicalEditor, action: string, saved?: TableContext) {
  update(editor, () => {
    const current = saved || $readTableContext();
    if (!current) throw new Error(`No context for ${action}`);
    $applyTableAction(action, current, editor);
  });
}

function matrix(editor: LexicalEditor, tableKey: string): string[][] {
  return editor.getEditorState().read(() => $table(tableKey).getChildren().map(row => {
    if (!$isTableRowNode(row)) throw new Error('Not a row');
    return row.getChildren().map(cell => cell.getTextContent());
  }));
}

function assertGrid(editor: LexicalEditor, tableKey: string, rows: number, columns: number) {
  editor.getEditorState().read(() => {
    const [map] = $computeTableMapSkipCellCheck($table(tableKey), null, null);
    expect(map).toHaveLength(rows);
    for (const row of map) {
      expect(row).toHaveLength(columns);
      for (let column = 0; column < columns; column++) expect(row[column]?.cell.isAttached()).toBe(true);
    }
  });
}

function assertOriginalKeys(editor: LexicalEditor, keys: string[][]) {
  editor.getEditorState().read(() => {
    for (const key of keys.flat()) expect($getNodeByKey(key)?.isAttached(), `original ${key}`).toBe(true);
  });
}

const grid = (rows: number, columns: number) =>
  Array.from({length: rows}, (_, r) => Array.from({length: columns}, (_, c) => `${r}:${c}`));

describe('table context and selection boundaries', () => {
  it('closes a reversed rectangle over an intersecting merged cell, including non-endpoint spans', () => {
    const {editor, tableKey, keys} = fixture(grid(4, 4));
    select(editor, tableKey, keys[1][1], keys[2][2]);
    act(editor, 'merge');
    select(editor, tableKey, keys[1][0], keys[0][1]);
    expect(context(editor)).toMatchObject({
      minRow: 0, maxRow: 2, minColumn: 0, maxColumn: 2,
      selectionRows: 3, selectionColumns: 3, selected: 6,
      rows: 4, columns: 4, merge: true, split: true, simple: false,
      background: null, alignment: 'left', verticalAlign: 'middle',
    });
    select(editor, tableKey, keys[0][1], keys[1][0]);
    expect(context(editor).selected).toBe(6);
  });

  it('uses all selected rows/columns when expanding, not just the anchor', () => {
    const {editor, tableKey, keys} = fixture(grid(4, 4));
    select(editor, tableKey, keys[2][2], keys[1][1]);
    act(editor, 'select-row');
    expect(context(editor)).toMatchObject({minRow: 1, maxRow: 2, minColumn: 0, maxColumn: 3, selected: 8});
    select(editor, tableKey, keys[2][2], keys[1][1]);
    act(editor, 'select-column');
    expect(context(editor)).toMatchObject({minRow: 0, maxRow: 3, minColumn: 1, maxColumn: 2, selected: 8});
    act(editor, 'select-table');
    expect(context(editor).selected).toBe(16);
  });

  it('reads a same-table RangeSelection but rejects selections spanning separate/nested tables', () => {
    const {editor, tableKey, keys} = fixture(grid(2, 2));
    let otherKey = '';
    update(editor, () => {
      const other = $createTableNodeWithDimensions(1, 1, false);
      $getRoot().append(other);
      const otherCell = other.getFirstChildOrThrow();
      if (!$isTableRowNode(otherCell)) throw new Error('Not a row');
      otherKey = otherCell.getFirstChildOrThrow().getKey();
      const range = $createRangeSelection();
      range.anchor.set($cell(keys[1][1]).getFirstChildOrThrow().getKey(), 0, 'element');
      range.focus.set($cell(keys[0][0]).getFirstChildOrThrow().getKey(), 0, 'element');
      $setSelection(range);
    });
    expect(context(editor)).toMatchObject({selected: 4, merge: true, minRow: 0, maxRow: 1});
    update(editor, () => {
      const range = $createRangeSelection();
      range.anchor.set(keys[0][0], 0, 'element');
      range.focus.set(otherKey, 0, 'element');
      $setSelection(range);
    });
    expect(editor.getEditorState().read($readTableContext)).toBeNull();
    update(editor, () => {
      const invalid = $createTableSelection();
      invalid.set(tableKey, keys[0][0], otherKey);
      $setSelection(invalid);
    });
    expect(editor.getEditorState().read($readTableContext)).toBeNull();
  });

  it('handles a plain collapsed text caret as one cell with workspace default alignments', () => {
    const {editor, tableKey, keys} = fixture([['caret', 'untouched']]);
    update(editor, () => $cell(keys[0][0]).selectStart());
    expect(context(editor)).toMatchObject({
      tableKey, selected: 1, selectionRows: 1, selectionColumns: 1,
      merge: false, split: false, alignment: 'left', verticalAlign: 'middle',
    });
    act(editor, 'row-after');
    expect(matrix(editor, tableKey)).toEqual([['caret', 'untouched'], ['', '']]);
  });
});

describe('batch insertion and deletion with merged cells', () => {
  for (const action of ['row-before', 'row-after']) {
    it(`${action} inserts the selected row count and grows crossing row spans only once`, () => {
      const {editor, tableKey, keys} = fixture(grid(4, 4));
      select(editor, tableKey, keys[0][0], keys[3][0]);
      act(editor, 'merge');
      select(editor, tableKey, keys[2][3], keys[1][2]);
      act(editor, action);
      assertGrid(editor, tableKey, 6, 4);
      editor.getEditorState().read(() => {
        expect($cell(keys[0][0]).getRowSpan()).toBe(6);
        for (const key of keys.flat().filter(key => key !== keys[1][0] && key !== keys[2][0] && key !== keys[3][0])) {
          expect($getNodeByKey(key)?.isAttached()).toBe(true);
        }
      });
      const rows = matrix(editor, tableKey);
      const insertion = action === 'row-before' ? 1 : 3;
      expect(rows.slice(insertion, insertion + 2)).toEqual([['', '', ''], ['', '', '']]);
      expect(rows.at(-1)).toEqual(['3:1', '3:2', '3:3']);
      expect(context(editor).selectionRows).toBe(2);
    });
  }

  for (const action of ['column-before', 'column-after']) {
    it(`${action} inserts the selected column count under a horizontal merge and preserves widths/content`, () => {
      const {editor, tableKey, keys} = fixture(grid(4, 4));
      update(editor, () => $table(tableKey).setColWidths([91, 102, 113, 124]));
      select(editor, tableKey, keys[0][0], keys[0][3]);
      act(editor, 'merge');
      select(editor, tableKey, keys[3][2], keys[2][1]);
      act(editor, action);
      assertGrid(editor, tableKey, 4, 6);
      editor.getEditorState().read(() => {
        expect($cell(keys[0][0]).getColSpan()).toBe(6);
        expect($table(tableKey).getColWidths()).toEqual(action === 'column-before'
          ? [91, 102, 102, 102, 113, 124] : [91, 102, 113, 113, 113, 124]);
      });
      const insertion = action === 'column-before' ? 1 : 3;
      expect(matrix(editor, tableKey)[3]).toEqual([
        ...grid(4, 4)[3].slice(0, insertion), '', '', ...grid(4, 4)[3].slice(insertion),
      ]);
      expect(context(editor).selectionColumns).toBe(2);
    });
  }

  it('inserts after the merge-closed boundary, rather than just either endpoint', () => {
    const {editor, tableKey, keys} = fixture(grid(4, 4));
    select(editor, tableKey, keys[1][1], keys[2][2]);
    act(editor, 'merge');
    select(editor, tableKey, keys[1][0], keys[0][1]);
    act(editor, 'row-after');
    assertGrid(editor, tableKey, 7, 4);
    expect(matrix(editor, tableKey).slice(3, 6)).toEqual(Array.from({length: 3}, () => ['', '', '', '']));
    expect(matrix(editor, tableKey)[6]).toEqual(grid(4, 4)[3]);
  });

  it('trims an unselected crossing rowSpan once when deleting multiple selected rows', () => {
    const {editor, tableKey, keys} = fixture(grid(4, 3));
    select(editor, tableKey, keys[0][0], keys[3][0]);
    act(editor, 'merge');
    select(editor, tableKey, keys[2][2], keys[1][1]);
    act(editor, 'delete-row');
    assertGrid(editor, tableKey, 2, 3);
    editor.getEditorState().read(() => expect($cell(keys[0][0]).getRowSpan()).toBe(2));
    expect(matrix(editor, tableKey)[1]).toEqual(['3:1', '3:2']);
  });

  it('moves the surviving lower part of a deleted-origin rowSpan into the next row', () => {
    const {editor, tableKey, keys} = fixture(grid(4, 3));
    select(editor, tableKey, keys[1][0], keys[3][0]);
    act(editor, 'merge');
    select(editor, tableKey, keys[0][1], keys[1][2]);
    act(editor, 'delete-row');
    assertGrid(editor, tableKey, 2, 3);
    editor.getEditorState().read(() => {
      expect($cell(keys[1][0]).getRowSpan()).toBe(2);
      expect($cell(keys[1][0]).getParent()?.getIndexWithinParent()).toBe(0);
    });
    expect(matrix(editor, tableKey)[0].slice(1)).toEqual(['2:1', '2:2']);
  });

  it('trims a crossing colSpan once and removes matching table widths', () => {
    const {editor, tableKey, keys} = fixture(grid(3, 4));
    update(editor, () => $table(tableKey).setColWidths([100, 200, 300, 400]));
    select(editor, tableKey, keys[0][0], keys[0][3]);
    act(editor, 'merge');
    select(editor, tableKey, keys[2][2], keys[1][1]);
    act(editor, 'delete-column');
    assertGrid(editor, tableKey, 3, 2);
    editor.getEditorState().read(() => {
      expect($cell(keys[0][0]).getColSpan()).toBe(2);
      expect($table(tableKey).getColWidths()).toEqual([100, 400]);
    });
    expect(matrix(editor, tableKey)[2]).toEqual(['2:0', '2:3']);
  });

  it('removes the table safely if every row/column is deleted', () => {
    for (const action of ['delete-row', 'delete-column']) {
      const {editor, tableKey} = fixture(grid(2, 2));
      act(editor, 'select-table');
      act(editor, action);
      editor.getEditorState().read(() => {
        expect($getNodeByKey(tableKey)?.isAttached() || false).toBe(false);
        expect($readTableContext()).toBeNull();
        expect($getRoot().getChildrenSize()).toBeGreaterThan(0);
      });
    }
  });
});

describe('merge, split, clear and batch presentation', () => {
  it('preserves nonempty content in row-major order and batch-splits more than one merged cell', () => {
    const {editor, tableKey, keys} = fixture(grid(2, 4));
    select(editor, tableKey, keys[0][1], keys[0][0]);
    act(editor, 'merge');
    select(editor, tableKey, keys[1][3], keys[1][2]);
    act(editor, 'merge');
    editor.getEditorState().read(() => {
      expect($cell(keys[0][0]).getTextContent()).toContain('0:0');
      expect($cell(keys[0][0]).getTextContent()).toContain('0:1');
    });
    act(editor, 'select-table');
    act(editor, 'background:#e8f3ff');
    act(editor, 'split');
    assertGrid(editor, tableKey, 2, 4);
    expect(context(editor)).toMatchObject({selected: 8, simple: true, split: false, background: '#e8f3ff'});
    const texts = matrix(editor, tableKey).flat().join('|');
    for (const text of grid(2, 4).flat()) expect(texts).toContain(text);
  });

  it('reports mixed styles and only formats the selected cells/blocks', () => {
    const {editor, tableKey, keys} = fixture(grid(2, 3));
    update(editor, () => {
      $cell(keys[0][0]).setBackgroundColor('#ffffff').setVerticalAlign('bottom');
      const paragraph = $cell(keys[0][0]).getFirstChildOrThrow();
      if ($isElementNode(paragraph)) paragraph.setFormat('right');
    });
    select(editor, tableKey, keys[0][1], keys[0][0]);
    expect(context(editor)).toMatchObject({background: 'mixed', alignment: 'mixed', verticalAlign: 'mixed'});
    act(editor, 'background:#E8F3FF');
    act(editor, 'align:center');
    act(editor, 'valign:top');
    expect(context(editor)).toMatchObject({background: '#e8f3ff', alignment: 'center', verticalAlign: 'top'});
    editor.getEditorState().read(() => {
      expect($cell(keys[0][2]).getBackgroundColor()).toBeNull();
      expect($cell(keys[1][0]).getVerticalAlign()).toBeUndefined();
      const paragraph = $cell(keys[0][2]).getFirstChildOrThrow();
      expect($isElementNode(paragraph) && paragraph.getFormatType()).toBe('');
    });
    act(editor, 'background:javascript:bad');
    expect(context(editor).background).toBe('#e8f3ff');
    act(editor, 'background:none');
    expect(context(editor).background).toBeNull();
    act(editor, 'valign:middle');
    expect(context(editor).verticalAlign).toBe('middle');
    act(editor, 'clear-content');
    expect(matrix(editor, tableKey)[0]).toEqual(['', '', '0:2']);
    expect(matrix(editor, tableKey)[1]).toEqual(['1:0', '1:1', '1:2']);
    expect(context(editor)).toMatchObject({selected: 2, alignment: 'center'});
  });

  it('persists explicit top alignment through a JSON round-trip', () => {
    const {editor} = fixture([['top']]);
    act(editor, 'valign:top');
    const state = JSON.stringify(editor.getEditorState().toJSON());
    expect(state).toContain('workspaceTableTopAligned');
    const restored = makeEditor();
    restored.setEditorState(restored.parseEditorState(state));
    update(restored, () => {
      const table = $getRoot().getChildren().find($isTableNode)!;
      const [map] = $computeTableMapSkipCellCheck(table, null, null);
      $setSelection($createTableSelectionFrom(table, map[0][0].cell, map[0][0].cell));
    });
    expect(context(restored).verticalAlign).toBe('top');
  });

  it('clears to one paragraph without resetting cell structure, style, header or alignment', () => {
    const {editor, tableKey, keys} = fixture(grid(2, 3), {rows: true, columns: false});
    select(editor, tableKey, keys[0][0], keys[0][1]);
    act(editor, 'merge');
    act(editor, 'background:#ffcccc');
    act(editor, 'align:right');
    act(editor, 'valign:bottom');
    act(editor, 'clear-content');
    assertGrid(editor, tableKey, 2, 3);
    editor.getEditorState().read(() => {
      const cell = $cell(keys[0][0]);
      expect(cell.getColSpan()).toBe(2);
      expect(cell.getBackgroundColor()).toBe('#ffcccc');
      expect(cell.getVerticalAlign()).toBe('bottom');
      expect(cell.hasHeaderState(TableCellHeaderStates.ROW)).toBe(true);
      expect(cell.getChildrenSize()).toBe(1);
      expect($isParagraphNode(cell.getFirstChild())).toBe(true);
      expect(cell.getTextContent()).toBe('');
      const paragraph = cell.getFirstChild();
      expect($isElementNode(paragraph) && paragraph.getFormatType()).toBe('right');
      expect($cell(keys[0][2]).getTextContent()).toBe('0:2');
    });
    expect(context(editor)).toMatchObject({alignment: 'right', background: '#ffcccc', verticalAlign: 'bottom'});
  });

  it('toggles first-row/column headers independently and table presentation is read from live state', () => {
    const {editor, tableKey, keys} = fixture(grid(3, 3));
    const stale = context(editor);
    act(editor, 'header', stale);
    act(editor, 'header-column', stale);
    act(editor, 'stripe', stale);
    act(editor, 'freeze-row', stale);
    act(editor, 'freeze-column', stale);
    expect(context(editor)).toMatchObject({header: true, headerColumn: true, striped: true, frozenRows: true, frozenColumns: true});
    act(editor, 'header', stale);
    editor.getEditorState().read(() => {
      expect($cell(keys[0][0]).hasHeaderState(TableCellHeaderStates.COLUMN)).toBe(true);
      expect($cell(keys[0][0]).hasHeaderState(TableCellHeaderStates.ROW)).toBe(false);
      expect($cell(keys[1][0]).hasHeaderState(TableCellHeaderStates.COLUMN)).toBe(true);
    });
    update(editor, () => $table(tableKey).setColWidths([100, 200, 300]));
    act(editor, 'equal-width');
    editor.getEditorState().read(() => expect($table(tableKey).getColWidths()).toEqual([200, 200, 200]));
    act(editor, 'header-column');
    act(editor, 'stripe');
    act(editor, 'freeze-row');
    act(editor, 'freeze-column');
    expect(context(editor)).toMatchObject({header: false, headerColumn: false, striped: false, frozenRows: false, frozenColumns: false});
  });
});

describe('duplicate, move and sort entire records without losing nodes', () => {
  it('duplicates every selected row after the range with rich content/style and row height intact', () => {
    const {editor, tableKey, keys} = fixture(grid(3, 3));
    update(editor, () => {
      $table(tableKey).setColWidths([111, 222, 333]);
      $cell(keys[1][1]).setBackgroundColor('#abc').setWidth(222).setVerticalAlign('bottom');
      const row = $cell(keys[1][1]).getParent();
      if ($isTableRowNode(row)) row.setHeight(72);
      const paragraph = $cell(keys[1][1]).getFirstChildOrThrow();
      if ($isElementNode(paragraph)) {
        paragraph.setFormat('center');
        paragraph.clear().append($createTextNode('bold copy').toggleFormat('bold'));
      }
    });
    const before = matrix(editor, tableKey);
    select(editor, tableKey, keys[2][0], keys[1][0]);
    act(editor, 'duplicate-row');
    expect(matrix(editor, tableKey)).toEqual([...before, before[1], before[2]]);
    assertOriginalKeys(editor, keys);
    editor.getEditorState().read(() => {
      const row = $table(tableKey).getChildAtIndex(3);
      expect($isTableRowNode(row) && row.getHeight()).toBe(72);
      const copy = $isElementNode(row) ? row.getChildAtIndex(1) : null;
      expect($isTableCellNode(copy) && copy.getKey()).not.toBe(keys[1][1]);
      expect($isTableCellNode(copy) && copy.getBackgroundColor()).toBe('#abc');
      expect($isTableCellNode(copy) && copy.getWidth()).toBe(222);
      expect($isTableCellNode(copy) && copy.getVerticalAlign()).toBe('bottom');
      const paragraph = $isTableCellNode(copy) ? copy.getFirstChild() : null;
      expect($isElementNode(paragraph) && paragraph.getFormatType()).toBe('center');
      expect($table(tableKey).getColWidths()).toEqual([111, 222, 333]);
    });
  });

  it('duplicates all selected columns across every row and repeats corresponding widths', () => {
    const data = grid(3, 4);
    const {editor, tableKey, keys} = fixture(data);
    update(editor, () => $table(tableKey).setColWidths([100, 200, 300, 400]));
    select(editor, tableKey, keys[1][2], keys[1][1]);
    act(editor, 'duplicate-column');
    expect(matrix(editor, tableKey)).toEqual(data.map(row => [...row.slice(0, 3), row[1], row[2], row[3]]));
    assertOriginalKeys(editor, keys);
    editor.getEditorState().read(() => expect($table(tableKey).getColWidths()).toEqual([100, 200, 300, 200, 300, 400]));
    expect(context(editor)).toMatchObject({selected: 6, minColumn: 3, maxColumn: 4, selectionRows: 3});
  });

  it('moves a row/column from a single-cell selection, keeping keys, records and column widths', () => {
    const data = grid(3, 3);
    const {editor, tableKey, keys} = fixture(data);
    update(editor, () => $table(tableKey).setColWidths([100, 200, 300]));
    select(editor, tableKey, keys[1][1]);
    act(editor, 'move-row-up');
    expect(matrix(editor, tableKey)).toEqual([data[1], data[0], data[2]]);
    expect(context(editor)).toMatchObject({selectionRows: 1, selectionColumns: 3, minRow: 0});
    select(editor, tableKey, keys[0][1]);
    act(editor, 'move-column-right');
    expect(matrix(editor, tableKey)).toEqual([data[1], data[0], data[2]].map(row => [row[0], row[2], row[1]]));
    assertOriginalKeys(editor, keys);
    editor.getEditorState().read(() => expect($table(tableKey).getColWidths()).toEqual([100, 300, 200]));
  });

  it('does not move multiple rows, move outside the table, or duplicate/reorder a merged table', () => {
    const {editor, tableKey, keys} = fixture(grid(3, 3));
    select(editor, tableKey, keys[0][1]);
    act(editor, 'move-row-up');
    expect(matrix(editor, tableKey)).toEqual(grid(3, 3));
    select(editor, tableKey, keys[1][1], keys[2][1]);
    act(editor, 'move-row-up');
    expect(matrix(editor, tableKey)).toEqual(grid(3, 3));
    select(editor, tableKey, keys[0][0], keys[0][1]);
    act(editor, 'merge');
    select(editor, tableKey, keys[1][1]);
    const before = matrix(editor, tableKey);
    for (const action of ['move-row-up', 'move-column-left', 'duplicate-row', 'duplicate-column', 'sort-asc']) {
      act(editor, action);
      expect(matrix(editor, tableKey)).toEqual(before);
    }
  });

  it('sorts numerically, holds the header fixed and moves complete original rows stably', () => {
    const data = [['Qty', 'Name'], ['10', 'Ten'], ['2', 'Two'], ['-1.5', 'Neg'], ['2', 'Second'], ['1.25', 'Dec']];
    const {editor, tableKey, keys} = fixture(data, {rows: true, columns: false});
    select(editor, tableKey, keys[3][0]);
    act(editor, 'sort-asc');
    expect(matrix(editor, tableKey)).toEqual([data[0], data[3], data[5], data[2], data[4], data[1]]);
    assertOriginalKeys(editor, keys);
    editor.getEditorState().read(() => {
      expect($table(tableKey).getFirstChild()?.getKey()).toBe($cell(keys[0][0]).getParent()?.getKey());
      for (const row of keys) expect($cell(row[0]).getParent()?.is($cell(row[1]).getParent())).toBe(true);
    });
    act(editor, 'sort-desc');
    expect(matrix(editor, tableKey)).toEqual([data[0], data[1], data[2], data[4], data[5], data[3]]);
    assertOriginalKeys(editor, keys);
  });

  it('uses natural alphanumeric order without a header and rejects multi-column sort', () => {
    const data = [['item10', 'A'], ['item2', 'B'], ['item1', 'C']];
    const {editor, tableKey, keys} = fixture(data);
    select(editor, tableKey, keys[1][0]);
    act(editor, 'sort-asc');
    expect(matrix(editor, tableKey)).toEqual([data[2], data[1], data[0]]);
    act(editor, 'select-table');
    act(editor, 'sort-desc');
    expect(matrix(editor, tableKey)).toEqual([data[2], data[1], data[0]]);
  });

  it('compares integer strings beyond Number.MAX_SAFE_INTEGER without silently tying them', () => {
    const data = [['9007199254740993', 'larger'], ['9007199254740992', 'smaller']];
    const {editor, tableKey} = fixture(data);
    act(editor, 'sort-asc');
    expect(matrix(editor, tableKey)).toEqual([data[1], data[0]]);
  });
});

describe('nested tables and stale selection isolation', () => {
  it('never counts or batch-formats nested cells/blocks when the outer table is selected', () => {
    const {editor, tableKey, keys} = fixture(grid(2, 2));
    let nestedKey = '';
    let innerCellKey = '';
    update(editor, () => {
      const nested = $createTableNodeWithDimensions(1, 2, false);
      nestedKey = nested.getKey();
      const [map] = $computeTableMapSkipCellCheck(nested, null, null);
      innerCellKey = map[0][0].cell.getKey();
      map[0][0].cell.clear().append($createParagraphNode().append($createTextNode('inner')));
      $cell(keys[0][0]).append(nested);
    });
    select(editor, tableKey, keys[0][1], keys[0][0]);
    expect(context(editor).selected).toBe(2);
    act(editor, 'background:#abc');
    act(editor, 'align:center');
    act(editor, 'valign:bottom');
    editor.getEditorState().read(() => {
      const inner = $cell(innerCellKey);
      expect(inner.getBackgroundColor()).toBeNull();
      expect(inner.getVerticalAlign()).toBeUndefined();
      const paragraph = inner.getFirstChildOrThrow();
      expect($isElementNode(paragraph) && paragraph.getFormatType()).toBe('');
      expect($table(nestedKey).getFormatType()).toBe('');
    });
    select(editor, nestedKey, innerCellKey);
    expect(context(editor)).toMatchObject({tableKey: nestedKey, selected: 1, background: null});
    act(editor, 'background:#123456');
    editor.getEditorState().read(() => expect($cell(keys[0][0]).getBackgroundColor()).toBe('#abc'));
    update(editor, () => {
      const cross = $createRangeSelection();
      cross.anchor.set(keys[0][0], 0, 'element');
      cross.focus.set(innerCellKey, 0, 'element');
      $setSelection(cross);
    });
    expect(editor.getEditorState().read($readTableContext)).toBeNull();
  });

  it('duplicates a row containing a nested table without stealing the nested original nodes', () => {
    const {editor, tableKey, keys} = fixture(grid(2, 2));
    let nestedKey = '';
    update(editor, () => {
      const nested = $createTableNodeWithDimensions(1, 1, false);
      nestedKey = nested.getKey();
      $cell(keys[0][0]).append(nested);
    });
    select(editor, tableKey, keys[0][1]);
    act(editor, 'duplicate-row');
    assertOriginalKeys(editor, keys);
    editor.getEditorState().read(() => {
      expect($table(nestedKey).getParent()?.getKey()).toBe(keys[0][0]);
      const row = $table(tableKey).getChildAtIndex(1);
      const copiedCell = $isElementNode(row) ? row.getFirstChild() : null;
      const copiedNested = $isElementNode(copiedCell) ? copiedCell.getChildren().find($isTableNode) : null;
      expect(copiedNested?.getKey()).not.toBe(nestedKey);
      expect(copiedNested?.getChildrenSize()).toBe(1);
    });
  });

  it('ignores removed/mismatched context nodes and malformed/missing selections safely', () => {
    const {editor, tableKey, keys} = fixture(grid(2, 2));
    const stale = context(editor);
    let otherTable = '';
    let otherCell = '';
    update(editor, () => {
      const other = $createTableNodeWithDimensions(1, 1, false);
      otherTable = other.getKey();
      $getRoot().append(other);
      const [map] = $computeTableMapSkipCellCheck(other, null, null);
      otherCell = map[0][0].cell.getKey();
    });
    select(editor, otherTable, otherCell);
    act(editor, 'background:#abc', stale);
    act(editor, 'delete-table', {...context(editor), cellKey: keys[0][0]});
    expect(matrix(editor, tableKey)).toEqual(grid(2, 2));
    expect(matrix(editor, otherTable)).toEqual([['']]);
    select(editor, tableKey, keys[0][0]);
    update(editor, () => {
      $table(tableKey).remove();
      $applyTableAction('row-after', stale, editor);
      const invalid = $createTableSelection();
      invalid.set(otherTable, 'missing-key', otherCell);
      $setSelection(invalid);
      expect($readTableContext()).toBeNull();
      $applyTableAction('clear-content', {...stale, tableKey: otherTable}, editor);
      // Do not leave a deliberately invalid selection committed to the editor.
      $setSelection(null);
    });
    expect(editor.getEditorState().read($readTableContext)).toBeNull();
    expect(matrix(editor, otherTable)).toEqual([['']]);
  });

  it('rejects a ragged table in a read instead of writing repairs or merging over holes', () => {
    const {editor, tableKey, keys} = fixture(grid(2, 2));
    select(editor, tableKey, keys[0][0]);
    const saved = context(editor);
    update(editor, () => $cell(keys[1][1]).remove());
    expect(editor.getEditorState().read($readTableContext)).toBeNull();
    act(editor, 'merge', saved);
    expect(matrix(editor, tableKey)).toEqual([['0:0', '0:1'], ['1:0']]);
  });
});
