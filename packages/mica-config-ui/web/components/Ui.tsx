import type { ReactNode } from 'react';
import { appIcons } from '../icons.js';

type ButtonProps = {
  children?: ReactNode;
  icon?: ReactNode;
  loading?: boolean;
  disabled?: boolean;
  pressed?: boolean;
  autoFocus?: boolean;
  variant?: 'primary' | 'danger' | 'default' | 'ghost';
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
  autoFocus = false,
  variant = 'default',
  title,
  ariaLabel,
  onClick,
}: ButtonProps) {
  const variantClass = BUTTON_VARIANTS[variant];
  return (
    <button
      className={`ui-button ${variantClass}${children ? '' : ' ui-button-icon-only'}${loading ? ' ui-button-loading' : ''}`}
      type="button"
      title={title}
      aria-label={ariaLabel ?? (!children ? title : undefined)}
      aria-busy={loading || undefined}
      disabled={loading || disabled}
      aria-pressed={pressed}
      autoFocus={autoFocus}
      onClick={onClick}
    >
      {/* 没有图标时不渲染占位：空的 14px 图标格加 gap 会把文字挤偏中心 10px，
          纯文字按钮（对话框的取消 / 确定）看起来就像没居中。 */}
      {loading || icon ? (
        <span className="ui-button-icon" aria-hidden="true">
          {loading ? <span className="ui-button-spinner" aria-hidden="true" /> : icon}
        </span>
      ) : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

const BUTTON_VARIANTS: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'ui-button-primary',
  danger: 'ui-button-danger',
  default: '',
  ghost: 'ui-button-ghost',
};

export function Alert({ message }: { message: string }) {
  return <div className="ui-alert">{message}</div>;
}

/** 自动保存的状态角标：只在写盘中和刚写完这两个瞬间出现，平时不占位。 */
export function SaveStatus({ saving, saved }: { saving: boolean; saved: boolean }) {
  if (saving) return <span className="save-status save-status-pending">保存中…</span>;
  if (saved) return <span className="save-status">已保存</span>;
  return null;
}

type SwitchProps = {
  checked: boolean;
  id?: string;
  label: string;
  disabled?: boolean;
  onChange(checked: boolean): void;
};

/** 只有轨道和隐藏的 checkbox，标签由调用方的 <label> 提供。 */
export function Switch({ checked, id, label, onChange, disabled = false }: SwitchProps) {
  return (
    <span className={`ui-switch${disabled ? ' is-disabled' : ''}`}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="ui-switch-track" aria-hidden="true">
        <span className="ui-switch-knob" />
      </span>
    </span>
  );
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
