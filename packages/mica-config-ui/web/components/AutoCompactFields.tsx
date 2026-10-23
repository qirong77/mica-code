import { AUTO_COMPACT_FIELDS, type AutoCompactDraft } from '../autoCompact.js';
import { appIcons } from '../icons.js';
import { Switch } from './Ui.js';

type NumericKey = Exclude<keyof AutoCompactDraft, 'enabled'>;

/**
 * 自动压缩的字段编辑器：**设置页与会话弹窗共用这一份**。
 *
 * 两个宿主只是数据来源与落点不同（设置页写 config 里的默认值，会话弹窗写会话覆盖），
 * 所以标签、单位、步进、控件形态只在定义一次，不在任何一侧复制第二套。
 *
 * 形态是「标签在左、控件在右」的行列表，不是等宽网格：网格里五个数字框会摊满整行，
 * 眼睛要在列间横跳；标签与数值同高对齐后，改哪一项一眼就能定位。
 */
export function AutoCompactFields({
  draft,
  defaults = null,
  disabled = false,
  onChange,
  onToggle,
  onResetKey
}: {
  draft: AutoCompactDraft;
  /** 内置默认值（不是用户当前设置）：用来标出「默认 x」并支持逐项复位。 */
  defaults?: Partial<Record<NumericKey, number>> | null;
  disabled?: boolean;
  onChange(key: NumericKey, value: string): void;
  onToggle(enabled: boolean): void;
  onResetKey?(key: NumericKey): void;
}) {
  const ResetIcon = appIcons.reset;
  return (
    <div className="auto-compact-editor">
      <div className="auto-compact-enable">
        <Switch
          id="auto-compact-enabled"
          checked={draft.enabled}
          label="启用自动压缩"
          onChange={onToggle}
        />
        <label className="auto-compact-enable-label" htmlFor="auto-compact-enabled">
          启用自动压缩
        </label>
        <span className="auto-compact-enable-hint">超阈值时自动压缩历史</span>
      </div>

      <div className="auto-compact-rows">
        {AUTO_COMPACT_FIELDS.map((field) => {
          const value = draft[field.key];
          const fallback = defaults?.[field.key];
          const overridden = fallback != null && Number(value) !== fallback;
          return (
            <div className="auto-compact-row" key={field.key}>
              <span className="auto-compact-label">
                {field.label}
                {overridden ? (
                  <span className="auto-compact-default">
                    默认 {field.formatDefault(fallback)}
                  </span>
                ) : null}
              </span>
              <span className="auto-compact-steppers">
                <button
                  type="button"
                  className="auto-compact-step"
                  aria-label={`减少${field.label}`}
                  disabled={disabled || Number(value) <= field.min}
                  onClick={() =>
                    onChange(field.key, String(Math.max(field.min, Number(value || 0) - field.step)))
                  }
                >
                  −
                </button>
                <input
                  className="auto-compact-input"
                  inputMode="numeric"
                  aria-label={field.label}
                  value={value}
                  disabled={disabled}
                  onChange={(event) => onChange(field.key, event.target.value.replace(/[^\d]/g, ''))}
                />
                <button
                  type="button"
                  className="auto-compact-step"
                  aria-label={`增加${field.label}`}
                  disabled={disabled}
                  onClick={() => onChange(field.key, String(Number(value || 0) + field.step))}
                >
                  +
                </button>
                <span className="auto-compact-unit">{field.unit}</span>
                {onResetKey ? (
                  <button
                    type="button"
                    className="auto-compact-reset"
                    title={
                      overridden ? `恢复这一项（默认 ${field.formatDefault(fallback)}）` : '已是默认值'
                    }
                    aria-label={`恢复${field.label}默认值`}
                    disabled={disabled || !overridden}
                    onClick={() => onResetKey(field.key)}
                  >
                    <ResetIcon size={13} />
                  </button>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
