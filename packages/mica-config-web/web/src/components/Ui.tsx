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
      <span className="ui-button-icon">{loading ? '...' : icon}</span>
      {children ? <span>{children}</span> : null}
    </button>
  );
}

export function Alert({ message }: { message: string }) {
  return <div className="ui-alert">{message}</div>;
}

export function Empty({ description }: { description: string }) {
  return <div className="ui-empty">{description}</div>;
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
