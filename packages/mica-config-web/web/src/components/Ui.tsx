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

type CollapsiblePanelProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
};

export function CollapsiblePanel({ title, subtitle, meta, children, defaultOpen = false }: CollapsiblePanelProps) {
  return (
    <details className="simple-card collapsible-card" open={defaultOpen}>
      <summary className="collapsible-summary">
        <div className="table-panel-title">
          <strong>{title}</strong>
          {subtitle ? <span>{subtitle}</span> : null}
        </div>
        {meta ? <div className="table-panel-tags">{meta}</div> : null}
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}

