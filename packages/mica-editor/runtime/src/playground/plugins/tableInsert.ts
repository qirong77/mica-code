import {INSERT_TABLE_COMMAND} from '@lexical/table';
import type {LexicalEditor} from 'lexical';

/**
 * 语雀式的直接插入：点「表格」就给一张 3×3、首行为标题的表，
 * 不再先弹尺寸选择。要更多行列，插入后用行/列把手上的「＋」加。
 */
export const DEFAULT_TABLE_ROWS = 3;
export const DEFAULT_TABLE_COLUMNS = 3;

export function insertDefaultTable(editor: LexicalEditor): void {
  editor.dispatchCommand(INSERT_TABLE_COMMAND, {
    rows: String(DEFAULT_TABLE_ROWS),
    columns: String(DEFAULT_TABLE_COLUMNS),
    includeHeaders: {rows: true, columns: false},
  });
}
