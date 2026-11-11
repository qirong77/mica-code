/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX} from 'react';

import {Button} from '@arco-design/web-react';
import {IconUpload} from '@arco-design/web-react/icon';
import {useId, useRef, useState} from 'react';

import * as React from 'react';

type Props = Readonly<{
  'data-test-id'?: string;
  accept?: string;
  label: string;
  onChange: (files: FileList | null) => void;
}>;

export default function FileInput({
  accept,
  label,
  onChange,
  'data-test-id': dataTestId,
}: Props): JSX.Element {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('尚未选择文件');
  return (
    <div className="Input__wrapper">
      <label htmlFor={id} className="Input__label">{label}</label>
      <div className="editor-file-input">
        <Button icon={<IconUpload />} onClick={() => input.current?.click()}>选择图片</Button>
        <span title={fileName}>{fileName}</span>
        <input id={id} ref={input} type="file" accept={accept} hidden data-test-id={dataTestId}
          onChange={event => {
            const files = event.target.files;
            if (files?.length) {
              setFileName(files[0].name);
              onChange(files);
            }
          }} />
      </div>
    </div>
  );
}
