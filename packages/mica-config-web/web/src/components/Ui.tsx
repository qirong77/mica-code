import type { ReactNode } from 'react';

type ButtonProps = {
  children?: ReactNode;
  icon?: ReactNode;
  loading?: boolean;
  variant?: 'primary' | 'default';
  title?: string;
  onClick(): void;
};

export function Button({ children, icon, loading = false, variant = 'default', title, onClick }: ButtonProps) {
  return (
    <button className={`ui-button ${variant === 'primary' ? 'ui-button-primary' : ''}`} type="button" title={title} disabled={loading} onClick={onClick}>
      <span className="ui-button-icon">{loading ? <span className="ui-button-spinner" aria-hidden="true" /> : icon}</span>
      {children ? <span>{children}</span> : null}
    </button>
  );
}

export function Alert({ message }: { message: string }) {
  return <div className="ui-alert">{message}</div>;
}

export function Empty({ description }: { description: string }) {
  return (
    <div className="ui-empty-wrap">
      <div className="ui-empty">{description}</div>
    </div>
  );
}

export function Tag({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'green' | 'red' | 'blue' }) {
  return <span className={`ui-tag ui-tag-${tone}`}>{children}</span>;
}

export function DescriptionList({ items }: { items: Array<{ label: string; value?: ReactNode }> }) {
  return (
    <dl className="description-list">
      {items
        .filter((item) => item.value !== undefined && item.value !== null && item.value !== '')
        .map((item) => (
          <div className="description-row" key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
    </dl>
  );
}

export function SegmentTabs({ items, value, onChange }: { items: Array<{ key: string; label: string; count?: number }>; value: string; onChange(value: string): void }) {
  return (
    <div className="segment-tabs" role="tablist" aria-label="section tabs">
      {items.map((item) => (
        <button
          key={item.key}
          className={`segment-tab ${value === item.key ? 'segment-tab-active' : ''}`}
          type="button"
          role="tab"
          aria-selected={value === item.key}
          onClick={() => onChange(item.key)}
        >
          <span>{item.label}</span>
          {item.count !== undefined ? <span className="segment-tab-count">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function DataTable({ columns, rows, emptyMessage }: { columns: string[]; rows: ReactNode[][]; emptyMessage?: string }) {
  if (rows.length === 0) return <Empty description={emptyMessage ?? '暂无数据'} />;
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

