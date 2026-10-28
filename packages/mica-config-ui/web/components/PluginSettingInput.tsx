import { Switch } from './Ui.js';
import type { ConfigWebPluginSetting } from '../../src/shared/types.js';

/**
 * 单个插件设置字段的控件。
 *
 * 配置页的插件详情、桌面端的会话设置都用这一份：同一个字段在「全局默认值」和
 * 「本会话覆盖」两处必须是同一种控件，否则用户分不清自己改的是哪一层。
 *
 * 只负责渲染与取值，值怎么存、存到哪里由调用方决定。
 */
export function PluginSettingInput({
  field,
  value,
  disabled,
  invalid,
  onChange,
}: {
  field: ConfigWebPluginSetting;
  value: string;
  disabled: boolean;
  invalid: boolean;
  onChange(next: string): void;
}) {
  const inputId = `plugin-setting-${field.key}`;
  if (field.type === 'switch') {
    return (
      <Switch
        id={inputId}
        label={field.label}
        checked={value === 'true'}
        disabled={disabled}
        onChange={(checked) => onChange(checked ? 'true' : 'false')}
      />
    );
  }

  if (field.type === 'number') {
    const step = field.step ?? 1;
    // 步进按钮落在同一条边框里，与输入框共用高度：原生 number 的上下箭头既占位
    // 又和 −/+ 重复，所以这里关掉它们（appearance: none 在样式里）。
    const nudge = (direction: 1 | -1) => onChange(nudgeSettingValue(field, value, direction));
    return (
      <span className={`config-stepper${invalid ? ' is-invalid' : ''}`}>
        <button type="button" className="config-stepper-btn" disabled={disabled} onClick={() => nudge(-1)}>
          −
        </button>
        <input
          id={inputId}
          className="text-input config-stepper-input"
          type="number"
          inputMode="numeric"
          value={value}
          min={field.min}
          max={field.max}
          step={step}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <button type="button" className="config-stepper-btn" disabled={disabled} onClick={() => nudge(1)}>
          +
        </button>
        {field.unit ? <span className="config-stepper-unit">{field.unit}</span> : null}
      </span>
    );
  }

  // 枚举项自绘成按钮组：原生 select 的字号与内边距跟旁边的输入框对不齐。
  if (field.type === 'select') {
    return (
      <div className="config-segmented" role="group" aria-label={field.label} id={inputId}>
        {(field.options ?? []).map((option) => (
          <button
            key={option.value}
            type="button"
            className={`config-segment${value === option.value ? ' is-active' : ''}`}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    );
  }

  if (field.type === 'textarea') {
    return (
      <textarea
        id={inputId}
        className={`text-input text-input-multiline${invalid ? ' is-invalid' : ''}`}
        value={value}
        rows={4}
        spellCheck={false}
        placeholder={field.placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <input
      id={inputId}
      className={`text-input${invalid ? ' is-invalid' : ''}`}
      type={field.type === 'password' ? 'password' : 'text'}
      value={value}
      spellCheck={false}
      autoComplete="off"
      placeholder={field.placeholder}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * 数字步进的值：先抬到下限再压到上限。
 *
 * 两个边界写进同一个 `Math.min` 会让下限永远赢（`min(max, min)` 恒等于 min），
 * 表现就是「点一下 + 反而跳到最小值」——类型与校验都看不出问题。
 */
export function nudgeSettingValue(field: ConfigWebPluginSetting, current: string, direction: 1 | -1): string {
  const numeric = Number(current);
  const step = field.step ?? 1;
  const canStep = Number.isFinite(numeric) && current.trim() !== '';
  const base = canStep ? numeric : (field.min ?? 0);
  const next = base + step * direction;
  const lifted = field.min === undefined ? next : Math.max(field.min, next);
  const clamped = field.max === undefined ? lifted : Math.min(field.max, lifted);
  return String(Number(clamped.toFixed(4)));
}
