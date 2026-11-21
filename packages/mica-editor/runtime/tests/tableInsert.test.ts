import {createHeadlessEditor} from '@lexical/headless';
import {INSERT_TABLE_COMMAND} from '@lexical/table';
import {COMMAND_PRIORITY_EDITOR} from 'lexical';
import {describe, expect, it} from 'vitest';

import {insertDefaultTable} from '../src/playground/plugins/tableInsert';

describe('direct table insert', () => {
  it('inserts the default 3×3 table with a header row instead of opening a size picker', () => {
    const editor = createHeadlessEditor({namespace: 'table-insert-test'});
    const payloads: unknown[] = [];
    const unregister = editor.registerCommand(INSERT_TABLE_COMMAND, (payload) => {
      payloads.push(payload);
      return true;
    }, COMMAND_PRIORITY_EDITOR);
    insertDefaultTable(editor);
    unregister();
    expect(payloads).toEqual([{rows: '3', columns: '3', includeHeaders: {rows: true, columns: false}}]);
  });
});
