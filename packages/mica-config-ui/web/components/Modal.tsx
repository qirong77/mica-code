import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import ArcoModal from '@arco-design/web-react/es/Modal';
import '../arco-settings.css';
import { appIcons } from '../icons.js';

const modalStack: { host: HTMLDivElement | null }[] = [];

export function Modal({
  title,
  onClose,
  children,
  wide = false,
  portal = false,
}: {
  title: ReactNode;
  onClose(): void;
  children: ReactNode;
  wide?: boolean;
  portal?: boolean;
}) {
  const CloseIcon = appIcons.close;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const hostRef = useRef<HTMLDivElement>(null);
  // Snapshot before portalled children mount: their Input/Button autoFocus can
  // already have run by the time this component's passive effect is installed.
  const previousFocusRef = useRef(typeof document === 'undefined' ? null : document.activeElement);

  useEffect(() => {
    const entry = { host: hostRef.current };
    const descendantIndex = modalStack.findIndex(
      (modal) => modal.host !== entry.host && entry.host?.contains(modal.host),
    );
    if (descendantIndex < 0) modalStack.push(entry);
    else modalStack.splice(descendantIndex, 0, entry);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== entry) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      }
    };
    window.addEventListener('keydown', closeOnEscape, true);
    return () => {
      window.removeEventListener('keydown', closeOnEscape, true);
      const wasTopmost = modalStack[modalStack.length - 1] === entry;
      modalStack.splice(modalStack.indexOf(entry), 1);
      const previousFocus = previousFocusRef.current;
      const remainingTop = modalStack[modalStack.length - 1];
      // Arco's FocusLock does not enable returnFocus. Only the top dialog may
      // restore its opener; removing a covered dialog must not steal focus.
      // Wait for the child FocusLock to unregister before focusing outside it.
      if (wasTopmost) {
        queueMicrotask(() => {
          if (
            modalStack[modalStack.length - 1] === remainingTop &&
            previousFocus instanceof HTMLElement &&
            previousFocus.isConnected
          ) {
            previousFocus.focus();
          }
        });
      }
    };
  }, [portal]);

  const content = (
    <div ref={hostRef} className={portal ? 'mica-config-ui is-embed modal-portal' : 'modal-anchor'}>
      <ArcoModal
        visible
        title={title}
        footer={null}
        className={`modal-card modal-arco${wide ? ' modal-card-wide' : ''}`}
        style={{ width: wide ? 880 : 680, maxWidth: 'calc(100% - 48px)' }}
        wrapClassName="modal-arco-backdrop"
        escToExit={false}
        // Arco's react-focus-lock respects an already focused child (including
        // Input autoFocus) and tracks React portals used by dropdowns/popovers.
        // A DOM-only Tab trap would incorrectly pull those popups back inside.
        focusLock
        autoFocus
        getPopupContainer={() => hostRef.current!}
        getChildrenPopupContainer={(node) => node.closest('.mica-config-ui') ?? node.parentElement ?? node}
        onCancel={onClose}
        closeIcon={
          <button type="button" className="modal-close" aria-label="关闭">
            <CloseIcon size={15} aria-hidden="true" />
          </button>
        }
        modalRender={(modal) => (
          <div className="modal-arco-content" data-mica-config-modal>
            {modal}
          </div>
        )}
      >
        <div className="modal-body">{children}</div>
      </ArcoModal>
    </div>
  );
  return portal ? createPortal(content, document.body) : content;
}
