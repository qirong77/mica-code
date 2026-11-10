import {Select as ArcoSelect} from '@arco-design/web-react';
import {Children, isValidElement, type ChangeEvent, type JSX} from 'react';

import './Select.css';

type SelectProps = JSX.IntrinsicElements['select'] & {label?: string};

/** Preserve the small native-style API used by editor dialogs and DayPicker. */
export default function Select({children, label, className, value, defaultValue, onChange, disabled, id, name, style, 'aria-label': ariaLabel}: SelectProps): JSX.Element {
  const options = Children.toArray(children).flatMap(child => {
    if (!isValidElement<{value?: string | number; children?: string; disabled?: boolean}>(child)) return [];
    return [{value: String(child.props.value ?? child.props.children ?? ''), label: child.props.children, disabled: child.props.disabled}];
  });
  return (
    <div className="Input__wrapper">
      {label && <label className="Input__label" htmlFor={id}>{label}</label>}
      <ArcoSelect
        id={id} size="small" className={className} style={style} disabled={disabled}
        aria-label={ariaLabel ?? label} value={value == null ? undefined : String(value)}
        defaultValue={defaultValue == null ? undefined : String(defaultValue)} options={options}
        onChange={(next: string) => onChange?.({target: {value: next, name}, currentTarget: {value: next, name}} as ChangeEvent<HTMLSelectElement>)}
      />
    </div>
  );
}
