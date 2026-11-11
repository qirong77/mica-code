import {createHeadlessEditor} from '@lexical/headless';
import {
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
} from '@lexical/table';
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $setSelection,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_HIGH,
  KEY_TAB_COMMAND,
  type LexicalEditor,
  PASTE_COMMAND,
} from 'lexical';
import {describe, expect, it, vi} from 'vitest';

import {
  MAX_TABLE_CLIPBOARD_CELLS,
  MAX_TABLE_CLIPBOARD_INLINE_BREAKS,
  MAX_TABLE_CLIPBOARD_TEXT_LENGTH,
  parseTableClipboard,
} from '../src/playground/plugins/TableClipboardPlugin/parseTableClipboard';
import {
  $appendTableRowOnTab,
  $handleTableClipboardPaste,
  $pasteTableMatrix,
  registerTableClipboard,
  TABLE_CAPACITY_LIMIT_MESSAGE,
  TABLE_CLIPBOARD_LIMIT_MESSAGE,
} from '../src/playground/plugins/TableClipboardPlugin/tableClipboard';

function $table(key: string): TableNode {
  const node = $getNodeByKey(key);
  if (!$isTableNode(node)) throw new Error(`Missing table ${key}`);
  return node;
}

function $cell(table: TableNode, row: number, column: number): TableCellNode {
  const rowNode = table.getChildAtIndex(row);
  if (!$isTableRowNode(rowNode)) throw new Error(`Missing row ${row}`);
  const cell = rowNode.getChildAtIndex(column);
  if (!$isTableCellNode(cell)) throw new Error(`Missing cell ${row},${column}`);
  return cell;
}

function $row(table: TableNode, index: number): TableRowNode {
  const row = table.getChildAtIndex(index);
  if (!$isTableRowNode(row)) throw new Error(`Missing row ${index}`);
  return row;
}

function $setCellText(cell: TableCellNode, text: string): void {
  cell.clear().append($createParagraphNode().append($createTextNode(text)));
}

function createTableEditor(rows = 2, columns = 2) {
  const editor = createHeadlessEditor({
    namespace: 'table-clipboard-test',
    nodes: [TableNode, TableCellNode, TableRowNode],
    onError: error => {throw error;},
  });
  let tableKey = '';
  editor.update(() => {
    const table = $createTableNodeWithDimensions(rows, columns, false);
    tableKey = table.getKey();
    $getRoot().append(table);
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        $setCellText($cell(table, row, column), `${row},${column}`);
      }
    }
    $cell(table, 0, 0).selectStart();
  }, {discrete: true});
  return {editor, tableKey};
}

function readMatrix(editor: LexicalEditor, tableKey: string): string[][] {
  return editor.getEditorState().read(() => $table(tableKey).getChildren().map(row => {
    if (!$isTableRowNode(row)) throw new Error('Unexpected non-row');
    return row.getChildren().map(cell => cell.getTextContent());
  }));
}

function pasteEvent(text: string, types = ['text/plain']) {
  return {
    clipboardData: {
      getData: vi.fn((type: string) => type === 'text/plain' ? text : ''),
      types,
    },
    preventDefault: vi.fn(),
  } as unknown as ClipboardEvent;
}

function tabEvent(properties: Partial<KeyboardEvent> = {}) {
  return {
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    key: 'Tab',
    metaKey: false,
    preventDefault: vi.fn(),
    shiftKey: false,
    stopPropagation: vi.fn(),
    ...properties,
  } as unknown as KeyboardEvent;
}

