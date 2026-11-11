/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX, ReactNode} from 'react';

import {Button as ArcoButton} from '@arco-design/web-react';

import * as React from 'react';

import joinClasses from '../utils/joinClasses';

export default function Button({
  'data-test-id': dataTestId,
  'aria-label': ariaLabel,
  children,
  className,
  onClick,
  disabled,
  small,
  title,
}: {
  'data-test-id'?: string;
  'aria-label'?: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
  small?: boolean;
  title?: string;
}): JSX.Element {
  return (
    <ArcoButton
      htmlType="button"
      type="primary"
      size={small ? 'small' : 'default'}
      disabled={disabled}
      className={joinClasses(
        'playground-button',
        disabled && 'Button__disabled',
        small && 'Button__small',
        className,
      )}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel || title}
      {...(dataTestId && {'data-test-id': dataTestId})}>
      {children}
    </ArcoButton>
  );
}
