/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {Modal as ArcoModal} from '@arco-design/web-react';
import {useLexicalFocusTrapRef} from '@lexical/react/useLexicalFocusTrapRef';
import {type JSX, type ReactNode, useEffect, useRef} from 'react';

export default function Modal({onClose, children, title, closeOnClickOutside = false}: {
  children: ReactNode;
  closeOnClickOutside?: boolean;
  onClose: () => void;
  title: string;
}): JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  // Let Lexical own focus management, including restoration to the editor.
  // Two simultaneous focus traps (Arco + Lexical) fight over nested popups.
  const trap = useLexicalFocusTrapRef(true, 'firstFocusable', target =>
    Boolean(target.closest('.dropdown, .arco-trigger-popup, .arco-select-popup')),
  );
  useEffect(() => {
    const modal = container.current?.closest<HTMLElement>('.arco-modal');
    const stopTrap = modal ? trap(modal) : undefined;
    return typeof stopTrap === 'function' ? stopTrap : undefined;
  }, [trap]);

  return (
    <ArcoModal visible title={title} footer={null} onCancel={onClose}
      maskClosable={closeOnClickOutside} focusLock={false} autoFocus={false}
      alignCenter unmountOnExit className="editor-modal"
      style={{width: 'min(560px, calc(100vw - 32px))'}}>
      <div className="editor-modal-body" ref={container}>{children}</div>
    </ArcoModal>
  );
}
