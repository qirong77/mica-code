import type { ReactNode } from 'react';
import { appIcons } from '../icons.js';

type ButtonProps = {
  children?: ReactNode;
  icon?: ReactNode;
  loading?: boolean;
  disabled?: boolean;
  pressed?: boolean;
  variant?: 'primary' | 'danger' | 'default';
  title?: string;
  ariaLabel?: string;
  onClick(): void;
};

export function Button({
  children,
  icon,
  loading = false,
  disabled = false,
  pressed,
  variant = 'default',
  title,
  ariaLabel,
  onClick,
}: ButtonProps) {
  const variantClass = variant === 'primary' ? 'ui-button-primary' : variant === 'danger' ? 'ui-button-danger' : '';
  return (
    <button
      className={`ui-button ${variantClass}${children ? '' : ' ui-button-icon-only'}${loading ? ' ui-button-loading' : ''}`}
      type="button"
      title={title}
      aria-label={ariaLabel ?? (!children ? title : undefined)}
      aria-busy={loading || undefined}
      disabled={loading || disabled}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <span className="ui-button-icon" aria-hidden="true">
        {loading ? <span className="ui-button-spinner" aria-hidden="true" /> : icon}
      </span>
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

export function Tag({
  children,
  tone = 'default',
  dot = false,
}: {
  children: ReactNode;
  tone?: 'default' | 'green' | 'red' | 'blue';
  dot?: boolean;
}) {
  return (
    <span className={`ui-tag ui-tag-${tone}`}>
      {dot ? <span className="ui-tag-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

type CollapsiblePanelProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
};

export function CollapsiblePanel({ title, subtitle, meta, children, defaultOpen = false }: CollapsiblePanelProps) {
  const ChevronIcon = appIcons.chevronRight;
  return (
    <details className="simple-card collapsible-card" open={defaultOpen}>
      <summary className="collapsible-summary">
        <div className="table-panel-title">
          <strong>{title}</strong>
          {subtitle ? <span>{subtitle}</span> : null}
        </div>
        <div className="collapsible-trailing">
          {meta ? <div className="table-panel-tags">{meta}</div> : null}
          <ChevronIcon className="collapsible-chevron" size={15} aria-hidden="true" />
        </div>
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}
