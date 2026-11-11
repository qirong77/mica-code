/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {LexicalEditor} from 'lexical';

import {Checkbox} from '@arco-design/web-react';
import {INSERT_TABLE_COMMAND} from '@lexical/table';
import {type JSX, type KeyboardEvent, useId, useRef, useState} from 'react';

import './TablePlugin.css';

import Button from '../ui/Button';
import {DialogActions} from '../ui/Dialog';
import TextInput from '../ui/TextInput';

export function InsertTableDialog({
  activeEditor,
  onClose,
}: {
  activeEditor: LexicalEditor;
  onClose: () => void;
}): JSX.Element {
  const [rows, setRows] = useState('3');
  const [columns, setColumns] = useState('3');
  const [includeHeaderRow, setIncludeHeaderRow] = useState(true);
  const [preview, setPreview] = useState({rows: 3, columns: 3});
  const cells = useRef<Array<HTMLButtonElement | null>>([]);
  const previewId = useId();

  const isValidSize = (value: string, max: number) =>
    /^[1-9]\d*$/.test(value) && Number(value) <= max;
  const isDisabled = !isValidSize(rows, 100) || !isValidSize(columns, 30);

  const insertTable = (rowCount: string, columnCount: string) => {
    if (!isValidSize(rowCount, 100) || !isValidSize(columnCount, 30)) {
      return;
    }
    activeEditor.dispatchCommand(INSERT_TABLE_COMMAND, {
      columns: columnCount,
      includeHeaders: {rows: includeHeaderRow, columns: false},
      rows: rowCount,
    });
    onClose();
  };

  const onGridKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    let nextRows = preview.rows;
    let nextColumns = preview.columns;
    switch (event.key) {
      case 'ArrowUp':
        nextRows = Math.max(1, nextRows - 1);
        break;
      case 'ArrowDown':
        nextRows = Math.min(6, nextRows + 1);
        break;
      case 'ArrowLeft':
        nextColumns = Math.max(1, nextColumns - 1);
        break;
      case 'ArrowRight':
        nextColumns = Math.min(8, nextColumns + 1);
        break;
      case 'Enter':
        event.preventDefault();
        insertTable(String(nextRows), String(nextColumns));
        return;
      default:
        return;
    }
    event.preventDefault();
    setPreview({rows: nextRows, columns: nextColumns});
    cells.current[(nextRows - 1) * 8 + nextColumns - 1]?.focus();
  };

  return (
    <div className="table-insert">
      <div className="table-insert-preview" id={previewId} aria-live="polite" aria-atomic="true">
        {preview.rows} 行 × {preview.columns} 列
      </div>
      <div
        className="table-insert-grid"
        role="group"
        aria-label="选择表格尺寸，方向键调整，Enter 插入"
        aria-describedby={previewId}>
        {Array.from({length: 48}, (_, index) => {
          const row = Math.floor(index / 8) + 1;
          const column = (index % 8) + 1;
          const selected = row <= preview.rows && column <= preview.columns;
          return (
            <button
              key={index}
              ref={(element) => { cells.current[index] = element; }}
              type="button"
              className={`table-insert-cell${selected ? ' is-selected' : ''}`}
              aria-label={`插入 ${row} 行 ${column} 列表格`}
              tabIndex={row === preview.rows && column === preview.columns ? 0 : -1}
              onMouseEnter={() => setPreview({rows: row, columns: column})}
              onFocus={() => setPreview({rows: row, columns: column})}
              onKeyDown={onGridKeyDown}
              onClick={() => insertTable(String(row), String(column))}
            />
          );
        })}
      </div>
      <p className="table-insert-hint">选格快速插入，也可以自定义尺寸</p>
      <div className="table-insert-custom">
        <TextInput
          placeholder="1–100"
          label="行数（1–100）"
          onChange={(value) => {
            if (value === '' || isValidSize(value, 100)) setRows(value);
          }}
          value={rows}
          data-test-id="table-modal-rows"
        />
        <TextInput
          placeholder="1–30"
          label="列数（1–30）"
          onChange={(value) => {
            if (value === '' || isValidSize(value, 30)) setColumns(value);
          }}
          value={columns}
          data-test-id="table-modal-columns"
        />
      </div>
      <div className="table-insert-footer">
        <Checkbox checked={includeHeaderRow} onChange={setIncludeHeaderRow}>
          首行为标题
        </Checkbox>
        <DialogActions data-test-id="table-model-confirm-insert">
          <Button disabled={isDisabled} onClick={() => insertTable(rows, columns)}>
            插入表格
          </Button>
        </DialogActions>
      </div>
    </div>
  );
}
