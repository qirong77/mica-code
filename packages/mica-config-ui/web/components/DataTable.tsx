import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { pageRangeLabel, pageWindow } from './dataTableModel.js';
import { Button } from './Ui.js';

export type DataTableSort = { key: string; desc: boolean };

export type DataTableColumn = {
  key: string;
  label: string;
  /** 窄容器里换的短标签：长表头会压到邻列表头上。 */
  narrowLabel?: string;
  /** 百分比宽度（`'32%'`）。七列以上才需要给，给不全时浏览器按内容摊开。 */
  width?: string;
  align?: 'left' | 'right';
  sortable?: boolean;
  /** 容器变窄时先退场：`secondary` 在 ≤720px 退，`tertiary` 在 ≤540px 再退。 */
  narrow?: 'secondary' | 'tertiary';
};

export type DataTableProps<T> = {
  ariaLabel?: string;
  columns: DataTableColumn[];
  /** 已排好序的全部行；分页在这里面切。 */
  rows: T[];
  rowKey(row: T): string;
  /** 与 `columns` 一一对应的单元格内容。 */
  renderCells(row: T): ReactNode[];
  /** 受控排序：箭头由 `sort.key` 决定，点击表头只回调，排哪一项由调用方决定。 */
  sort?: DataTableSort | null;
  onSortChange?(key: string): void;
  /** 每页行数，0 / 未给表示不分页。 */
  pageSize?: number;
  emptyText?: string;
};

/**
 * 数据表：统计页与会话详情共用的那一份。
 *
 * 只用一种形态——表头（可排序）、按列宽摊开的固定布局、底部区间与翻页。窄容器里
 * **不横向滚动**，先让次要列退场（`.is-narrow-secondary` / `-tertiary`），这与配置页其他
 * 表格的行为一致：同一个页面里有的表能滑、有的不能，读起来像坏了。
 */
export function DataTable<T>({
  ariaLabel,
  columns,
  rows,
  rowKey,
  renderCells,
  sort = null,
  onSortChange,
  pageSize = 0,
  emptyText = '没有数据',
}: DataTableProps<T>) {
  const [page, setPage] = useState(0);
  const sortKey = sort?.key ?? '';
  const sortDesc = sort?.desc ?? false;

  // 换排序就回到第一页：停在第 4 页看一份重新排过的表，看到的是中间一段。
  useEffect(() => {
    setPage(0);
  }, [sortKey, sortDesc]);

  const range = pageWindow(rows.length, page, pageSize);
  const visible = rows.slice(range.start, range.end);

  return (
    <div className="data-table-scope">
      <table className="data-table" aria-label={ariaLabel}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cellClass(column)}
                style={column.width ? { width: column.width } : undefined}
              >
                {column.sortable ? (
                  <button
                    type="button"
                    className={`data-table-sort${sort?.key === column.key ? ' is-active' : ''}`}
                    aria-pressed={sort?.key === column.key}
                    onClick={() => onSortChange?.(column.key)}
                  >
                    {/* 只有声明了短标签的列才走宽窄两套文案：其它列没有 `narrowLabel`，
                        窄容器下不应该变成空表头。 */}
                    {column.narrowLabel ? (
                      <>
                        <span className="data-table-label-wide">{column.label}</span>
                        <span className="data-table-label-narrow">{column.narrowLabel}</span>
                      </>
                    ) : (
                      column.label
                    )}
                    {sort?.key === column.key ? (
                      <span className="data-table-arrow" aria-hidden="true">
                        {sort.desc ? '▼' : '▲'}
                      </span>
                    ) : null}
                  </button>
                ) : (
                  column.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => {
            const cells = renderCells(row);
            return (
              <tr key={rowKey(row)}>
                {columns.map((column, index) => (
                  <td key={column.key} className={cellClass(column)}>
                    {cells[index]}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {visible.length === 0 ? <div className="data-table-empty">{emptyText}</div> : null}
      {range.pageCount > 1 ? (
        <div className="data-table-footer">
          <span className="data-table-range">{pageRangeLabel(range)}</span>
          <div className="data-table-pager">
            <Button
              size="compact"
              variant="ghost"
              title="上一页"
              disabled={range.page === 0}
              onClick={() => setPage(range.page - 1)}
            >
              上一页
            </Button>
            <span className="data-table-page">
              {range.page + 1} / {range.pageCount}
            </span>
            <Button
              size="compact"
              variant="ghost"
              title="下一页"
              disabled={range.page >= range.pageCount - 1}
              onClick={() => setPage(range.page + 1)}
            >
              下一页
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function cellClass(column: DataTableColumn): string {
  const classes = ['data-table-cell'];
  if (column.align === 'right') classes.push('is-num');
  if (column.narrow) classes.push(`is-narrow-${column.narrow}`);
  return classes.join(' ');
}
