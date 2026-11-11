/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import './index.css';

import {Button} from '@arco-design/web-react';
import {IconCode, IconExclamationCircle} from '@arco-design/web-react/icon';
import {$addUpdateTag, type LexicalEditor, type NodeKey, SKIP_DOM_SELECTION_TAG} from 'lexical';
import {useEffect, useId, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

import {$applyFormattedCode, $readCodeSnapshot} from '../../codeActions';
import {formatCodeWithPrettier} from '../../formatCodeWithPrettier';

interface Props {
  lang: string;
  editor: LexicalEditor;
  codeKey: NodeKey;
  disabled: boolean;
  getFeedbackContainer: () => HTMLElement | null;
}

export function PrettierButton({lang, editor, codeKey, disabled, getFeedbackContainer}: Props) {
  const [syntaxError, setSyntaxError] = useState<string>('');
  const [tipsVisible, setTipsVisible] = useState<boolean>(false);
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(false);
  const pendingRef = useRef(false);
  const errorId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  async function handleClick(): Promise<void> {
    if (!editor.isEditable() || pendingRef.current) return;
    const snapshot = editor.read('latest', () => $readCodeSnapshot(codeKey));
    if (!snapshot || snapshot.content === '') return;
    pendingRef.current = true;
    setPending(true);
    setSyntaxError('');
    setTipsVisible(false);

    try {
      const formattedCode = await formatCodeWithPrettier(snapshot.content, lang);
      editor.update(() => {
        const root = editor.getRootElement();
        if (!root?.contains(root.ownerDocument.activeElement)) {
          $addUpdateTag(SKIP_DOM_SELECTION_TAG);
        }
        const result = $applyFormattedCode(editor, snapshot, formattedCode);
        if (result === 'stale' && mountedRef.current) {
          setSyntaxError('代码块已变化，本次格式化未应用。请重试。');
          setTipsVisible(true);
        }
      });
    } catch (error: unknown) {
      if (mountedRef.current) {
        setSyntaxError(error instanceof Error ? `格式化失败：${error.message}` : '格式化失败，请重试。');
        setTipsVisible(true);
      }
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  }

  function handleMouseEnter() {
    if (syntaxError !== '') {
      setTipsVisible(true);
    }
  }

  function handleMouseLeave() {
    if (syntaxError !== '') {
      setTipsVisible(false);
    }
  }

  return (
    <div className="prettier-wrapper">
      <Button
        type="text"
        htmlType="button"
        size="mini"
        className="code-action-button"
        disabled={disabled || pending}
        loading={pending}
        onMouseDown={event => event.preventDefault()}
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onFocus={handleMouseEnter}
        onBlur={handleMouseLeave}
        aria-label="格式化代码"
        aria-describedby={tipsVisible ? errorId : undefined}
        title={pending ? '正在格式化代码' : '格式化代码'}
        icon={syntaxError ? <IconExclamationCircle /> : <IconCode />}
      />
      {tipsVisible && getFeedbackContainer() ? createPortal(
        <div className="code-error-tips" id={errorId} role="alert">{syntaxError}</div>,
        getFeedbackContainer()!,
      ) : null}
    </div>
  );
}
