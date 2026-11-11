/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
import {Button} from '@arco-design/web-react';
import {IconCheck, IconClose, IconCopy} from '@arco-design/web-react/icon';
import {type LexicalEditor, type NodeKey} from 'lexical';
import {useEffect, useRef, useState} from 'react';

import {$readCodeSnapshot} from '../../codeActions';

interface Props {
  editor: LexicalEditor;
  codeKey: NodeKey;
  label?: string;
}

export function CopyButton({editor, codeKey, label = '复制代码'}: Props) {
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const requestRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    requestRef.current++;
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  async function handleClick(): Promise<void> {
    const request = ++requestRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    const snapshot = editor.read('latest', () => $readCodeSnapshot(codeKey));
    try {
      if (!snapshot) throw new Error('代码块已移除');
      await navigator.clipboard.writeText(snapshot.content);
      if (request === requestRef.current) setStatus('success');
    } catch {
      if (request === requestRef.current) setStatus('error');
    }
    if (request === requestRef.current) {
      timerRef.current = setTimeout(() => setStatus('idle'), 3000);
    }
  }

  const feedback = status === 'success' ? '已复制' : status === 'error' ? '复制失败' : '';
  return (
    <>
      <Button
        type="text"
        htmlType="button"
        size="mini"
        className={`code-action-button code-copy-button ${status}`}
        onMouseDown={event => event.preventDefault()}
        onClick={handleClick}
        aria-label={label}
        title={status === 'error' ? '复制失败，请检查剪贴板权限后重试' : feedback || label}
        icon={status === 'success' ? <IconCheck /> : status === 'error' ? <IconClose /> : <IconCopy />}>
        {feedback || undefined}
      </Button>
      <span className="code-action-sr-only" role="status" aria-live="polite">
        {status === 'error' ? '复制失败，请检查剪贴板权限后重试' : feedback}
      </span>
    </>
  );
}
