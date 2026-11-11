import { useEffect, useId, useRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import ArcoAlert from '@arco-design/web-react/es/Alert';
import ArcoButton from '@arco-design/web-react/es/Button';
import ArcoCheckbox from '@arco-design/web-react/es/Checkbox';
import Collapse from '@arco-design/web-react/es/Collapse';
import ArcoEmpty from '@arco-design/web-react/es/Empty';
import Radio from '@arco-design/web-react/es/Radio';
import ArcoSwitch from '@arco-design/web-react/es/Switch';
import ArcoTag from '@arco-design/web-react/es/Tag';
import { appIcons } from '../icons.js';
import '../arco-settings.css';

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'onMouseDown' | 'children'> & {
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
  /** `compact` 使用 Arco mini（24px 高、12px 字）；默认 small（28px 高、14px 字）。 */
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
  className,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <ArcoButton
      {...props}
      className={`ui-button${children ? '' : ' ui-button-icon-only'}${
        loading ? ' ui-button-loading' : ''
      }${size === 'compact' ? ' ui-button-compact' : ''}${fullWidth ? ' ui-button-full' : ''}${className ? ` ${className}` : ''}`}
      htmlType={type}
      type={variant === 'accent' ? 'primary' : variant === 'ghost' || variant === 'danger-ghost' ? 'text' : 'secondary'}
      status={variant === 'danger' || variant === 'danger-ghost' ? 'danger' : 'default'}
      size={size === 'compact' ? 'mini' : 'small'}
      long={fullWidth}
      loading={loading}
      icon={
        icon ? (
          <span className="ui-button-icon" aria-hidden="true">
            {icon}
          </span>
        ) : undefined
      }
      title={title}
      aria-label={ariaLabel ?? props['aria-label'] ?? (!children ? title : undefined)}
      aria-busy={loading || props['aria-busy']}
      disabled={loading || disabled}
      aria-pressed={pressed ?? props['aria-pressed']}
      autoFocus={autoFocus}
      onMouseDown={onMouseDown}
      onClick={onClick}
    >
      {children}
    </ArcoButton>
  );
}

/**
 * 分段选择：一组互斥选项（认证方式、协议这类），视觉上就是一条 TAB。
 *
 * 为什么不用原生 `<select>`：它的字体与内边距跟旁边的输入框对不齐，一行里会矮一截；
 * 选项少（2–4 个）时把所有取值摆在明面上点一次就到，比展开再选少一次交互。
 * 插件面板与设置页共用 Arco Radio.Group。
 */
export function Segmented({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  disabled = false,
  size = 'default',
  variant = 'segmented',
}: {
  value: string;
  options: { value: string; label: ReactNode }[];
  onChange(next: string): void;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  /** `compact` 与 `Button` / `SelectMenu` / `DateField` 的紧凑尺寸等高（24px）。 */
  size?: 'default' | 'compact';
  /** 同一套单选语义：紧凑分段、普通单选或带图文的选项卡。 */
  variant?: 'segmented' | 'radio' | 'cards';
}) {
  const name = useId();
  return (
    <div
      className={`config-segmented${size === 'compact' ? ' is-compact' : ''}`}
      role="group"
      aria-label={ariaLabel}
      data-variant={variant}
      id={id}
    >
      <Radio.Group
        type={variant === 'segmented' ? 'button' : 'radio'}
        size={size === 'compact' ? 'mini' : 'small'}
        name={name}
        value={value}
        options={options}
        disabled={disabled}
        onChange={onChange}
      />
    </div>
  );
}

export function Alert({ message }: { message: string }) {
  return <ArcoAlert className="ui-alert" type="error" content={message} role="alert" />;
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

/** 标签由调用方提供，控件使用 Arco 默认的小尺寸。 */
export function Switch({ checked, id, label, onChange, disabled = false }: SwitchProps) {
  return (
    <ArcoSwitch
      className="ui-switch"
      id={id}
      size="small"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={onChange}
    />
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
      <ArcoEmpty
        className="ui-empty"
        description={
          <>
            {title ? <p className="ui-empty-title">{title}</p> : null}
            <p className="ui-empty-description">{description}</p>
            {hint ? <p className="ui-empty-hint">{hint}</p> : null}
            {children ? <div className="ui-empty-actions">{children}</div> : null}
          </>
        }
      />
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

/** 勾选框用于清单选中，Switch 只用于启停能力。 */
export function Checkbox({
  checked,
  mixed = false,
  label,
  title,
  disabled = false,
  size = 'default',
  onChange,
}: CheckboxProps) {
  const ref = useRef<HTMLLabelElement | null>(null);
  useEffect(() => {
    // Arco exposes its label ref but does not set the native mixed state or input label.
    const input = ref.current?.querySelector('input');
    if (input) {
      input.indeterminate = mixed;
      input.setAttribute('aria-label', label);
    }
  }, [mixed, label]);
  return (
    <ArcoCheckbox
      ref={ref}
      className={`ui-checkbox${size === 'compact' ? ' is-compact' : ''}`}
      checked={checked}
      indeterminate={mixed}
      disabled={disabled}
      title={title ?? label}
      onChange={onChange}
    >
      <span className="ui-checkbox-label">{label}</span>
    </ArcoCheckbox>
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
    <ArcoTag
      className="ui-tag"
      size="small"
      color={tone === 'default' ? undefined : tone === 'amber' ? 'gold' : tone}
      icon={dot ? <span className="ui-tag-dot" aria-hidden="true" /> : undefined}
    >
      {children}
    </ArcoTag>
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
    <Collapse className="collapsible-card" defaultActiveKey={defaultOpen ? ['panel'] : []} lazyload={false}>
      <Collapse.Item
        name="panel"
        showExpandIcon={false}
        header={
          <div className="collapsible-summary">
            <div className="table-panel-title">
              <strong>{title}</strong>
              {subtitle ? <span>{subtitle}</span> : null}
            </div>
            <div className="collapsible-trailing">
              {meta ? <div className="table-panel-tags">{meta}</div> : null}
              <ChevronIcon className="collapsible-chevron" size={15} aria-hidden="true" />
            </div>
          </div>
        }
      >
        <div className="collapsible-body">{children}</div>
      </Collapse.Item>
    </Collapse>
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
