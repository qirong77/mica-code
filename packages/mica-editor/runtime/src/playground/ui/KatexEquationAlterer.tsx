/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import './KatexEquationAlterer.css';

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {LexicalErrorBoundary} from '@lexical/react/LexicalErrorBoundary';
import {Input} from '@arco-design/web-react';
import * as React from 'react';
import {type JSX, useCallback, useId, useState} from 'react';

import Button from '../ui/Button';
import KatexRenderer from './KatexRenderer';
import Checkbox from './Checkbox';

type Props = {
  initialEquation?: string;
  onConfirm: (equation: string, inline: boolean) => void;
};

export default function KatexEquationAlterer({
  onConfirm,
  initialEquation = '',
}: Props): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [equation, setEquation] = useState<string>(initialEquation);
  const [inline, setInline] = useState<boolean>(true);
  const equationInputId = useId();

  const onClick = useCallback(() => {
    onConfirm(equation, inline);
  }, [onConfirm, equation, inline]);

  const onCheckboxChange = useCallback(() => {
    setInline(!inline);
  }, [setInline, inline]);

  return (
    <>
      <div className="KatexEquationAlterer_defaultRow">
        行内公式
        <Checkbox
          aria-label="行内公式"
          checked={inline}
          onChange={onCheckboxChange}
          data-test-id="equation-inline-checkbox"
        />
      </div>
      <div className="KatexEquationAlterer_defaultRow">
        <label htmlFor={equationInputId}>LaTeX 公式</label>
      </div>
      <div className="KatexEquationAlterer_centerRow">
        {inline ? (
          <Input
            id={equationInputId}
            size="small"
            onChange={setEquation}
            value={equation}
            autoFocus={true}
            className="KatexEquationAlterer_textArea"
            data-test-id="equation-input"
          />
        ) : (
          <Input.TextArea
            id={equationInputId}
            onChange={setEquation}
            value={equation}
            autoFocus={true}
            className="KatexEquationAlterer_textArea"
            data-test-id="equation-input"
          />
        )}
      </div>
      <div className="KatexEquationAlterer_defaultRow">实时预览</div>
      <div className="KatexEquationAlterer_centerRow">
        <LexicalErrorBoundary onError={e => editor._onError(e)} fallback={null}>
          <KatexRenderer
            equation={equation}
            inline={false}
            onDoubleClick={() => null}
          />
        </LexicalErrorBoundary>
      </div>
      <div className="KatexEquationAlterer_dialogActions">
        <Button onClick={onClick} data-test-id="equation-submit-btn">
          插入公式
        </Button>
      </div>
    </>
  );
}
