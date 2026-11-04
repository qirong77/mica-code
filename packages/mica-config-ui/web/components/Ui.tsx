import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { appIcons } from '../icons.js';

type ButtonProps = {
  children?: ReactNode;
  icon?: ReactNode;
  loading?: boolean;
  disabled?: boolean;
  pressed?: boolean;
  autoFocus?: boolean;
  /**
   * `accent` 是实心强调（对话框的主操作：确定 / 开始 / 保存）；`primary` 是抬起的灰底，
   * 用于「当前项」而不是「就这么办」。两者不可互换。
   * `danger-ghost` 是行内的破坏性动作（列表里的「删除」）：保留红色文字，但常态不画边框，
   * 别让每一行都挂一个红框按钮。
   */
  variant?: 'primary' | 'accent' | 'danger' | 'default' | 'ghost' | 'danger-ghost';
  /** `compact` 是密集工具栏里的尺寸（24px 高、11px 字），与 `SelectMenu` / `DateField` 对齐。 */
  size?: 'default' | 'compact';
  /** 撑满一行：列表里的「加载更早」这类整行按钮。 */
  fullWidth?: boolean;
  title?: string;
  ariaLabel?: string;
  /** 富文本工具栏：`mousedown` 里 `preventDefault()` 保住编辑器选区，命令仍走 `onClick`。 */
  onMouseDown?(event: { preventDefault(): void }): void;
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
  size = 'default',
  fullWidth = false,
  title,
  ariaLabel,
  onMouseDown,
  onClick,
}: ButtonProps) {
  const variantClass = BUTTON_VARIANTS[variant];
  return (
    <button
      className={`ui-button ${variantClass}${children ? '' : ' ui-button-icon-only'}${
        loading ? ' ui-button-loading' : ''
      }${size === 'compact' ? ' ui-button-compact' : ''}${fullWidth ? ' ui-button-full' : ''}`}
      type="button"
      title={title}
      aria-label={ariaLabel ?? (!children ? title : undefined)}
      aria-busy={loading || undefined}
      disabled={loading || disabled}
      aria-pressed={pressed}
      autoFocus={autoFocus}
      onMouseDown={onMouseDown}
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
  accent: 'ui-button-accent',
  danger: 'ui-button-danger',
  default: '',
  ghost: 'ui-button-ghost',
  'danger-ghost': 'ui-button-ghost ui-button-danger',
};

/**
 * 分段选择：一组互斥选项（认证方式、协议这类），视觉上就是一条 TAB。
 *
 * 为什么不用原生 `<select>`：它的字体与内边距跟旁边的输入框对不齐，一行里会矮一截；
 * 选项少（2–4 个）时把所有取值摆在明面上点一次就到，比展开再选少一次交互。
 * 样式沿用配置页的 `.config-segmented`，插件面板与设置页因此长得一样。
 */
export function Segmented({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  disabled = false,
  size = 'default',
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange(next: string): void;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  /** `compact` 与 `Button` / `SelectMenu` / `DateField` 的紧凑尺寸等高（24px）。 */
  size?: 'default' | 'compact';
}) {
  return (
    <div
      className={`config-segmented${size === 'compact' ? ' is-compact' : ''}`}
      role="group"
      aria-label={ariaLabel}
      id={id}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`config-segment${value === option.value ? ' is-active' : ''}`}
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

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

type EmptyProps = {
  /** 一句话说明「这里什么都没有」。 */
  title?: string;
  description: string;
  /** 补充说明（操作提示这类第二段）：比正文小一档。 */
  hint?: string;
  /** 空态下的动作，通常是 1～2 个 `Button`。 */
  children?: ReactNode;
};

export function Empty({ title, description, hint, children }: EmptyProps) {
  return (
    <div className="ui-empty-wrap">
      <div className="ui-empty">
        {title ? <p className="ui-empty-title">{title}</p> : null}
        <p className="ui-empty-description">{description}</p>
        {hint ? <p className="ui-empty-hint">{hint}</p> : null}
        {children ? <div className="ui-empty-actions">{children}</div> : null}
      </div>
    </div>
  );
}

type CheckboxProps = {
  checked: boolean;
  /** 部分选中（父级目录里只有一部分文件勾上）。 */
  mixed?: boolean;
  label: string;
  title?: string;
  disabled?: boolean;
  size?: 'default' | 'compact';
  onChange(next: boolean): void;
};

/**
 * 勾选框：清单里逐条「标记 / 选中」用它，`Switch` 只用于「开 / 关某个能力」。
 *
 * 原生 checkbox 各平台的勾与底色都不一样（macOS 是系统蓝），在深色界面上格格不入；
 * 这里保留原生 input 的可访问性与键盘行为，只把外观换成主题色。
 */
export function Checkbox({
  checked,
  mixed = false,
  label,
  title,
  disabled = false,
  size = 'default',
  onChange,
}: CheckboxProps) {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className={`ui-checkbox${size === 'compact' ? ' is-compact' : ''}`}
      checked={checked}
      disabled={disabled}
      aria-label={label}
      title={title ?? label}
      onChange={(event) => onChange(event.target.checked)}
    />
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
  /** `amber` 是「需要注意但没坏」（待配置、有偏离），与 `red` 的「出错了」分开。 */
  tone?: 'default' | 'green' | 'red' | 'blue' | 'amber';
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