describe('Excel/TSV parser', () => {
  it('parses quoted tabs, newlines, CRLF, doubled quotes, and plain quotes', () => {
    expect(parseTableClipboard('"one\ttwo"\t"line 1\r\nline 2"\r\n"say ""hi"""\tplain"quote\r\n')).toEqual({
      matrix: [['one\ttwo', 'line 1\nline 2'], ['say "hi"', 'plain"quote']],
      status: 'matrix',
    });
  });

  it('keeps leading, internal, trailing, and entirely empty cells', () => {
    expect(parseTableClipboard('\ta\t\r\n\t\t\r\n')).toEqual({
      matrix: [['', 'a', ''], ['', '', '']],
      status: 'matrix',
    });
    expect(parseTableClipboard('\t')).toEqual({matrix: [['', '']], status: 'matrix'});
    expect(parseTableClipboard('""\t""')).toEqual({matrix: [['', '']], status: 'matrix'});
  });

  it.each(['\n', '\r\n', '\r'])('ignores exactly one terminal %j record separator', newline => {
    expect(parseTableClipboard(`a\tb${newline}c\td${newline}`)).toEqual({
      matrix: [['a', 'b'], ['c', 'd']], status: 'matrix',
    });
    expect(parseTableClipboard(`a\tb${newline}${newline}`)).toEqual({
      matrix: [['a', 'b'], ['', '']], status: 'matrix',
    });
    expect(parseTableClipboard(`"a${newline}"\tb${newline}`)).toEqual({
      matrix: [['a\n', 'b']], status: 'matrix',
    });
  });

  it('pads ragged records and preserves whitespace rather than trimming cells', () => {
    expect(parseTableClipboard(' a \tb\tc\nd\ne\tf')).toEqual({
      matrix: [[' a ', 'b', 'c'], ['d', '', ''], ['e', 'f', '']],
      status: 'matrix',
    });
  });

  it('does not interpret ordinary multiline text or a solely quoted tab as a matrix', () => {
    for (const text of ['', 'a', 'a\nb\n', 'a,b\nc,d', '"one\ttwo"\n']) {
      expect(parseTableClipboard(text)).toEqual({status: 'not-matrix'});
    }
  });

  it('rejects unclosed quotes and unexpected text after a closing quote without discarding data', () => {
    for (const text of ['"a\tb', '"a"oops\tb', '"a" \tb', 'a\t"b']) {
      expect(parseTableClipboard(text)).toEqual({status: 'invalid'});
    }
  });

  it('accepts the cell limit exactly, including a trailing newline', () => {
    const text = `${Array<string>(100).fill(Array<string>(100).fill('x').join('\t')).join('\n')}\n`;
    const result = parseTableClipboard(text);
    expect(result.status).toBe('matrix');
    if (result.status === 'matrix') {
      expect(result.matrix).toHaveLength(100);
      expect(result.matrix[99]).toHaveLength(100);
    }
    expect(parseTableClipboard(`${text}x\tx`)).toEqual({status: 'too-large'});
  });

  it('bounds rows, columns, implicit rectangular padding, text length and inline-node count', () => {
    expect(parseTableClipboard('\t'.repeat(MAX_TABLE_CLIPBOARD_CELLS))).toEqual({status: 'too-large'});
    expect(parseTableClipboard('a\tb\n'.repeat(5001))).toEqual({status: 'too-large'});
    // Only 201 explicit fields, but padding would allocate 101 x 101 cells.
    expect(parseTableClipboard(`${Array<string>(101).fill('x').join('\t')}\n${'x\n'.repeat(100)}`)).toEqual({status: 'too-large'});
    expect(parseTableClipboard(`${'x'.repeat(MAX_TABLE_CLIPBOARD_TEXT_LENGTH)}\t`)).toEqual({status: 'too-large'});
    expect(parseTableClipboard(`"${'\t'.repeat(MAX_TABLE_CLIPBOARD_INLINE_BREAKS + 1)}"\tx`)).toEqual({status: 'too-large'});
  });
});

