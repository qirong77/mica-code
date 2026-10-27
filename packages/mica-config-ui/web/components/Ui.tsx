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

/**
 * 左列表右详情的双栏：整个页面只有这一块面，两栏之间只有一条分隔线。
 *
 * 会话和插件都是「先选一条、再看它」的结构。以前是「上方一个选择器卡片 + 下方内容卡片」，
 * 选择器本身占掉一整行高度，内容区却挤在下面滚动——两栏把竖排空间还给了正文。
 */
export function SplitView({ rail, children }: { rail: ReactNode; children: ReactNode }) {
  return (
    <div className="split-view">
      <aside className="split-rail">{rail}</aside>
      <section className="split-main">{children}</section>
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

type SettingsGroupProps = {
  title: ReactNode;
  /** 一句话说明这一组管什么；不要写成段落，页面上没有地方放长文。 */
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
};

/**
 * 设置分组：一条标题行 + 若干「标签 / 控件」行，整组是一块面而不是一叠卡片。
 *
 * 分组之间靠留白和这一层描边区分，组内每一行只画一条分隔线。以前每个字段都是一张独立
 * 卡片，字段一多页面就变成一堆等高方块：既读不出哪些属于同一件事，也看不出谁是重点。
 */
export function SettingsGroup({ title, description, actions, children }: SettingsGroupProps) {
  return (
    <section className="settings-group">
      <header className="settings-group-head">
        <div className="settings-group-copy">
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div className="settings-group-actions">{actions}</div> : null}
      </header>
      <div className="settings-group-body">{children}</div>
    </section>
  );
}

type SettingRowProps = {
  label: ReactNode;
  /** 控件下方的补充说明，只在真的能解释「填什么」时用。 */
  hint?: ReactNode;
  /** 给控件一个 id，标签才能点进输入框。 */
  htmlFor?: string;
  error?: string;
  /** 控件本身很宽（JSON、多行文本）时改成上下排。 */
  wide?: boolean;
  children: ReactNode;
};

/**
 * 一行设置：左标签右控件。
 *
 * 说明放在控件下方而不是标签下方：标签列只有 150px 宽，一句说明在那里会折成三行，
 * 行高被撑开、标签也失去对齐；放到控件下方就能用整行宽度，读起来是「这个输入框的注解」。
 */
export function SettingRow({ label, hint, htmlFor, error, wide = false, children }: SettingRowProps) {
  const LabelTag = htmlFor ? 'label' : 'span';
  return (
    <div className={`setting-row${wide ? ' is-wide' : ''}`}>
      <div className="setting-row-label">
        <LabelTag className="setting-row-name" {...(htmlFor ? { htmlFor } : {})}>
          {label}
        </LabelTag>
        {/* 上下排时说明跟标签在一起：放到控件下方就跑到高控件后面去了，看不到。 */}
        {wide && hint ? <span className="setting-row-hint">{hint}</span> : null}
      </div>
      <div className="setting-row-control">
        {children}
        {!wide && hint ? <span className="setting-row-hint">{hint}</span> : null}
        {error ? <span className="setting-row-error">{error}</span> : null}
      </div>
    </div>
  );
}
