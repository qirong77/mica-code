/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {Modal as ArcoModal} from '@arco-design/web-react';
import {useLexicalFocusTrapRef} from '@lexical/react/useLexicalFocusTrapRef';
import {type CSSProperties, type JSX, type ReactNode, useCallback} from 'react';

export default function Modal({onClose, children, title, closeOnClickOutside = false, className, style}: {
  children: ReactNode;
  closeOnClickOutside?: boolean;
  onClose: () => void;
  title: string;
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  // Let Lexical own focus management, including restoration to the editor.
  // Two simultaneous focus traps (Arco + Lexical) fight over nested popups.
  const trap = useLexicalFocusTrapRef(true, 'firstFocusable', target =>
    Boolean(target.closest('.mica-menu, .arco-trigger-popup, .arco-select-popup')),
  );
  const attachContainer = useCallback((element: HTMLDivElement | null) => {
    // Arco mounts its portal after the first commit. Register when its DOM
    // really exists, and release via the ref API (not a returned disposer).
    trap(element?.closest<HTMLElement>('.arco-modal') ?? null);
  }, [trap]);

  return (
    <ArcoModal visible title={title} footer={null} onCancel={onClose}
      maskClosable={closeOnClickOutside} focusLock={false} autoFocus={false}
      alignCenter unmountOnExit className={['editor-modal', className].filter(Boolean).join(' ')}
      style={{width: 'min(560px, calc(100vw - 32px))', ...style}}>
      <div className="editor-modal-body" ref={attachContainer}>{children}</div>
    </ArcoModal>
  );
}