describe('headless matrix paste', () => {
  it('grows at the current cell, keeps cells outside the target, and leaves the caret in the last pasted cell', () => {
    const {editor, tableKey} = createTableEditor();
    editor.update(() => {
      const table = $table(tableKey);
      table.setColWidths([100, 200]);
      const cell = $cell(table, 1, 1);
      cell.setBackgroundColor('#fff2c7').setFormat('center');
      const block = cell.getFirstChild();
      if ($isElementNode(block)) block.setFormat('center').setDirection('ltr').setStyle('line-height: 2;');
      cell.selectStart();
      expect($pasteTableMatrix(editor, [['A', 'B'], ['C', 'D']])).toBe('handled');
      expect(cell.getBackgroundColor()).toBe('#fff2c7');
      expect(cell.getFormatType()).toBe('center');
      const pastedBlock = cell.getFirstChild();
      expect($isElementNode(pastedBlock) && pastedBlock.getFormatType()).toBe('center');
      expect($isElementNode(pastedBlock) && pastedBlock.getDirection()).toBe('ltr');
      expect($isElementNode(pastedBlock) && pastedBlock.getStyle()).toBe('line-height: 2;');
      expect(table.getColWidths()).toEqual([100, 200, 200]);
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if ($isRangeSelection(selection)) {
        expect(selection.isCollapsed()).toBe(true);
        expect($cell(table, 2, 2).isParentOf(selection.anchor.getNode())).toBe(true);
      }
    }, {discrete: true});
    expect(readMatrix(editor, tableKey)).toEqual([
      ['0,0', '0,1', ''], ['1,0', 'A', 'B'], ['', 'C', 'D'],
    ]);
  });

  it('starts at the rectangular upper left of a reversed TableSelection and never clips to its size', () => {
    const {editor, tableKey} = createTableEditor(3, 3);
    editor.update(() => {
      const table = $table(tableKey);
      $setSelection($createTableSelectionFrom(table, $cell(table, 2, 1), $cell(table, 1, 2)));
      expect($pasteTableMatrix(editor, [['A', 'B', 'C'], ['D', 'E', 'F'], ['G', 'H', 'I']])).toBe('handled');
    }, {discrete: true});
    expect(readMatrix(editor, tableKey)).toEqual([
      ['0,0', '0,1', '0,2', ''],
      ['1,0', 'A', 'B', 'C'],
      ['2,0', 'D', 'E', 'F'],
      ['', 'G', 'H', 'I'],
    ]);
  });

  it('keeps quoted tab/newline contents inside each cell and clears explicit empty target cells', () => {
    const {editor, tableKey} = createTableEditor(2, 3);
    editor.update(() => {
      expect($handleTableClipboardPaste(editor, pasteEvent('"a\tb"\t"c\r\nd"\t\r\n\t"say ""hi"""\t\r\n'))).toBe(true);
      const paragraph = $cell($table(tableKey), 0, 0).getFirstChildOrThrow();
      expect(paragraph.getType()).toBe('paragraph');
    }, {discrete: true});
    expect(readMatrix(editor, tableKey)).toEqual([['a\tb', 'c\nd', ''], ['', 'say "hi"', '']]);
  });

  it('pads raw ragged matrix input without clearing non-target cells', () => {
    const {editor, tableKey} = createTableEditor(2, 3);
    editor.update(() => {
      expect($pasteTableMatrix(editor, [['A', 'B'], ['C']])).toBe('handled');
    }, {discrete: true});
    expect(readMatrix(editor, tableKey)).toEqual([['A', 'B', '0,2'], ['C', '', '1,2']]);
  });

  it('inherits row and column headers only on the appropriate new axis', () => {
    const {editor, tableKey} = createTableEditor();
    editor.update(() => {
      const table = $table(tableKey);
      $cell(table, 0, 0).setHeaderStyles(TableCellHeaderStates.BOTH);
      $cell(table, 0, 1).setHeaderStyles(TableCellHeaderStates.ROW);
      $cell(table, 1, 0).setHeaderStyles(TableCellHeaderStates.COLUMN);
      $cell(table, 1, 1).selectStart();
      expect($pasteTableMatrix(editor, [['A', 'B'], ['C', 'D']])).toBe('handled');
      expect($cell(table, 0, 2).getHeaderStyles()).toBe(TableCellHeaderStates.ROW);
      expect($cell(table, 2, 0).getHeaderStyles()).toBe(TableCellHeaderStates.COLUMN);
      expect($cell(table, 2, 2).getHeaderStyles()).toBe(TableCellHeaderStates.NO_STATUS);
    }, {discrete: true});
  });

  it.each(['row', 'column'])('leaves tables containing a %s span untouched', kind => {
    const {editor, tableKey} = createTableEditor();
    editor.update(() => {
      const cell = $cell($table(tableKey), 0, 0);
      if (kind === 'row') cell.setRowSpan(2);
      else cell.setColSpan(2);
      const before = JSON.stringify($table(tableKey).exportJSON());
      const event = pasteEvent('A\tB');
      expect($handleTableClipboardPaste(editor, event)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(JSON.stringify($table(tableKey).exportJSON())).toBe(before);
    }, {discrete: true});
    expect(readMatrix(editor, tableKey)).toEqual([['0,0', '0,1'], ['1,0', '1,1']]);
  });

  it('falls back for ragged tables without padding or mutating them', () => {
    const {editor, tableKey} = createTableEditor();
    editor.update(() => {
      $cell($table(tableKey), 1, 1).remove();
      expect($pasteTableMatrix(editor, [['A', 'B']])).toBe('unhandled');
      expect($table(tableKey).getChildrenSize()).toBe(2);
      expect($row($table(tableKey), 1).getChildrenSize()).toBe(1);
    }, {discrete: true});
  });

  it('targets only the nearest nested table and leaves the outer table and sibling nested table intact', () => {
    const {editor, tableKey} = createTableEditor();
    let nestedKey = '';
    let siblingKey = '';
    editor.update(() => {
      const outer = $table(tableKey);
      const inner = $createTableNodeWithDimensions(1, 1, false);
      const sibling = $createTableNodeWithDimensions(1, 1, false);
      nestedKey = inner.getKey();
      siblingKey = sibling.getKey();
      $setCellText($cell(sibling, 0, 0), 'keep nested');
      $cell(outer, 0, 0).append(inner);
      $cell(outer, 1, 1).append(sibling);
      // A merged outer cell must not disqualify its simple nested table.
      $cell(outer, 0, 1).setColSpan(2);
      $cell(inner, 0, 0).selectStart();
      expect($pasteTableMatrix(editor, [['A', 'B'], ['C', 'D']])).toBe('handled');
      expect(outer.getChildrenSize()).toBe(2);
      expect($row(outer, 0).getChildrenSize()).toBe(2);
      expect($cell(outer, 0, 1).getTextContent()).toBe('0,1');
      expect($cell(outer, 0, 1).getColSpan()).toBe(2);
      expect($cell(outer, 0, 0).getFirstChildOrThrow().getTextContent()).toBe('0,0');
    }, {discrete: true});
    expect(readMatrix(editor, nestedKey)).toEqual([['A', 'B'], ['C', 'D']]);
    expect(readMatrix(editor, siblingKey)).toEqual([['keep nested']]);
  });

  it('does not process a selection crossing tables, even an outer/inner table boundary', () => {
    const {editor, tableKey} = createTableEditor();
    editor.update(() => {
      const outer = $table(tableKey);
      const inner = $createTableNodeWithDimensions(1, 1, false);
      $cell(outer, 0, 0).append(inner);
      const selection = $createRangeSelection();
      selection.anchor.set($cell(outer, 0, 1).getKey(), 0, 'element');
      selection.focus.set($cell(inner, 0, 0).getKey(), 0, 'element');
      $setSelection(selection);
      expect($pasteTableMatrix(editor, [['A', 'B']])).toBe('unhandled');

      const other = $createTableNodeWithDimensions(1, 1, false);
      $getRoot().append(other);
      selection.focus.set($cell(other, 0, 0).getKey(), 0, 'element');
      expect($pasteTableMatrix(editor, [['A', 'B']])).toBe('unhandled');
      const invalidSelection = $createTableSelection();
      invalidSelection.set(outer.getKey(), $cell(inner, 0, 0).getKey(), $cell(inner, 0, 0).getKey());
      $setSelection(invalidSelection);
      expect($pasteTableMatrix(editor, [['A', 'B']])).toBe('unhandled');
      $cell(outer, 0, 1).selectStart();
    }, {discrete: true});
  });

  it('returns unhandled when readonly or selection is outside a table', () => {
    const {editor, tableKey} = createTableEditor();
    editor.setEditable(false);
    editor.update(() => {
      expect($pasteTableMatrix(editor, [['A', 'B']])).toBe('unhandled');
      const event = pasteEvent('A\tB');
      expect($handleTableClipboardPaste(editor, event)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }, {discrete: true});
    editor.setEditable(true);
    editor.update(() => {
      const paragraph = $createParagraphNode().append($createTextNode('outside'));
      $getRoot().append(paragraph);
      paragraph.selectStart();
      expect($pasteTableMatrix(editor, [['A', 'B']])).toBe('unhandled');
    }, {discrete: true});
    expect(readMatrix(editor, tableKey)).toEqual([['0,0', '0,1'], ['1,0', '1,1']]);
  });

  it('rejects matrix/capacity limits before any mutation and warns instead of truncating', () => {
    const {editor, tableKey} = createTableEditor(100, 1);
    const warning = vi.fn();
    editor.update(() => {
      $cell($table(tableKey), 99, 0).selectStart();
      const event = pasteEvent(Array<string>(101).fill('x').join('\t'));
      expect($handleTableClipboardPaste(editor, event, warning)).toBe(true);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenLastCalledWith(TABLE_CAPACITY_LIMIT_MESSAGE);
      const oversized = pasteEvent('\t'.repeat(MAX_TABLE_CLIPBOARD_CELLS));
      expect($handleTableClipboardPaste(editor, oversized, warning)).toBe(true);
      expect(oversized.preventDefault).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenLastCalledWith(TABLE_CLIPBOARD_LIMIT_MESSAGE);
      expect($pasteTableMatrix(editor, [Array<string>(10_001).fill('')])).toBe('too-large');
      expect($table(tableKey).getChildrenSize()).toBe(100);
      expect($cell($table(tableKey), 99, 0).getTextContent()).toBe('99,0');
    }, {discrete: true});
    expect(readMatrix(editor, tableKey).every(row => row.length === 1)).toBe(true);
  });

  it('accepts the full 10k-cell rectangular paste in one bounded expansion', () => {
    const {editor, tableKey} = createTableEditor(1, 1);
    editor.update(() => {
      const matrix = Array.from({length: 100}, (_, row) => Array.from({length: 100}, (_, column) => `${row}:${column}`));
      expect($pasteTableMatrix(editor, matrix)).toBe('handled');
    }, {discrete: true});
    const matrix = readMatrix(editor, tableKey);
    expect(matrix).toHaveLength(100);
    expect(matrix[99]).toHaveLength(100);
    expect(matrix[99][99]).toBe('99:99');
  });
});

describe('command integration and existing behaviors', () => {
  it.each([
    {types: ['text/plain', 'text/html']},
    {types: ['text/plain', 'application/x-lexical-editor']},
    {types: ['text/plain', 'text/rtf']},
    {types: ['text/plain', 'Files']},
    {types: ['text/html']},
    {types: []},
  ])('leaves $types clipboard types to the official handler', ({types}) => {
    const {editor, tableKey} = createTableEditor();
    const cleanup = registerTableClipboard(editor);
    const official = vi.fn(() => true);
    const removeOfficial = editor.registerCommand(PASTE_COMMAND, official, COMMAND_PRIORITY_EDITOR);
    const event = pasteEvent('A\tB', types);
    editor.update(() => {
      expect(editor.dispatchCommand(PASTE_COMMAND, event)).toBe(true);
    }, {discrete: true});
    expect(official).toHaveBeenCalledOnce();
    expect(event.clipboardData?.getData).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(readMatrix(editor, tableKey)).toEqual([['0,0', '0,1'], ['1,0', '1,1']]);
    cleanup();
    removeOfficial();
  });

  it('plain matrix paste runs before the default handler and cleanup removes both listeners', () => {
    const {editor, tableKey} = createTableEditor();
    const cleanup = registerTableClipboard(editor);
    const officialPaste = vi.fn(() => true);
    const officialTab = vi.fn(() => true);
    editor.registerCommand(PASTE_COMMAND, officialPaste, COMMAND_PRIORITY_EDITOR);
    editor.registerCommand(KEY_TAB_COMMAND, officialTab, COMMAND_PRIORITY_HIGH);
    editor.update(() => {
      const event = pasteEvent('A\tB');
      expect(editor.dispatchCommand(PASTE_COMMAND, event)).toBe(true);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }, {discrete: true});
    expect(officialPaste).not.toHaveBeenCalled();
    expect(readMatrix(editor, tableKey)[0]).toEqual(['A', 'B']);
    cleanup();
    editor.update(() => {
      $cell($table(tableKey), 1, 1).selectStart();
      editor.dispatchCommand(KEY_TAB_COMMAND, tabEvent());
      editor.dispatchCommand(PASTE_COMMAND, pasteEvent('C\tD'));
    }, {discrete: true});
    expect(officialTab).toHaveBeenCalledOnce();
    expect(officialPaste).toHaveBeenCalledOnce();
    expect(readMatrix(editor, tableKey)).toEqual([['A', 'B'], ['1,0', '1,1']]);
  });

  it('does not intercept ordinary multiline text, malformed quoted text, or keyboard paste events', () => {
    const {editor} = createTableEditor();
    editor.update(() => {
      for (const event of [pasteEvent('line 1\nline 2'), pasteEvent('"bad\tquote'), tabEvent()]) {
        expect($handleTableClipboardPaste(editor, event)).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
      }
    }, {discrete: true});
  });

  it('adds a row only on forward Tab in the last cell, ahead of the official Tab handler', () => {
    const {editor, tableKey} = createTableEditor();
    const cleanup = registerTableClipboard(editor);
    const official = vi.fn(() => true);
    editor.registerCommand(KEY_TAB_COMMAND, official, COMMAND_PRIORITY_HIGH);
    editor.update(() => {
      $cell($table(tableKey), 1, 1).selectEnd();
      const event = tabEvent();
      expect(editor.dispatchCommand(KEY_TAB_COMMAND, event)).toBe(true);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
      const selection = $getSelection();
      expect($isRangeSelection(selection)).toBe(true);
      if ($isRangeSelection(selection)) {
        expect($cell($table(tableKey), 2, 0).isParentOf(selection.anchor.getNode())).toBe(true);
      }
    }, {discrete: true});
    expect(official).not.toHaveBeenCalled();
    expect(readMatrix(editor, tableKey)).toEqual([['0,0', '0,1'], ['1,0', '1,1'], ['', '']]);
    cleanup();
  });

  it('passes Shift+Tab, other cells, modifiers, composing, TableSelection and noncollapsed ranges through', () => {
    const {editor, tableKey} = createTableEditor();
    editor.update(() => {
      expect($appendTableRowOnTab(editor, tabEvent())).toBe(false);
      const table = $table(tableKey);
      $cell(table, 1, 1).selectStart();
      for (const event of [
        tabEvent({shiftKey: true}), tabEvent({ctrlKey: true}), tabEvent({metaKey: true}),
        tabEvent({altKey: true}), tabEvent({isComposing: true}),
      ]) {
        expect($appendTableRowOnTab(editor, event)).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled();
      }
      $setSelection($createTableSelectionFrom(table, $cell(table, 0, 0), $cell(table, 1, 1)));
      expect($appendTableRowOnTab(editor, tabEvent())).toBe(false);
      $cell(table, 1, 1).select(0, 1);
      expect($appendTableRowOnTab(editor, tabEvent())).toBe(false);
      expect(table.getChildrenSize()).toBe(2);
    }, {discrete: true});
  });

  it('does not intercept readonly Tab', () => {
    const {editor, tableKey} = createTableEditor();
    editor.update(() => {$cell($table(tableKey), 1, 1).selectStart();}, {discrete: true});
    editor.setEditable(false);
    editor.update(() => {
      const event = tabEvent();
      expect($appendTableRowOnTab(editor, event)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }, {discrete: true});
    expect(readMatrix(editor, tableKey)).toHaveLength(2);
  });

  it('Tab in a nested table only extends the nearest table, not an outer last cell', () => {
    const {editor, tableKey} = createTableEditor(1, 1);
    let innerKey = '';
    editor.update(() => {
      const outer = $table(tableKey);
      const inner = $createTableNodeWithDimensions(1, 2, false);
      innerKey = inner.getKey();
      $cell(outer, 0, 0).append(inner);
      $cell(inner, 0, 0).selectStart();
      expect($appendTableRowOnTab(editor, tabEvent())).toBe(false);
      $cell(inner, 0, 1).selectStart();
      expect($appendTableRowOnTab(editor, tabEvent())).toBe(true);
      expect(outer.getChildrenSize()).toBe(1);
      expect(inner.getChildrenSize()).toBe(2);
    }, {discrete: true});
    expect(readMatrix(editor, innerKey)).toEqual([['', ''], ['', '']]);
    expect(readMatrix(editor, tableKey)).toHaveLength(1);
  });

  it('warns and keeps the full table intact when Tab would grow beyond the cell limit', () => {
    const {editor, tableKey} = createTableEditor(1, 1);
    const warning = vi.fn();
    editor.update(() => {
      const matrix = Array.from({length: 100}, () => Array<string>(100).fill('x'));
      expect($pasteTableMatrix(editor, matrix)).toBe('handled');
      const event = tabEvent();
      expect($appendTableRowOnTab(editor, event, warning)).toBe(true);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(TABLE_CAPACITY_LIMIT_MESSAGE);
      expect($table(tableKey).getChildrenSize()).toBe(100);
      expect($row($table(tableKey), 99).getChildrenSize()).toBe(100);
    }, {discrete: true});
    expect(readMatrix(editor, tableKey).flat()).toHaveLength(MAX_TABLE_CLIPBOARD_CELLS);
  });

  it('handles a merged last cell through the official span-aware row insertion API', () => {
    const {editor, tableKey} = createTableEditor(1, 2);
    editor.update(() => {
      const table = $table(tableKey);
      $cell(table, 0, 1).remove();
      const merged = $cell(table, 0, 0).setColSpan(2);
      merged.selectStart();
      expect($appendTableRowOnTab(editor, tabEvent())).toBe(true);
      expect(merged.getColSpan()).toBe(2);
      expect(table.getChildrenSize()).toBe(2);
      expect($row(table, 1).getChildrenSize()).toBe(2);
    }, {discrete: true});
  });
});
