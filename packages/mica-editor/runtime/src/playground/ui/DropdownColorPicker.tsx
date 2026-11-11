/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import * as React from 'react';

import ColorPicker from './ColorPicker';
import DropDown from './DropDown';

// Keep Lexical's picker: its callbacks preserve drag-history grouping and
// keyboard focus. Arco 2.66's value-only onChange cannot carry those flags.
type Props = {
  disabled?: boolean;
  buttonAriaLabel?: string;
  buttonClassName: string;
  buttonIconClassName?: string;
  buttonLabel?: string;
  title?: string;
  stopCloseOnClickSelf?: boolean;
  color: string;
  onChange?: (
    color: string,
    skipHistoryStack: boolean,
    skipRefocus: boolean,
  ) => void;
};

export default function DropdownColorPicker({
  disabled = false,
  stopCloseOnClickSelf = true,
  color,
  onChange,
  ...rest
}: Props) {
  return (
    <DropDown
      {...rest}
      buttonStyle={{'--toolbar-swatch': color} as React.CSSProperties}
      disabled={disabled}
      stopCloseOnClickSelf={stopCloseOnClickSelf}>
      <ColorPicker compact color={color} onChange={onChange} />
    </DropDown>
  );
}
