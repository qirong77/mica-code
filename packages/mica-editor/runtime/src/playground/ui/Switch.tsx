/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {Switch as ArcoSwitch} from '@arco-design/web-react';
import {type JSX, type MouseEvent, useId} from 'react';

export default function Switch({checked, onClick, text, id}: Readonly<{
  checked: boolean;
  id?: string;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  text: string;
}>): JSX.Element {
  const buttonId = useId();
  return (
    <div className="editor-setting" id={id}>
      <label htmlFor={buttonId}>{text}</label>
      <ArcoSwitch id={buttonId} size="small" checked={checked} aria-label={text} onChange={(_checked, event) => onClick(event)} />
    </div>
  );
}
