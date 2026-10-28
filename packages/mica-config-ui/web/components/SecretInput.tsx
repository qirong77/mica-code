import { useState } from 'react';
import { appIcons } from '../icons.js';

/**
 * 密钥输入框：默认密文，带一个眼睛按钮切明文。
 *
 * 明文状态是组件自己的：收起服务商、切页面就回到密文，不需要调用方维护一份
 * 「哪些行露着」的表。值仍然完全受控。
 */
export function SecretInput({
  id,
  value,
  placeholder,
  ariaLabel,
  invalid = false,
  disabled = false,
  autoFocus = false,
  onChange,
}: {
  id?: string;
  value: string;
  placeholder?: string;
  ariaLabel?: string;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  onChange(next: string): void;
}) {
  const [revealed, setRevealed] = useState(false);
  const ShowIcon = appIcons.show;
  const HideIcon = appIcons.hide;
  return (
    <span className="config-input-with-action">
      <input
        id={id}
        className={`text-input${invalid ? ' is-invalid' : ''}`}
        type={revealed ? 'text' : 'password'}
        value={value}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className="config-input-action"
        title={revealed ? '隐藏明文' : '显示明文'}
        aria-label={revealed ? '隐藏明文' : '显示明文'}
        aria-pressed={revealed}
        disabled={disabled}
        onClick={() => setRevealed((current) => !current)}
      >
        {revealed ? <HideIcon size={14} /> : <ShowIcon size={14} />}
      </button>
    </span>
  );
}
