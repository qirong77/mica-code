import { useEffect, useRef, useState } from 'react';
import { Button, Segmented, Switch } from './Ui.js';
import { Input, InputNumber } from './ArcoSettings.js';
import { pickDirectory, supportsDirectoryPicker } from '../api.js';
import { SecretInput } from './SecretInput.js';
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
    return (
      <InputNumber
        id={inputId}
        className="config-number-input"
        mode="button"
        inputMode="decimal"
        value={value}
        aria-valuemin={field.min}
        aria-valuemax={field.max}
        step={field.step ?? 1}
        disabled={disabled}
        error={invalid}
        aria-label={field.label}
        aria-invalid={invalid || undefined}
        suffix={field.unit ? <span className="config-number-unit">{field.unit}</span> : undefined}
        parser={(text) => text}
        formatter={(_, info) => (info.userTyping ? info.input : value)}
        // Arco clamps manual input and blur values; only its step actions may normalize the draft.
        onInput={(event) => onChange(numberSettingInputValue(event.currentTarget.value))}
        onChange={(_, reason) => {
          if (reason === 'increase' || reason === 'decrease') {
            onChange(nudgeSettingValue(field, value, reason === 'increase' ? 1 : -1));
          }
        }}
      />
    );
  }

  // 枚举项自绘成按钮组：原生 select 的字号与内边距跟旁边的输入框对不齐。
  if (field.type === 'select') {
    return (
      <Segmented
        id={inputId}
        value={value}
        options={field.options ?? []}
        ariaLabel={field.label}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }

  if (field.type === 'textarea') {
    return (
      <Input.TextArea
        id={inputId}
        className="config-setting-multiline"
        status={invalid ? 'error' : undefined}
        value={value}
        rows={4}
        spellCheck={false}
        placeholder={field.placeholder}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }

  if (field.type === 'directories') {
    return <DirectoriesInput field={field} inputId={inputId} value={value} disabled={disabled} onChange={onChange} />;
  }

  // 密钥行统一走 SecretInput：眼睛按钮切明文，与配置页服务商的 API Key 同一个控件。
  if (field.type === 'password') {
    return (
      <SecretInput
        id={inputId}
        value={value}
        placeholder={field.placeholder}
        ariaLabel={field.label}
        invalid={invalid}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }

  return (
    <Input
      id={inputId}
      className="config-setting-input"
      status={invalid ? 'error' : undefined}
      type="text"
      value={value}
      spellCheck={false}
      autoComplete="off"
      placeholder={field.placeholder}
      disabled={disabled}
      onChange={onChange}
    />
  );
}

export function numberSettingInputValue(text: string): string {
  return /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) && Number.isFinite(Number(text)) ? text : '';
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

/**
 * `directories` 字段的取值 ↔ 行列表。
 *
 * 存储形态没有变成数组：插件的 `ctx.settings.get()` 读到的还是那份「一行一个目录」的
 * 文本，所以这一项只是**换个控件**，存档与校验规则都没动。空行不占位——用户加了一行却
 * 没填内容时，磁盘上不该多出一条空目录。
 */
export function splitDirectorySetting(value: string): string[] {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export function joinDirectorySetting(rows: readonly string[]): string {
  return rows
    .map((row) => row.trim())
    .filter((row) => row !== '')
    .join('\n');
}

/**
 * 一组目录的控件：一行一个目录，行内的路径仍可手改。
 *
 * 行列表是本地状态：值里没有空行，而「点了『手动添加』还没填」的那一行必须是空行，
 * 只从 value 推出来就画不出来。所以只在这份值被**外部**改掉（切插件、保存后回填）时
 * 跟随重排，自己发出去的那份不重排。
 */
function DirectoriesInput({
  field,
  inputId,
  value,
  disabled,
  onChange,
}: {
  field: ConfigWebPluginSetting;
  inputId: string;
  value: string;
  disabled: boolean;
  onChange(next: string): void;
}) {
  const [rows, setRows] = useState(() => splitDirectorySetting(value));
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const emitted = useRef(value);

  useEffect(() => {
    if (value === emitted.current) return;
    emitted.current = value;
    setRows(splitDirectorySetting(value));
  }, [value]);

  const apply = (next: string[]) => {
    setRows(next);
    const text = joinDirectorySetting(next);
    emitted.current = text;
    if (text !== value) onChange(text);
  };

  // 面板定位到已经填过的最后一个目录，连着加几个同级的文件夹时不用每次都翻回去。
  const addFromPicker = async () => {
    if (disabled || picking) return;
    setPicking(true);
    setError('');
    try {
      const last = [...rows].reverse().find((row) => row.trim() !== '') || '';
      const result = await pickDirectory({ title: field.label, defaultPath: last });
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.canceled || !result.path) return;
      if (rows.includes(result.path)) return;
      apply([...rows, result.path]);
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="config-directories">
      {rows.length === 0 ? <p className="config-directories-empty">还没有添加目录</p> : null}
      {rows.map((row, index) => (
        <div className="config-directory-row" key={index}>
          <Input
            id={index === 0 ? inputId : undefined}
            className="config-directory-input"
            value={row}
            spellCheck={false}
            disabled={disabled}
            placeholder={field.placeholder || '~/Desktop'}
            aria-label={`第 ${index + 1} 个目录`}
            onChange={(text) => {
              const next = [...rows];
              next[index] = text;
              apply(next);
            }}
          />
          <Button
            size="compact"
            variant="ghost"
            disabled={disabled || picking}
            title="移除这个目录"
            ariaLabel={`移除 ${row.trim() || `第 ${index + 1} 个目录`}`}
            onClick={() => apply(rows.filter((_, at) => at !== index))}
          >
            ×
          </Button>
        </div>
      ))}
      <div className="config-directories-actions">
        {supportsDirectoryPicker() ? (
          <Button size="compact" disabled={disabled} loading={picking} onClick={() => void addFromPicker()}>
            选择文件夹…
          </Button>
        ) : null}
        <Button size="compact" variant="ghost" disabled={disabled || picking} onClick={() => apply([...rows, ''])}>
          手动添加
        </Button>
      </div>
      {error ? <span className="setting-row-error">{error}</span> : null}
    </div>
  );
}
